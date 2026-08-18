import { readFile } from "node:fs/promises";

import * as YAML from "yaml";

import { ConfigurationError } from "./errors.js";
import type {
  ConfigObject,
  ConfigSource,
  FileSourceOptions,
  InlineSource,
  JsonSource,
  ProviderSource,
  SourceMetadata,
  YamlSource,
} from "./types.js";
import {
  cloneValue,
  findUnsupportedConfigValue,
  isMissingFile,
  isPlainObject,
  resolvePath,
} from "./utils.js";

export interface ResolvedSource {
  readonly metadata: SourceMetadata;
  readonly value: ConfigObject | null;
}

/**
 * Creates an explicit JSON file source.
 *
 * @param filepath - Absolute path or path relative to the configuration working directory.
 * @param options - Optional source name and missing-file behavior.
 */
export function jsonFile(filepath: string, options: FileSourceOptions = {}): JsonSource {
  return { ...options, path: filepath, type: "json" };
}

/**
 * Creates an explicit YAML file source.
 *
 * @param filepath - Absolute path or path relative to the configuration working directory.
 * @param options - Optional source name and missing-file behavior.
 */
export function yamlFile(filepath: string, options: FileSourceOptions = {}): YamlSource {
  return { ...options, path: filepath, type: "yaml" };
}

/**
 * Creates an inline source from a plain configuration object.
 *
 * @param value - Configuration values to merge at this source's position.
 * @param options - Optional source name used by provenance and diagnostics.
 */
export function inline(
  value: ConfigObject,
  options: { readonly name?: string } = {},
): InlineSource {
  return { ...options, type: "inline", value };
}

/**
 * Creates a provider source for remotely or locally produced configuration.
 *
 * @remarks Providers are resolved concurrently and their results are merged in declaration order.
 * @param name - Stable, non-secret provider name used by metadata and diagnostics.
 * @param load - Function returning a plain configuration object or promise-like value.
 */
export function provider(name: string, load: ProviderSource["load"]): ProviderSource {
  return { load, name, type: "provider" };
}

/** Resolves asynchronous sources concurrently while preserving their declared result order. */
export async function resolveSources(
  sources: readonly ConfigSource[],
  cwd: string,
): Promise<ResolvedSource[]> {
  return Promise.all(sources.map((source, index) => resolveSource(source, cwd, index)));
}

/** Dispatches a discriminated async source without relying on file extensions or object heuristics. */
async function resolveSource(
  source: ConfigSource,
  cwd: string,
  index: number,
): Promise<ResolvedSource> {
  switch (source.type) {
    case "inline":
      return resolveInlineSource(source, index);
    case "json":
    case "yaml":
      return resolveFileSourceAsync(source, cwd);
    case "provider":
      return resolveProviderValue(source.name, await safelyLoadProvider(source.name, source.load));
  }
}

/** Validates and detaches inline data; the index supplies a deterministic fallback provenance name. */
function resolveInlineSource(source: InlineSource, index: number): ResolvedSource {
  const name = source.name ?? `inline:${index + 1}`;
  if (!isPlainObject(source.value)) {
    throw sourceError("SOURCE_INVALID", "Inline source must be a plain object.", name);
  }
  assertSupportedSourceValue(source.value, name);
  return {
    metadata: metadata("inline", name, undefined, false, true),
    value: cloneValue(source.value),
  };
}

/** Reads a JSON or YAML source asynchronously, centralizing optional-file and sanitized error behavior. */
async function resolveFileSourceAsync(
  source: JsonSource | YamlSource,
  cwd: string,
): Promise<ResolvedSource> {
  const filepath = resolvePath(source.path, cwd);
  try {
    return parseConfigFile(source, filepath, await readFile(filepath, "utf8"));
  } catch (error) {
    return handleConfigFileError(source, filepath, error);
  }
}

/**
 * Parses according to the explicit source discriminator and rejects non-object or mutable output.
 * Parser causes are intentionally omitted because YAML errors can embed secret source fragments.
 */
