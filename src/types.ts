import type * as z from "zod/v4/core";

import type { EnvironmentInput } from "./dotenv";

export type ConfigObject = Record<string, unknown>;
export type EmptyEnvironment = Record<string, never>;
export type MaybePromise<T> = PromiseLike<T> | T;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends Date | RegExp
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export interface FileSourceOptions {
  readonly name?: string;
  readonly optional?: boolean;
}

export interface JsonSource extends FileSourceOptions {
  readonly path: string;
  readonly type: "json";
}

export interface YamlSource extends FileSourceOptions {
  readonly path: string;
  readonly type: "yaml";
}

export interface InlineSource {
  readonly name?: string;
  readonly type: "inline";
  readonly value: ConfigObject;
}

export interface ProviderSource {
  readonly load: () => MaybePromise<ConfigObject>;
  readonly name: string;
  readonly type: "provider";
}

export type ConfigSource = InlineSource | JsonSource | ProviderSource | YamlSource;

export interface EnvironmentFile {
  readonly name?: string;
  readonly optional?: boolean;
  readonly path: string;
}

export interface EnvironmentOptions<TSchema extends z.$ZodType> {
  readonly files?: readonly (EnvironmentFile | string)[];
  readonly overrides?: EnvironmentInput;
  readonly processEnv?: EnvironmentInput | false;
  readonly redact?: readonly Extract<keyof z.output<TSchema>, string>[];
  readonly schema: TSchema;
}

interface BaseDefineConfigOptions<TConfigSchema extends z.$ZodType, TSource> {
  readonly cwd?: string;
  readonly defaults?: z.input<TConfigSchema>;
  readonly schema: TConfigSchema;
  readonly sources?: readonly TSource[];
}

export interface DefineConfigOptions<
  TConfigSchema extends z.$ZodType,
  TEnvironmentSchema extends z.$ZodType = z.$ZodType,
> extends BaseDefineConfigOptions<TConfigSchema, ConfigSource> {
  readonly environment?: EnvironmentOptions<TEnvironmentSchema>;
}

export interface SourceMetadata {
  readonly loaded: boolean;
  readonly name: string;
  readonly optional: boolean;
  readonly path?: string;
  readonly type: "environment" | ConfigSource["type"];
}

export interface EnvironmentMetadata {
  readonly files: readonly SourceMetadata[];
  readonly keys: readonly string[];
  readonly processEnv: boolean;
  readonly redactedKeys: readonly string[];
}

export interface ConfigMetadata {
  readonly environment: EnvironmentMetadata;
  readonly provenance: Readonly<Record<string, string>>;
  readonly sources: readonly SourceMetadata[];
}

export interface ConfigResult<TConfig, TEnvironment = EmptyEnvironment> {
  readonly config: DeepReadonly<TConfig>;
  readonly env: DeepReadonly<TEnvironment>;
  readonly metadata: ConfigMetadata;
}
