import { ConfigurationError, type ConfigurationIssue } from "./errors";
import type { ResolvedSource } from "./sources";
import type { ConfigObject } from "./types";
import {
  cloneValue,
  findUnsupportedConfigValue,
  isPlainObject,
  mergeValues,
  setOwn,
} from "./utils";

const ENV_REFERENCE_ANY = /%env\(([A-Za-z_][A-Za-z0-9_]*)\)%/g;
const ENV_REFERENCE_FULL = /^%env\(([A-Za-z_][A-Za-z0-9_]*)\)%$/;

export interface MergedConfig {
  readonly provenance: Readonly<Record<string, string>>;
  readonly value: ConfigObject;
}

export interface ResolvedReferences {
  readonly issues: ConfigurationIssue[];
  readonly value: unknown;
}

/**
 * Merges defaults and loaded sources while recording the winning source for each input leaf path.
 */
export function mergeResolvedValues(
  defaults: unknown,
  sources: readonly ResolvedSource[],
): MergedConfig {
  let value: ConfigObject = {};
  const provenance: Record<string, string> = {};

  if (defaults !== undefined) {
    if (!isPlainObject(defaults)) {
      throw new ConfigurationError("INVALID_OPTIONS", [
        { code: "INVALID_OPTIONS", message: "Defaults must be a plain object." },
      ]);
    }
    const unsupported = findUnsupportedConfigValue(defaults);
    if (unsupported) {
      throw new ConfigurationError("INVALID_OPTIONS", [
        {
          code: "INVALID_OPTIONS",
          message: unsupported.message,
          path: unsupported.path,
          source: "defaults",
        },
      ]);
    }
    value = mergeValues(value, defaults);
    recordProvenance(defaults, "defaults", provenance);
  }

  for (const source of sources) {
    if (source.value === null) continue;
    value = mergeValues(value, source.value);
    recordProvenance(source.value, source.metadata.name, provenance);
  }
  return { provenance, value };
}

/**
 * Recursively replaces `%env(NAME)%` references and aggregates every missing reference.
 *
 * @remarks A whole-value reference preserves the validated environment value's native type, while
 * embedded references are converted to strings.
 */
export function resolveEnvironmentReferences(
  value: unknown,
  environment: ConfigObject,
  redacted: ReadonlySet<string>,
  currentPath: readonly (number | string)[] = [],
  issues: ConfigurationIssue[] = [],
): ResolvedReferences {
  if (typeof value === "string") {
    const full = value.match(ENV_REFERENCE_FULL);
    if (full) {
      const name = full[1]!;
      if (!hasEnvironmentValue(environment, name)) {
        issues.push(missingReferenceIssue(name, currentPath, redacted));
        return { issues, value };
      }
      return { issues, value: cloneValue(environment[name]) };
    }

    const resolved = value.replace(ENV_REFERENCE_ANY, (match, name: string) => {
      if (!hasEnvironmentValue(environment, name)) {
        issues.push(missingReferenceIssue(name, currentPath, redacted));
        return match;
      }
      return String(environment[name]);
    });
    return { issues, value: resolved };
  }

  if (Array.isArray(value)) {
    return {
      issues,
      value: value.map(
        (item, index) =>
          resolveEnvironmentReferences(item, environment, redacted, [...currentPath, index], issues)
            .value,
      ),
    };
  }

  if (isPlainObject(value)) {
    const output: ConfigObject = {};
    for (const [key, child] of Object.entries(value)) {
      const resolved = resolveEnvironmentReferences(
        child,
        environment,
        redacted,
        [...currentPath, key],
        issues,
      );
      setOwn(output, key, resolved.value);
    }
    return { issues, value: output };
  }

  return { issues, value };
}

/** Checks own-property presence so prototype members can never satisfy an environment reference. */
function hasEnvironmentValue(environment: ConfigObject, name: string): boolean {
  return Object.hasOwn(environment, name) && environment[name] !== undefined;
}

/** Produces a path-aware missing-reference issue while suppressing redacted key details. */
function missingReferenceIssue(
  key: string,
  path: readonly (number | string)[],
  redacted: ReadonlySet<string>,
): ConfigurationIssue {
  const isRedacted = redacted.has(key);
  return {
    code: "ENV_REFERENCE_MISSING",
    key,
    message: isRedacted
      ? "A required redacted environment value is unavailable."
      : `Environment value ${key} is unavailable.`,
    path,
    redacted: isRedacted || undefined,
  };
}

/**
 * Records leaf-level winning sources. Objects recurse, while arrays and empty objects are treated as
 * atomic leaves because merge semantics replace them as complete values.
 */
function recordProvenance(
  value: ConfigObject,
  source: string,
  output: Record<string, string>,
  segments: readonly string[] = [],
): void {
  for (const [key, child] of Object.entries(value)) {
    const childSegments = [...segments, key];
    if (isPlainObject(child) && Object.keys(child).length > 0) {
      recordProvenance(child, source, output, childSegments);
    } else {
      setOwn(output, childSegments.join("."), source);
    }
  }
}
