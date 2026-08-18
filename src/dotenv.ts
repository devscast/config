import { ConfigurationError } from "./errors";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const EXPANSION = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-)([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const ESCAPED_DOLLAR = "\u0000CONFIG_TS_DOLLAR\u0000";

export type EnvironmentInput = Readonly<Record<string, string | undefined>>;

export interface ParseDotenvOptions {
  readonly context?: EnvironmentInput;
  readonly source?: string;
}

/**
 * Parses dotenv text into an isolated string record.
 *
 * @remarks
 * Supports quoted and multiline values plus standard variable/default expansion. Shell command
 * substitutions are preserved as literal text and are never executed. Neither `process.env` nor the
 * optional expansion context is mutated.
 *
 * @param input - UTF-8 dotenv contents.
 * @param options - Expansion context and source label used by diagnostics.
 * @returns A new record containing the parsed variables.
 * @throws {@link ConfigurationError} with `ENV_FILE_INVALID` when the input is malformed.
 */
export function parseDotenv(
  input: string,
  options: ParseDotenvOptions = {},
): Record<string, string> {
  const source = options.source ?? ".env";
  if (input.charCodeAt(0) === 0xfeff) {
    throw syntaxError(source, 1, 1, "Byte-order marks are not supported.");
  }

  const parser = new DotenvParser(input.replace(/\r\n?/g, "\n"), source, options.context ?? {});
  return parser.parse();
}

/** Stateful single-pass parser scoped to one input string; an instance is never reused. */
class DotenvParser {
  private cursor = 0;
  private readonly values: Record<string, string> = {};

  /** Captures immutable input/context while keeping cursor and parsed values instance-local. */
  constructor(
    private readonly input: string,
    private readonly source: string,
    private readonly context: EnvironmentInput,
  ) {}

  /** Parses assignments in file order so later values may expand variables defined earlier. */
  parse(): Record<string, string> {
    while (this.cursor < this.input.length) {
      this.skipBlankLinesAndComments();
      if (this.cursor >= this.input.length) break;
      this.parseAssignment();
    }
    return cloneRecord(this.values);
  }

  /** Parses one optional `export` declaration and stores its resolved value. */
  private parseAssignment(): void {
    const assignmentStart = this.cursor;
    if (this.input.startsWith("export", this.cursor)) {
      const afterExport = this.input[this.cursor + 6];
      if (afterExport === " " || afterExport === "\t") {
        this.cursor += 6;
        this.skipHorizontalWhitespace();
      }
    }

    const match = this.input.slice(this.cursor).match(VARIABLE_NAME);
    if (!match) this.fail("Invalid environment variable name.", assignmentStart);
    const name = match[0];
    this.cursor += name.length;
    this.skipHorizontalWhitespace();

    if (this.input[this.cursor] !== "=") {
      this.fail(`Missing '=' after ${name}.`);
    }
    this.cursor++;
    this.skipHorizontalWhitespace();

    const quote = this.input[this.cursor];
    let value: string;
    if (quote === "'" || quote === '"') {
      value = this.readQuotedValue(quote);
      this.skipHorizontalWhitespace();
      if (this.input[this.cursor] === "#") this.skipComment();
      if (this.cursor < this.input.length && this.input[this.cursor] !== "\n") {
        this.fail("Unexpected content after quoted value.");
      }
    } else {
      value = this.readBareValue();
    }

    this.values[name] = quote === "'" ? value : this.expand(value);
    if (this.input[this.cursor] === "\n") this.cursor++;
  }

  /**
   * Reads a possibly multiline quoted value. Single quotes remain literal; double-quote escapes are
   * decoded here and variable expansion is applied by the assignment parser.
   */
  private readQuotedValue(quote: "'" | '"'): string {
    this.cursor++;
    const output: string[] = [];

    while (this.cursor < this.input.length) {
      const character = this.input[this.cursor]!;
      if (character === quote) {
        this.cursor++;
        return output.join("");
      }

      if (quote === '"' && character === "\\") {
        const next = this.input[this.cursor + 1];
        if (next === undefined) this.fail("Missing closing quote.");
        const escaped: Record<string, string> = {
          "\\": "\\",
          '"': '"',
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (next === "$") {
          output.push(ESCAPED_DOLLAR);
        } else {
          output.push(escaped[next] ?? `\\${next}`);
        }
        this.cursor += 2;
        continue;
      }

      output.push(character);
      this.cursor++;
    }

    this.fail("Missing closing quote.");
  }

  /** Reads an unquoted line, treating `#` as a comment only when it begins a whitespace-delimited token. */
  private readBareValue(): string {
    const output: string[] = [];
    let previous = "";

    while (this.cursor < this.input.length && this.input[this.cursor] !== "\n") {
      const character = this.input[this.cursor]!;
      if (character === "#" && (output.length === 0 || /\s/.test(previous))) {
        this.skipComment();
        break;
      }
      if (character === "\\" && this.input[this.cursor + 1] === "$") {
        output.push(ESCAPED_DOLLAR);
        previous = "$";
        this.cursor += 2;
        continue;
      }
      output.push(character);
      previous = character;
      this.cursor++;
    }

    return output.join("").trimEnd();
  }

  /**
   * Expands variables from prior assignments before the caller-provided context. Missing variables
   * become empty strings unless a shell-style default is present; `$()` is intentionally untouched.
   */
  private expand(value: string): string {
    return value
      .replace(
        EXPANSION,
        (_match, bracedName?: string, operator?: string, fallback?: string, bareName?: string) => {
          const name = bracedName ?? bareName;
          if (!name) return "";
          const resolved = this.values[name] ?? this.context[name];
          const shouldUseFallback =
            operator === ":-" ? resolved === undefined || resolved === "" : resolved === undefined;
          if (operator && shouldUseFallback) return this.expand(fallback ?? "");
          return resolved ?? "";
        },
      )
      .replaceAll(ESCAPED_DOLLAR, "$");
  }

  /** Advances to the next declaration while accepting whitespace-only and comment-only lines. */
  private skipBlankLinesAndComments(): void {
    while (this.cursor < this.input.length) {
      this.skipHorizontalWhitespace();
      if (this.input[this.cursor] === "#") this.skipComment();
      if (this.input[this.cursor] === "\n") {
        this.cursor++;
        continue;
      }
      break;
    }
  }

  /** Consumes comment text but leaves the newline for the main parser loop. */
  private skipComment(): void {
    while (this.cursor < this.input.length && this.input[this.cursor] !== "\n") this.cursor++;
  }

  /** Skips spaces and tabs without crossing a declaration boundary. */
  private skipHorizontalWhitespace(): void {
    while (this.input[this.cursor] === " " || this.input[this.cursor] === "\t") this.cursor++;
  }

  /** Converts the current absolute cursor into one-based line and column diagnostics. */
  private fail(message: string, cursor = this.cursor): never {
    const before = this.input.slice(0, cursor);
    const line = (before.match(/\n/g)?.length ?? 0) + 1;
    const lastNewline = before.lastIndexOf("\n");
    const column = cursor - lastNewline;
    throw syntaxError(this.source, line, column, message);
  }
}

/** Creates the package error shape used for all dotenv syntax failures. */
function syntaxError(
  source: string,
  line: number,
  column: number,
  message: string,
): ConfigurationError {
  return new ConfigurationError("ENV_FILE_INVALID", [
    {
      code: "ENV_FILE_INVALID",
      message,
      path: [line, column],
      source,
    },
  ]);
}

/** Returns a detached record so parser-owned state never escapes to callers. */
function cloneRecord(input: Readonly<Record<string, string>>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) setOwn(output, key, value);
  return output;
}

/** Defines dotenv keys safely, including names that overlap prototype accessors. */
function setOwn(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
