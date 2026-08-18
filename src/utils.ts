import path from "node:path";

import type { EnvironmentInput } from "./dotenv.js";
import type { ConfigObject, DeepReadonly } from "./types.js";

export interface UnsupportedConfigValue {
  readonly message: string;
  readonly path: readonly (number | string)[];
}

/** Resolves a configured working directory, defaulting to the current process directory. */
export function resolveCwd(cwd: string | undefined): string {
  return cwd === undefined ? process.cwd() : path.resolve(cwd);
}

/** Resolves a file path against the configuration working directory. */
export function resolvePath(filepath: string, cwd: string): string {
  return path.isAbsolute(filepath) ? filepath : path.resolve(cwd, filepath);
}

/** Returns whether an unknown error represents a missing filesystem entry. */
export function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Narrows values to plain objects with either the default or a null prototype. */
export function isPlainObject(value: unknown): value is ConfigObject {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/**
 * Finds the first cyclic, callable, symbolic, or mutable class-instance value in a configuration tree.
 */
export function findUnsupportedConfigValue(
  value: unknown,
  currentPath: readonly (number | string)[] = [],
  ancestors: WeakSet<object> = new WeakSet(),
): UnsupportedConfigValue | null {
  if (typeof value === "function" || typeof value === "symbol") {
    return { message: `Unsupported ${typeof value} configuration value.`, path: currentPath };
  }
  if (value === null || typeof value !== "object") return null;
  if (ancestors.has(value)) {
    return { message: "Cyclic configuration values are not supported.", path: currentPath };
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return {
      message: `Unsupported ${value.constructor?.name ?? "object"} configuration value.`,
      path: currentPath,
    };
  }

  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    const segment = Array.isArray(value) ? Number(key) : key;
    const problem = findUnsupportedConfigValue(child, [...currentPath, segment], ancestors);
    if (problem) return problem;
  }
  ancestors.delete(value);
  return null;
}

/** Safely clones a raw environment record without invoking prototype setters. */
export function cloneEnvironment(input: EnvironmentInput): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(input)) setOwn(output, key, value);
  return output;
}

/** Creates a new environment record by applying inputs from left to right. */
export function mergeEnvironment(
  ...inputs: readonly EnvironmentInput[]
): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  for (const input of inputs) assignEnvironment(output, input);
  return output;
}

/** Copies raw environment entries into a target without invoking prototype setters. */
export function assignEnvironment(
  target: Record<string, string | undefined>,
  input: EnvironmentInput,
): void {
  for (const [key, value] of Object.entries(input)) setOwn(target, key, value);
}

/** Deeply merges two plain configuration objects, replacing arrays and scalar values. */
export function mergeValues(base: ConfigObject, next: ConfigObject): ConfigObject {
  const result: ConfigObject = cloneValue(base);
  for (const [key, nextValue] of Object.entries(next)) {
    const baseValue = result[key];
    setOwn(
      result,
      key,
      isPlainObject(baseValue) && isPlainObject(nextValue)
        ? mergeValues(baseValue, nextValue)
        : cloneValue(nextValue),
    );
  }
  return result;
}

/** Recursively clones supported configuration arrays and plain objects. */
export function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (isPlainObject(value)) {
    const output: ConfigObject = {};
    for (const [key, child] of Object.entries(value)) setOwn(output, key, cloneValue(child));
    return output as T;
  }
  return value;
}

/** Recursively freezes a validated configuration-safe value. */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Defines an enumerable own property without triggering special prototype accessors. */
export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
