import { describe, expect, it } from "vitest";

import { parseDotenv } from "../dotenv.js";
import { ConfigurationError } from "../errors.js";

describe("parseDotenv", () => {
  it("parses standard assignments, comments, exports, and quotes", () => {
    const parsed = parseDotenv(`
# comment
export APP_NAME = config-service
EMPTY=
SINGLE='literal $APP_NAME'
DOUBLE="hello $APP_NAME\\nnext"
HASH=value#part
COMMENT=value # ignored
`);

    expect(parsed).toEqual({
      APP_NAME: "config-service",
      COMMENT: "value",
      DOUBLE: "hello config-service\nnext",
      EMPTY: "",
      HASH: "value#part",
      SINGLE: "literal $APP_NAME",
    });
  });

  it("expands context, prior values, and shell-style defaults", () => {
    const parsed = parseDotenv(
      `HOST=localhost
URL=https://$HOST:$PORT
FIRST=\${MISSING:-fallback}
SECOND=\${EMPTY-default}
THIRD=\${EMPTY:-default}
`,
      { context: { EMPTY: "", PORT: "8080" } },
    );

    expect(parsed).toMatchObject({
      FIRST: "fallback",
      SECOND: "",
      THIRD: "default",
      URL: "https://localhost:8080",
    });
  });

  it("supports multiline quoted values and escaped variables", () => {
    const parsed = parseDotenv(`MULTILINE="first
second"
LITERAL=\\$NOT_EXPANDED
`);

    expect(parsed.MULTILINE).toBe("first\nsecond");
    expect(parsed.LITERAL).toBe("$NOT_EXPANDED");
  });

  it("never executes command substitutions", () => {
    const parsed = parseDotenv("VALUE=$(printf dangerous)\n");
    expect(parsed.VALUE).toBe("$(printf dangerous)");
  });

  it("reports structured syntax locations", () => {
    expect.assertions(4);
    try {
      parseDotenv("VALID=yes\nBROKEN", { source: "/service/.env" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).code).toBe("ENV_FILE_INVALID");
      expect((error as ConfigurationError).issues[0]?.path).toEqual([2, 7]);
      expect((error as ConfigurationError).issues[0]?.source).toBe("/service/.env");
    }
  });

  it("rejects byte-order marks", () => {
    expect(() => parseDotenv("\uFEFFKEY=value")).toThrow(ConfigurationError);
  });

  it("rejects invalid names and unterminated or trailing quoted content", () => {
    expect(() => parseDotenv("1INVALID=value")).toThrow(ConfigurationError);
    expect(() => parseDotenv('VALUE="unterminated')).toThrow(ConfigurationError);
    expect(() => parseDotenv('VALUE="closed" trailing')).toThrow(ConfigurationError);
  });

  it("handles double-quoted escapes and empty fallback inputs", () => {
    const parsed = parseDotenv(
      `QUOTED="tab\\tquote\\"slash\\\\unknown\\q"\nDEFAULT=\${MISSING-default}\nEMPTY=\${MISSING:-}\n`,
    );

    expect(parsed.QUOTED).toBe('tab\tquote"slash\\unknown\\q');
    expect(parsed.DEFAULT).toBe("default");
    expect(parsed.EMPTY).toBe("");
  });
});