function parseConfigFile(
  source: JsonSource | YamlSource,
  filepath: string,
  contents: string,
): ResolvedSource {
  let parsed: unknown;
  try {
    parsed = source.type === "json" ? JSON.parse(contents) : YAML.parse(contents);
  } catch {
    throw new ConfigurationError("SOURCE_INVALID", [
      {
        code: "SOURCE_INVALID",
        message: `Unable to parse ${source.type.toUpperCase()} source.`,
        source: filepath,
      },
    ]);
  }
  if (!isPlainObject(parsed)) {
    throw sourceError("SOURCE_INVALID", "Configuration source must produce an object.", filepath);
  }
  assertSupportedSourceValue(parsed, filepath);
  return {
    metadata: metadata(
      source.type,
      source.name ?? filepath,
      filepath,
      source.optional ?? false,
      true,
    ),
    value: cloneValue(parsed),
  };
}

/**
 * Distinguishes an allowed missing optional file from actionable read failures while preserving a
 * stable error code for service startup handling.
 */
function handleConfigFileError(
  source: JsonSource | YamlSource,
  filepath: string,
  error: unknown,
): ResolvedSource {
  if (error instanceof ConfigurationError) throw error;
  if (isMissingFile(error) && source.optional) {
    return {
      metadata: metadata(source.type, source.name ?? filepath, filepath, true, false),
      value: null,
    };
  }
  const code = isMissingFile(error) ? "SOURCE_MISSING" : "SOURCE_INVALID";
  throw new ConfigurationError(
    code,
    [
      {
        code,
        message: isMissingFile(error)
          ? "Configuration source was not found."
          : "Configuration source could not be read.",
        source: filepath,
      },
    ],
    { cause: error },
  );
}

/** Executes a provider behind a sanitized error boundary so provider exceptions cannot leak secrets. */
async function safelyLoadProvider(
  name: string,
  load: ProviderSource["load"],
): Promise<ConfigObject> {
  try {
    return await load();
  } catch {
    throw providerError(name);
  }
}

/** Validates, detaches, and describes a successfully returned provider value. */
function resolveProviderValue(name: string, value: ConfigObject): ResolvedSource {
  if (!isPlainObject(value)) {
    throw sourceError("SOURCE_INVALID", "Provider must produce a plain object.", name);
  }
  assertSupportedSourceValue(value, name);
  return {
    metadata: metadata("provider", name, undefined, false, true),
    value: cloneValue(value),
  };
}

/** Creates a value-free provider failure; the original cause is deliberately not retained. */
function providerError(name: string): ConfigurationError {
  return new ConfigurationError("SOURCE_UNAVAILABLE", [
    {
      code: "SOURCE_UNAVAILABLE",
      message: "Configuration provider failed to load.",
      source: name,
    },
  ]);
}

/** Creates a single structured source issue with its human-readable source identifier. */
function sourceError(
  code: "SOURCE_INVALID" | "SOURCE_MISSING",
  message: string,
  source: string,
): ConfigurationError {
  return new ConfigurationError(code, [{ code, message, source }]);
}

/** Rejects cycles and mutable instances before cloning or recursively merging source data. */
function assertSupportedSourceValue(value: ConfigObject, source: string): void {
  const unsupported = findUnsupportedConfigValue(value);
  if (unsupported) {
    throw new ConfigurationError("SOURCE_INVALID", [
      {
        code: "SOURCE_INVALID",
        message: unsupported.message,
        path: unsupported.path,
        source,
      },
    ]);
  }
}

/** Builds metadata without copying source contents or other potentially sensitive values. */
function metadata(
  type: SourceMetadata["type"],
  name: string,
  filepath: string | undefined,
  optional: boolean,
  loaded: boolean,
): SourceMetadata {
  return { loaded, name, optional, ...(filepath ? { path: filepath } : {}), type };
}
