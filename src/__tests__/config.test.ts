import path from "node:path";

import { describe, expect, it } from "vitest";
import * as z from "zod";
import * as mini from "zod/mini";

import { defineConfig } from "../config.js";
import { ConfigurationError } from "../errors.js";
import { inline, jsonFile, provider, yamlFile } from "../sources.js";

const fixtures = path.resolve(__dirname, "fixtures");
const environmentFixtures = path.join(fixtures, "env");

const configurationSchema = z.object({
  database: z.object({
    host: z.string(),
    password: z.string(),
    port: z.number(),
    username: z.string(),
  }),
  features: z.array(z.string()),
});

describe("defineConfig", () => {
  it("loads explicit JSON, YAML, and inline sources with deterministic precedence", async () => {
    const result = await defineConfig({
      schema: configurationSchema,
      sources: [
        jsonFile("config.json", { name: "base" }),
        yamlFile("config.yaml", { name: "deployment" }),
        inline({ database: { password: "runtime-secret" } }, { name: "runtime" }),
      ],
      cwd: fixtures,
    });

    expect(result.config.database).toMatchObject({
      host: "localhost",
      password: "runtime-secret",
      port: 5432,
      username: "admin",
    });
    expect(result.metadata.provenance["database.host"]).toBe("deployment");
    expect(result.metadata.provenance["database.password"]).toBe("runtime");
    expect(result.metadata.sources.map((source) => source.type)).toEqual([
      "json",
      "yaml",
      "inline",
    ]);
  });

  it("returns deeply immutable configuration, environment, and metadata", async () => {
    const result = await defineConfig({
      schema: z.object({ nested: z.object({ enabled: z.boolean() }) }),
      sources: [inline({ nested: { enabled: true } })],
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(Object.isFrozen(result.config.nested)).toBe(true);
    expect(Object.isFrozen(result.metadata.sources)).toBe(true);
  });

  it("records skipped optional files", async () => {
    const result = await defineConfig({
      defaults: { key: "default" },
      schema: z.object({ key: z.string() }),
      sources: [
        jsonFile("missing.json", { optional: true }),
        inline({ key: "inline" }, { name: "override" }),
      ],
      cwd: fixtures,
    });

    expect(result.config.key).toBe("inline");
    expect(result.metadata.sources[0]).toMatchObject({ loaded: false, optional: true });
  });

  it("supports providers returning promises or immediate values", async () => {
    const asyncResult = await defineConfig({
      schema: z.object({ region: z.string() }),
      sources: [provider("secret-manager", async () => ({ region: "af-south-1" }))],
    });
    const immediateResult = await defineConfig({
      schema: z.object({ region: z.string() }),
      sources: [provider("local-provider", () => ({ region: "local" }))],
    });

    expect(asyncResult.config.region).toBe("af-south-1");
    expect(immediateResult.config.region).toBe("local");
  });

  it("wraps provider failures without exposing their message", async () => {
    await expect(
      defineConfig({
        schema: z.object({ value: z.string() }),
        sources: [
          provider("vault", () => {
            throw new Error("secret-value-was-here");
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });

    try {
      await defineConfig({
        schema: z.object({ value: z.string() }),
        sources: [provider("vault", () => Promise.reject(new Error("secret-value-was-here")))],
      });
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-value-was-here");
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it("uses an environment schema as the typed source of truth", async () => {
    const original = process.env.DB_HOST;
    process.env.DB_HOST = "must-not-be-read";

    const environmentSchema = z.object({
      API_HOST: z.string(),
      APP_ENV: z.enum(["dev", "prod", "test"]),
      DB_HOST: z.string(),
      DB_PASSWORD: z.string(),
      DB_PORT: z.coerce.number().int(),
      DB_USER: z.string(),
      FEATURE_FLAGS: z.string().transform((value) => value.split(",")),
    });

    try {
      const result = await defineConfig({
        environment: {
          files: ["env/.env", "env/.env.local", "env/.env.prod", "env/.env.prod.local"],
          processEnv: false,
          redact: ["DB_PASSWORD"],
          schema: environmentSchema,
        },
        schema: z.object({
          database: z.object({
            host: z.string(),
            password: z.string(),
            port: z.number(),
            username: z.string(),
          }),
          features: z.array(z.string()),
          services: z.object({ url: z.url() }),
        }),
        sources: [
          yamlFile("config.env.yaml"),
          inline({
            database: { port: "%env(DB_PORT)%" },
            features: "%env(FEATURE_FLAGS)%",
          }),
        ],
        cwd: fixtures,
      });

      expect(result.env.DB_PORT).toBe(7777);
      expect(result.env.FEATURE_FLAGS).toEqual(["one", "two", "local"]);
      expect(result.config.database.host).toBe("from-env-prod-local");
      expect(result.config.database.port).toBe(7777);
      expect(result.config.services.url).toBe("https://prod-local-api.internal/v1");
      expect(result.metadata.environment.redactedKeys).toEqual(["DB_PASSWORD"]);
      expect(process.env.DB_HOST).toBe("must-not-be-read");
    } finally {
      if (original === undefined) delete process.env.DB_HOST;
      else process.env.DB_HOST = original;
    }
  });

  it("applies file, process, and explicit override precedence without mutation", async () => {
    const processInput = { VALUE: "process" };
    const result = await defineConfig({
      environment: {
        files: [path.join(environmentFixtures, ".env")],
        overrides: { VALUE: "override" },
        processEnv: processInput,
        schema: z.object({ VALUE: z.string() }),
      },
      schema: z.object({ value: z.string() }),
      sources: [inline({ value: "%env(VALUE)%" })],
    });

    expect(result.env.VALUE).toBe("override");
    expect(processInput.VALUE).toBe("process");
  });

  it("loads and validates environment files asynchronously", async () => {
    const result = await defineConfig({
      environment: {
        files: ["env/.env", { path: "env/missing.env", optional: true }],
        processEnv: false,
        schema: z.object({
          APP_ENV: z.string(),
          DB_PORT: z.coerce.number(),
        }),
      },
      schema: z.object({ environment: z.string(), port: z.number() }),
      sources: [inline({ environment: "%env(APP_ENV)%", port: "%env(DB_PORT)%" })],
      cwd: fixtures,
    });

    expect(result.env.DB_PORT).toBe(7777);
    expect(result.config).toEqual({ environment: "prod", port: 7777 });
    expect(result.metadata.environment.files[1]).toMatchObject({ loaded: false, optional: true });
  });

  it("reports environment file read failures with stable codes", async () => {
    await expect(
      defineConfig({
        environment: {
          files: ["env/missing.env"],
          processEnv: false,
          schema: z.object({}),
        },
        schema: z.object({}),
        cwd: fixtures,
      }),
    ).rejects.toMatchObject({ code: "ENV_FILE_MISSING" });

    await expect(
      defineConfig({
        environment: {
          files: ["env"],
          processEnv: false,
          schema: z.object({}),
        },
        schema: z.object({}),
        cwd: fixtures,
      }),
    ).rejects.toMatchObject({ code: "ENV_FILE_INVALID" });
  });

  it("aggregates environment validation issues and redacts secret diagnostics", async () => {
    expect.assertions(5);
    try {
      await defineConfig({
        environment: {
          processEnv: false,
          overrides: { API_TOKEN: "visible-secret" },
          redact: ["API_TOKEN"],
          schema: z.object({
            API_TOKEN: z.string().min(50),
            DATABASE_URL: z.url(),
          }),
        },
        schema: z.object({}),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).code).toBe("ENV_INVALID");
      expect((error as ConfigurationError).issues).toHaveLength(2);
      expect((error as Error).message).not.toContain("visible-secret");
      expect((error as ConfigurationError).issues[0]?.redacted).toBe(true);
    }
  });

  it("aggregates missing environment references with configuration paths", async () => {
    expect.assertions(3);
    try {
      await defineConfig({
        schema: z.object({ first: z.string(), nested: z.object({ second: z.string() }) }),
        sources: [inline({ first: "%env(FIRST)%", nested: { second: "%env(SECOND)%" } })],
      });
    } catch (error) {
      expect((error as ConfigurationError).code).toBe("ENV_REFERENCE_MISSING");
      expect((error as ConfigurationError).issues).toHaveLength(2);
      expect((error as ConfigurationError).issues.map((issue) => issue.path)).toEqual([
        ["first"],
        ["nested", "second"],
      ]);
    }
  });

  it("supports Zod Mini schemas", async () => {
    const result = await defineConfig({
      environment: {
        overrides: { VALUE: "mini" },
        processEnv: false,
        schema: mini.object({ VALUE: mini.string() }),
      },
      schema: mini.object({ value: mini.string() }),
      sources: [inline({ value: "%env(VALUE)%" })],
    });

    expect(result.env.VALUE).toBe("mini");
    expect(result.config.value).toBe("mini");
  });

  it("keeps path as ordinary inline data", async () => {
    const result = await defineConfig({
      schema: z.object({ path: z.string() }),
      sources: [inline({ path: "/literal/application/path" })],
    });
    expect(result.config.path).toBe("/literal/application/path");
  });

  it("preserves special keys without prototype pollution", async () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"safe":"yes"}');
    const result = await defineConfig({
      schema: z.custom<Record<string, unknown>>(
        (input) => typeof input === "object" && input !== null,
      ),
      sources: [inline(value)],
    });

    expect(Object.hasOwn(result.config, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("reports missing and malformed sources with stable codes", async () => {
    await expect(
      defineConfig({
        schema: z.object({}),
        sources: [jsonFile("missing.json")],
        cwd: fixtures,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_MISSING" });

    await expect(
      defineConfig({
        schema: z.object({}),
        sources: [jsonFile("config.unsupported")],
        cwd: fixtures,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_INVALID" });

    await expect(
      defineConfig({
        schema: z.object({}),
        sources: [yamlFile("config.invalid.yaml")],
        cwd: fixtures,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_INVALID" });
  });

  it("rejects invalid defaults and provider values", async () => {
    await expect(
      defineConfig({
        defaults: [] as never,
        schema: z.object({}),
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });

    await expect(
      defineConfig({
        schema: z.object({}),
        sources: [provider("invalid", () => [] as unknown as Record<string, unknown>)],
      }),
    ).rejects.toMatchObject({ code: "SOURCE_INVALID" });
  });

  it("rejects cyclic and mutable object values before freezing results", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(
      defineConfig({
        schema: z.object({}),
        sources: [inline(cyclic)],
      }),
    ).rejects.toMatchObject({ code: "SOURCE_INVALID" });

    await expect(
      defineConfig({
        schema: z.object({ value: z.string() }).transform(() => new Date()),
        sources: [inline({ value: "date" })],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("aggregates configuration schema issues", async () => {
    try {
      await defineConfig({
        schema: z.object({ enabled: z.boolean(), port: z.number() }),
        sources: [inline({ enabled: "yes", port: "invalid" })],
      });
    } catch (error) {
      expect((error as ConfigurationError).code).toBe("CONFIG_INVALID");
      expect((error as ConfigurationError).issues).toHaveLength(2);
      expect(Object.isFrozen((error as ConfigurationError).issues[0]?.path)).toBe(true);
    }
  });

  it("supports async configuration and environment schema validation", async () => {
    const schema = z.object({ value: z.string().refine(async () => true) });
    const asyncResult = await defineConfig({ schema, sources: [inline({ value: "ok" })] });
    expect(asyncResult.config.value).toBe("ok");

    const environmentSchema = z.object({ VALUE: z.string().refine(async () => true) });
    const environmentResult = await defineConfig({
      environment: {
        overrides: { VALUE: "async" },
        processEnv: false,
        schema: environmentSchema,
      },
      schema: z.object({}),
    });
    expect(environmentResult.env.VALUE).toBe("async");
  });
});
