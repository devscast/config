# Config : Typesafe configuration loader

![npm](https://img.shields.io/npm/v/@ngandu-dev/config?style=flat-square)
![npm](https://img.shields.io/npm/dt/@ngandu-dev/config?style=flat-square)
[![Quality](https://github.com/ngandu-dev/config/actions/workflows/quality.yml/badge.svg?branch=main)](https://github.com/ngandu-dev/config/actions/workflows/quality.yml)
[![Tests](https://github.com/ngandu-dev/config/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/ngandu-dev/config/actions/workflows/test.yml)
![GitHub](https://img.shields.io/github/license/ngandu-dev/config?style=flat-square)

---

`@ngandu-dev/config` loads explicit environment and configuration sources, resolves environment references, validates everything with Zod, and returns deeply readonly values with full TypeScript inference.

## Features

- One async startup API for local files, remote providers, and async validation
- Schema-derived environment autocomplete and native value types
- Explicit JSON, YAML, inline, and provider sources
- Deterministic precedence with concurrent provider loading
- No mutation of `process.env` or caller-owned values
- Aggregated, structured, and secret-aware diagnostics
- Immutable configuration with source provenance
- No shell execution, automatic file discovery, or ambiguous source objects

## Requirements

- Node.js 20.17 or newer
- An ESM application (`"type": "module"` or an `.mjs` entry point)
- Zod 4

## Installation

```bash
npm install @ngandu-dev/config zod
```

JSON and YAML support are included. Zod remains a peer dependency so applications control their validation version.

## Quick start

Create an environment file:

```dotenv
# .env
PORT=3000
DATABASE_URL=postgres://app:secret@localhost:5432/app
LOGGER_PRETTY=false
```

Create a configuration source:

```yaml
# config/base.yaml
http:
  host: "0.0.0.0"
  port: "%env(PORT)%"
database:
  url: "%env(DATABASE_URL)%"
logger:
  pretty: "%env(LOGGER_PRETTY)%"
```

Define and export the application configuration:

```ts
// src/config.ts
import { defineConfig, yamlFile } from "@ngandu-dev/config";
import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.url(),
  LOGGER_PRETTY: z.stringbool().default(false),
});

const ConfigurationSchema = z.object({
  http: z.object({
    host: z.string(),
    port: z.number(),
  }),
  database: z.object({
    url: z.url(),
  }),
  logger: z.object({
    pretty: z.boolean(),
  }),
});

export const { config, env, metadata } = await defineConfig({
  environment: {
    schema: EnvironmentSchema,
    files: [
      { path: ".env", optional: true },
      { path: ".env.local", optional: true },
    ],
    redact: ["DATABASE_URL"],
  },
  schema: ConfigurationSchema,
  sources: [yamlFile("config/base.yaml", { name: "base" })],
});
```

Use the validated values during service startup:

```ts
import { config, env } from "./config";

console.log(`Starting in ${env.NODE_ENV}`);

server.listen({
  host: config.http.host,
  port: config.http.port,
});
```

The inferred values are:

```ts
env.PORT; // number
env.LOGGER_PRETTY; // boolean
config.database.url; // string

// Compile-time error: unknown environment key
env.NOT_DECLARED;

// Compile-time and runtime error: configuration is deeply readonly
config.http.port = 4000;
```

## `defineConfig`

`defineConfig` is intentionally async-only. A backend service should load configuration once during bootstrap and fail before accepting traffic when configuration is invalid.

```ts
const result = await defineConfig({
  schema,
  environment,
  defaults,
  sources,
  cwd,
});
```

| Option | Required | Description |
| --- | --- | --- |
| `schema` | Yes | Zod schema for the final merged configuration |
| `environment` | No | Environment schema, dotenv files, process input, overrides, and redaction policy |
| `defaults` | No | Initial values merged before every declared source |
| `sources` | No | Ordered JSON, YAML, inline, or provider sources |
| `cwd` | No | Base directory for relative paths; defaults to `process.cwd()` |

The result contains:

| Property | Description |
| --- | --- |
| `config` | Deeply readonly output of the configuration schema |
| `env` | Deeply readonly output of the environment schema, or an empty object when none is configured |
| `metadata` | Value-free source, environment, redaction, and provenance diagnostics |

Both full Zod and Zod Mini schemas are supported.

## Environment configuration

The environment schema is the single source of truth for variable names, defaults, coercion, validation, and TypeScript autocomplete.

```ts
const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().positive(),
  DEBUG: z.stringbool().default(false),
  OPTIONAL_TOKEN: z.string().optional(),
});

const result = await defineConfig({
  environment: {
    schema: EnvironmentSchema,
    files: [".env", { path: ".env.local", optional: true }],
    processEnv: process.env,
    overrides: { NODE_ENV: "test" },
    redact: ["OPTIONAL_TOKEN"],
  },
  schema: z.object({}),
});
```

### Precedence

Raw environment values are applied from lowest to highest priority:

1. Files in their declared order
2. `processEnv`, which defaults to a snapshot of `process.env`
3. Explicit `overrides`

The input is snapshotted before asynchronous work begins. Neither `process.env` nor a supplied `processEnv` or `overrides` object is modified.

Use isolated inputs in tests or controlled deployments:

```ts
environment: {
  schema: EnvironmentSchema,
  files: [".env.test"],
  processEnv: false,
  overrides: {
    NODE_ENV: "test",
    PORT: "4000",
  },
}
```

Environment files are required unless their entry uses `optional: true`. Files are never discovered automatically.

### Dotenv syntax

Environment files support:

- Blank lines, comments, and `export`
- Unquoted, single-quoted, double-quoted, and multiline quoted values
- `$NAME` and `${NAME}` expansion
- `${NAME-default}` when a value is undefined
- `${NAME:-default}` when a value is undefined or empty
- Expansion from earlier file entries and the supplied process input

Shell substitutions such as `$(command)` remain literal text and are never executed.

For isolated low-level parsing, use `parseDotenv`:

```ts
import { parseDotenv } from "@ngandu-dev/config";

const values = parseDotenv("URL=https://$HOST:$PORT", {
  context: { HOST: "localhost", PORT: "3000" },
  source: "generated.env",
});
```

## Environment references

Configuration sources reference validated environment output with `%env(NAME)%`.

A whole-value reference preserves the Zod output type:

```yaml
http:
  port: "%env(PORT)%" # number
logger:
  pretty: "%env(LOGGER_PRETTY)%" # boolean
```

An embedded reference is converted to a string:

```yaml
healthUrl: "https://%env(HOST)%:%env(PORT)%/health"
```

Missing references are collected and reported together with their configuration paths. Type coercion belongs in the environment schema rather than in the placeholder.

## Configuration sources

Every source is explicit and discriminated. Inline data can therefore safely contain ordinary fields named `path` or `type`.

### JSON and YAML

```ts
import { jsonFile, yamlFile } from "@ngandu-dev/config";

const sources = [
  jsonFile("config/base.json", { name: "base" }),
  yamlFile("config/production.yaml", {
    name: "deployment",
    optional: true,
  }),
];
```

Relative paths resolve from `cwd`. Missing optional sources are recorded in metadata with `loaded: false`; other read and parse failures stop startup.

### Inline values

```ts
import { inline } from "@ngandu-dev/config";

inline(
  {
    application: {
      path: "/srv/application",
      region: "af-south-1",
    },
  },
  { name: "runtime" },
);
```

### Providers

Providers integrate secret managers, service discovery, or computed application values:

```ts
import { provider } from "@ngandu-dev/config";

const sources = [
  provider("vault", async () => ({
    database: {
      password: await vault.read("database/password"),
    },
  })),
  provider("runtime", () => ({
    application: {
      region: "af-south-1",
    },
  })),
];
```

A provider may return an immediate object or a promise-like value. Providers are fetched concurrently and their results are merged in declaration order. Provider failure messages and causes are discarded so upstream exceptions cannot expose secrets.

### Merge behavior

- Defaults are applied first
- Sources are merged in declaration order
- Later scalar values replace earlier values
- Plain objects merge recursively
- Arrays replace earlier arrays rather than concatenating
- `undefined` values from a later source replace earlier values

Sources and schema outputs may contain configuration-safe primitives, arrays, and plain objects. Cycles, functions, symbols, and mutable class instances are rejected before results are frozen.

## Immutability

`config`, `env`, and `metadata` are cloned and deeply frozen. The loader never freezes caller-owned defaults, inline values, provider results, schemas, or environment inputs.

```ts
const source = { http: { port: 3000 } };
const result = await defineConfig({
  schema: z.object({ http: z.object({ port: z.number() }) }),
  sources: [inline(source)],
});

Object.isFrozen(source); // false
Object.isFrozen(result.config); // true
Object.isFrozen(result.config.http); // true
```

## Metadata and provenance

Metadata contains operational context without configuration or environment values:

```ts
metadata.sources;
// [{ type: "yaml", name: "base", path: "...", optional: false, loaded: true }]

metadata.environment.keys;
// ["DATABASE_URL", "NODE_ENV", "PORT"]

metadata.environment.redactedKeys;
// ["DATABASE_URL"]

metadata.provenance["http.port"];
// "base"
```

Provenance records the winning input source for each leaf path before schema transforms. Arrays and empty objects are treated as atomic leaf values because they are replaced as complete values during merging.

## Errors

All loading and validation failures use `ConfigurationError`:

```ts
import { ConfigurationError } from "@ngandu-dev/config";

try {
  await defineConfig(options);
} catch (error) {
  if (error instanceof ConfigurationError) {
    logger.fatal({ code: error.code, issues: error.issues }, "Invalid configuration");
    process.exitCode = 1;
  }
}
```

Environment validation, configuration validation, and missing environment references aggregate all issues found during that stage.

| Code | Meaning |
| --- | --- |
| `CONFIG_INVALID` | Final configuration failed validation or produced an unsupported value |
| `ENV_FILE_INVALID` | An environment file could not be read or parsed |
| `ENV_FILE_MISSING` | A required environment file does not exist |
| `ENV_INVALID` | Environment schema validation failed or produced an unsupported value |
| `ENV_REFERENCE_MISSING` | One or more `%env(NAME)%` references could not be resolved |
| `INVALID_OPTIONS` | Defaults or another option violated the API contract |
| `SOURCE_INVALID` | A source could not be read, parsed, or represented safely |
| `SOURCE_MISSING` | A required JSON or YAML source does not exist |
| `SOURCE_UNAVAILABLE` | A provider failed to load |

Keys listed in `environment.redact` receive generic validation and reference messages. Raw environment and configuration values are never stored in metadata or formatted package errors.

## Testing configuration

Prefer isolated environment input so tests never depend on or modify the runner process:

```ts
const result = await defineConfig({
  environment: {
    schema: EnvironmentSchema,
    processEnv: false,
    overrides: {
      NODE_ENV: "test",
      PORT: "4000",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
    },
  },
  schema: ConfigurationSchema,
  sources: [inline(testConfiguration)],
});
```

Because providers are ordinary functions, tests can replace remote integrations without mocking package internals.

## ESM runtime

Version 2 is ESM-only. Declare ESM in the consuming application's `package.json`:

```json
{
  "type": "module"
}
```

Then load configuration from an ESM bootstrap. Top-level `await` is supported, or it can remain inside the application's async startup function:

```ts
import { defineConfig } from "@ngandu-dev/config";

const { config } = await defineConfig(options);
await startServer(config);
```

## Migrating to `@ngandu-dev/config`

Version 3 is published under a new organization and is intentionally incompatible with the old
package coordinate. Install and import `@ngandu-dev/config`; no compatibility package or legacy
scope is provided. The configuration API introduced in version 2 remains the basis of version 3.

### Migrating from 1.1.1

Before:

```ts
const { config, env } = defineConfig({
  env: {
    knownKeys: ["PORT"],
  },
  schema,
  sources: ["config.yaml"],
});

env("PORT");
```

After:

```ts
const { config, env } = await defineConfig({
  environment: {
    schema: z.object({
      PORT: z.coerce.number().int().positive(),
    }),
    files: [{ path: ".env", optional: true }],
  },
  schema,
  sources: [yamlFile("config.yaml")],
});

env.PORT;
```

Migration checklist:

- Add `await` to `defineConfig` during application bootstrap
- Replace `env`, `env: true`, and `knownKeys` with `environment: { schema, ... }`
- Replace `env("NAME")` with property access such as `env.NAME`
- Wrap sources with `jsonFile`, `yamlFile`, `inline`, or `provider`
- Replace typed placeholders such as `%env(number:PORT)%` with `%env(PORT)%`
- Move coercion and defaults into the environment schema
- Declare environment files explicitly
- Remove uses of `env.has`, `env.optional`, `env.keys`, `createEnvAccessor`, the shared `env` export, and `Dotenv`
- Remove INI sources and dependencies
- Remove command expansion directives; commands are never executed in v2
- Treat returned configuration, environment, and metadata as deeply readonly

## Development

Install dependencies with `bun install`, then run `bun run quality` before opening a pull request.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete contribution workflow.

## Testing

Run `bun run test` for the test suite or `bun run test:coverage` for a coverage report.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and follow our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE).

## Contributors

<a href="https://github.com/ngandu-dev/config/graphs/contributors" title="Show all contributors">
  <img src="https://contrib.rocks/image?repo=ngandu-dev/config" alt="Contributors" />
</a>
