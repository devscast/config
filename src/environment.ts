import { readFile } from "node:fs/promises";

import * as z from "zod/v4/core";

import { parseDotenv } from "./dotenv.js";
import { ConfigurationError } from "./errors.js";
import type {
  ConfigObject,
  EnvironmentFile,
  EnvironmentMetadata,
  EnvironmentOptions,
  SourceMetadata,
} from "./types.js";
import {
  assignEnvironment,
  cloneEnvironment,
  findUnsupportedConfigValue,
  isMissingFile,
  isPlainObject,
  mergeEnvironment,
  resolvePath,
} from "./utils.js";
import { validationError } from "./validation.js";

export interface LoadedEnvironment {
  readonly metadata: EnvironmentMetadata;
  readonly redacted: ReadonlySet<string>;
  readonly value: ConfigObject;
}

interface PreparedEnvironment {
  readonly processInput: Readonly<Record<string, string | undefined>>;
  readonly processEnabled: boolean;
  readonly redacted: ReadonlySet<string>;
}

interface EnvironmentFileRead {
  readonly contents: string | null;
  readonly metadata: SourceMetadata;
}

type NormalizedEnvironmentFile = Required<Pick<EnvironmentFile, "optional" | "path">> &
  EnvironmentFile;

/**
 * Loads environment files, applies precedence, and validates the isolated result asynchronously.
 *
 * @remarks Precedence is environment files, process input, then explicit overrides.
 */
export async function loadEnvironment(
  options: EnvironmentOptions<z.$ZodType> | undefined,
  cwd: string,
): Promise<LoadedEnvironment> {
  if (!options) return emptyEnvironment();
  const prepared = prepareEnvironment(options);
  const fileValues: Record<string, string> = {};
  const files: SourceMetadata[] = [];

  for (const file of options.files ?? []) {
    const normalized = normalizeEnvironmentFile(file, cwd);
    const loaded = await readEnvironmentFile(normalized);
    files.push(loaded.metadata);
    if (loaded.contents !== null) {
      assignEnvironment(
        fileValues,
        parseDotenv(loaded.contents, {
          context: mergeEnvironment(fileValues, prepared.processInput),
          source: normalized.path,
        }),
      );
    }
  }

  const raw = mergeEnvironment(fileValues, prepared.processInput, options.overrides ?? {});
  const validation = await z.safeParseAsync(options.schema, raw);
  if (!validation.success)
    throw validationError("ENV_INVALID", validation.error, prepared.redacted);
  return buildLoadedEnvironment(validation.data, files, prepared);
}

/** Synchronous counterpart to {@link loadEnvironment}. */
/**
 * Snapshots process input and redaction policy before any asynchronous boundary. This prevents later
 * `process.env` mutations from changing a configuration load already in progress.
 */
function prepareEnvironment(options: EnvironmentOptions<z.$ZodType>): PreparedEnvironment {
  const processEnabled = options.processEnv !== false;
  return {
    processEnabled,
    processInput: processEnabled ? cloneEnvironment(options.processEnv || process.env) : {},
    redacted: new Set(options.redact ?? []),
  };
}

/**
 * Enforces the environment schema's object contract, rejects mutable output introduced by transforms,
 * and records key names only—never values—in metadata.
 */
function buildLoadedEnvironment(
  value: unknown,
  files: SourceMetadata[],
  prepared: PreparedEnvironment,
): LoadedEnvironment {
  if (!isPlainObject(value)) {
    throw new ConfigurationError("INVALID_OPTIONS", [
      { code: "INVALID_OPTIONS", message: "Environment schema must produce an object." },
    ]);
  }
  const unsupported = findUnsupportedConfigValue(value);
  if (unsupported) {
    throw new ConfigurationError("ENV_INVALID", [
      { code: "ENV_INVALID", message: unsupported.message, path: unsupported.path },
    ]);
  }
  return {
    metadata: {
      files,
      keys: Object.keys(value).sort(),
      processEnv: prepared.processEnabled,
      redactedKeys: Array.from(prepared.redacted).sort(),
    },
    redacted: prepared.redacted,
    value,
  };
}

/** Supplies a consistently typed, side-effect-free result when no environment schema is configured. */
function emptyEnvironment(): LoadedEnvironment {
  return {
    metadata: { files: [], keys: [], processEnv: false, redactedKeys: [] },
    redacted: new Set(),
    value: {},
  };
}

/** Reads one dotenv source asynchronously and records whether an optional file was skipped. */
async function readEnvironmentFile(file: NormalizedEnvironmentFile): Promise<EnvironmentFileRead> {
  try {
    return {
      contents: await readFile(file.path, "utf8"),
      metadata: environmentMetadata(file, true),
    };
  } catch (error) {
    return handleEnvironmentReadError(file, error);
  }
}

/**
 * Treats only `ENOENT` on an optional file as a successful skip; permissions, directories, and other
 * I/O failures remain actionable startup errors.
 */
function handleEnvironmentReadError(
  file: NormalizedEnvironmentFile,
  error: unknown,
): EnvironmentFileRead {
  if (isMissingFile(error) && file.optional) {
    return { contents: null, metadata: environmentMetadata(file, false) };
  }
  const code = isMissingFile(error) ? "ENV_FILE_MISSING" : "ENV_FILE_INVALID";
  throw new ConfigurationError(
    code,
    [
      {
        code,
        message: isMissingFile(error)
          ? "Environment file was not found."
          : "Environment file could not be read.",
        source: file.path,
      },
    ],
    { cause: error },
  );
}

/** Resolves shorthand file strings and normalizes optional behavior before any filesystem access. */
function normalizeEnvironmentFile(
  file: EnvironmentFile | string,
  cwd: string,
): NormalizedEnvironmentFile {
  const normalized = typeof file === "string" ? { path: file } : file;
  return {
    ...normalized,
    optional: normalized.optional ?? false,
    path: resolvePath(normalized.path, cwd),
  };
}

/** Creates value-free environment file metadata suitable for logging and diagnostics. */
function environmentMetadata(file: NormalizedEnvironmentFile, loaded: boolean): SourceMetadata {
  return {
    loaded,
    name: file.name ?? file.path,
    optional: file.optional,
    path: file.path,
    type: "environment",
  };
}
