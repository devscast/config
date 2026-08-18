export type ConfigurationErrorCode =
  | "CONFIG_INVALID"
  | "ENV_FILE_INVALID"
  | "ENV_FILE_MISSING"
  | "ENV_INVALID"
  | "ENV_REFERENCE_MISSING"
  | "INVALID_OPTIONS"
  | "SOURCE_INVALID"
  | "SOURCE_MISSING"
  | "SOURCE_UNAVAILABLE";

export interface ConfigurationIssue {
  readonly code: ConfigurationErrorCode;
  readonly key?: string;
  readonly message: string;
  readonly path?: readonly (number | string)[];
  readonly redacted?: boolean;
  readonly source?: string;
}

export class ConfigurationError extends Error {
  readonly code: ConfigurationErrorCode;
  readonly issues: readonly ConfigurationIssue[];

  /** Builds a stable summary while freezing issues and their paths against later mutation. */
  constructor(
    code: ConfigurationErrorCode,
    issues: readonly ConfigurationIssue[],
    options?: ErrorOptions,
  ) {
    const normalized = issues.length > 0 ? issues : [{ code, message: "Configuration failed." }];
    const detail = normalized
      .map((issue) => {
        const location = issue.path?.length ? ` at ${formatPath(issue.path)}` : "";
        const source = issue.source ? ` (${issue.source})` : "";
        return `- [${issue.code}]${location}${source}: ${issue.message}`;
      })
      .join("\n");

    super(`Configuration failed with ${normalized.length} issue(s):\n${detail}`, options);
    this.name = "ConfigurationError";
    this.code = code;
    this.issues = Object.freeze(
      normalized.map((issue) =>
        Object.freeze({
          ...issue,
          ...(issue.path ? { path: Object.freeze([...issue.path]) } : {}),
        }),
      ),
    );
  }
}

/** Formats structured issue paths using familiar property and array-index notation. */
function formatPath(segments: readonly (number | string)[]): string {
  return segments
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join("");
}
