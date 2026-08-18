import * as z from "zod/v4/core";

import { type LoadedEnvironment, loadEnvironment } from "./environment";
import { ConfigurationError } from "./errors";
import { mergeResolvedValues, resolveEnvironmentReferences } from "./interpolate";
import { type ResolvedSource, resolveSources } from "./sources";
import type { ConfigMetadata, ConfigResult, DefineConfigOptions, EmptyEnvironment } from "./types";
import { cloneValue, deepFreeze, findUnsupportedConfigValue, resolveCwd } from "./utils";
import { validationError } from "./validation";

interface UnfrozenResult {
  readonly config: unknown;
  readonly env: unknown;
  readonly metadata: ConfigMetadata;
}

/**
 * Loads, merges, interpolates, validates, and freezes an application configuration.
 *
 * @remarks
 * Environment files are resolved before configuration sources. Asynchronous providers and Zod
 * refinements are supported. The function snapshots environment input and never mutates
 * `process.env`, supplied sources, defaults, or overrides.
 *
 * @param options - Environment, source, schema, and working-directory options.
 * @returns A promise containing deeply readonly configuration, environment, and diagnostic metadata.
 * @throws {@link ConfigurationError} when input, loading, interpolation, or validation fails.
 */
export function defineConfig<TConfigSchema extends z.$ZodType>(
  options: Omit<DefineConfigOptions<TConfigSchema>, "environment"> & {
    readonly environment?: undefined;
  },
): Promise<ConfigResult<z.output<TConfigSchema>, EmptyEnvironment>>;
export function defineConfig<
  TConfigSchema extends z.$ZodType,
  TEnvironmentSchema extends z.$ZodType,
>(
  options: DefineConfigOptions<TConfigSchema, TEnvironmentSchema> & {
    readonly environment: NonNullable<
      DefineConfigOptions<TConfigSchema, TEnvironmentSchema>["environment"]
    >;
  },
): Promise<ConfigResult<z.output<TConfigSchema>, z.output<TEnvironmentSchema>>>;
export function defineConfig<
  TConfigSchema extends z.$ZodType,
  TEnvironmentSchema extends z.$ZodType,
>(
  options: DefineConfigOptions<TConfigSchema, TEnvironmentSchema>,
): Promise<ConfigResult<z.output<TConfigSchema>, EmptyEnvironment | z.output<TEnvironmentSchema>>>;
export async function defineConfig(
  options: DefineConfigOptions<z.$ZodType, z.$ZodType>,
): Promise<ConfigResult<unknown, unknown>> {
  const cwd = resolveCwd(options.cwd);
  const environment = await loadEnvironment(options.environment, cwd);
  const sources = await resolveSources(options.sources ?? [], cwd);
  return freezeResult(await finalizeConfig(options.schema, options.defaults, sources, environment));
}

/**
 * Completes the async pipeline after all I/O has finished and deliberately uses Zod's async parser
 * so schemas with asynchronous refinements or transforms work without a separate code path.
 */
async function finalizeConfig(
  schema: z.$ZodType,
  defaults: unknown,
  sources: readonly ResolvedSource[],
  environment: LoadedEnvironment,
): Promise<UnfrozenResult> {
  const prepared = prepareConfig(defaults, sources, environment);
  const validation = await z.safeParseAsync(schema, prepared.value);
  if (!validation.success) throw validationError("CONFIG_INVALID", validation.error);
  return buildResult(validation.data, environment, sources, prepared.provenance);
}

/**
 * Merges source inputs and resolves environment references before schema validation so missing
 * references can be reported together with their original configuration paths.
 */
function prepareConfig(
  defaults: unknown,
  sources: readonly ResolvedSource[],
  environment: LoadedEnvironment,
) {
  const merged = mergeResolvedValues(defaults, sources);
  const resolved = resolveEnvironmentReferences(
    merged.value,
    environment.value,
    environment.redacted,
  );
  if (resolved.issues.length > 0) {
    throw new ConfigurationError("ENV_REFERENCE_MISSING", resolved.issues);
  }
  return { provenance: merged.provenance, value: resolved.value };
}

/**
 * Verifies that schema output remains configuration-safe and assembles value-free operational
 * metadata. Schema transforms are checked here because they can introduce unsupported instances.
 */
function buildResult(
  config: unknown,
  environment: LoadedEnvironment,
  sources: readonly ResolvedSource[],
  provenance: Readonly<Record<string, string>>,
): UnfrozenResult {
  const unsupported = findUnsupportedConfigValue(config);
  if (unsupported) {
    throw new ConfigurationError("CONFIG_INVALID", [
      { code: "CONFIG_INVALID", message: unsupported.message, path: unsupported.path },
    ]);
  }
  return {
    config,
    env: environment.value,
    metadata: {
      environment: environment.metadata,
      provenance,
      sources: sources.map((source) => source.metadata),
    },
  };
}

/**
 * Clones before freezing so the library never freezes objects owned by a schema, provider, or caller.
 */
function freezeResult(result: UnfrozenResult): ConfigResult<unknown, unknown> {
  return Object.freeze({
    config: deepFreeze(cloneValue(result.config)),
    env: deepFreeze(cloneValue(result.env)),
    metadata: deepFreeze(cloneValue(result.metadata)),
  });
}
