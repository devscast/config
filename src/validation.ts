import type * as z from "zod/v4/core";

import { ConfigurationError, type ConfigurationIssue } from "./errors.js";

/** Converts aggregated Zod issues into the package's stable, optionally redacted error model. */
export function validationError(
  code: "CONFIG_INVALID" | "ENV_INVALID",
  error: z.$ZodError,
  redacted: ReadonlySet<string> = new Set(),
): ConfigurationError {
  const issues: ConfigurationIssue[] = error.issues.map((issue) => {
    const path = issue.path.map((segment) =>
      typeof segment === "symbol" ? String(segment) : segment,
    );
    const key = typeof path[0] === "string" ? path[0] : undefined;
    const isRedacted = key !== undefined && redacted.has(key);
    return {
      code,
      key,
      message: isRedacted ? "Invalid redacted environment value." : issue.message,
      path,
      redacted: isRedacted || undefined,
    };
  });
  return new ConfigurationError(code, issues);
}
