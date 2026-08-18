# @devscast/config

## 2.0.0

- Rebuilt the public API around a single async-only `defineConfig` startup contract.
- Replaced `knownKeys` and callable environment accessors with schema-validated, property-based environment output.
- Added discriminated JSON, YAML, inline, and provider sources; providers may return immediate or asynchronous values.
- Made configuration, environment, metadata, and provenance results deeply immutable.
- Added stable structured errors, aggregated validation/reference issues, secret-safe diagnostics, and source provenance.
- Replaced the stateful dotenv loader with an isolated parser that never mutates `process.env` or executes commands.
- Removed automatic environment discovery, legacy environment accessors, Dotenv classes, typed placeholder prefixes, INI parsing, and ambiguous source shapes.
- Added support for full and mini Zod schemas through the Zod core API.
- Modernized CommonJS/ESM package exports, Node.js targets, dependency ownership, CI, formatting, coverage, and public type exports.
- Removed the legacy Commitizen prompt stack and pinned patched transitive tooling releases following a dependency audit.
- Reorganized the implementation into focused configuration, environment, source, interpolation, validation, error, type, and utility modules.
- Added published TSDoc contracts for the configuration loaders, source factories, dotenv parser, and internal pipeline utilities.
- Rewrote the README as an end-to-end v2 guide covering async bootstrap, schemas, precedence, sources, providers, interpolation, errors, metadata, testing, security, and migration.

## 1.1.1
- fix: environment variables with typed prefixes are now correctly parsed as numbers and booleans
- bump dependencies
- enhance: ConfigValidationError now includes detailed validation issues
- fix: correct typing in defineConfig function
- drop support of ts config files
- drop support of csj config files

## 1.0.3

- support typed prefix in environment variables
- minify production dist
- remove command expansion tests
- Initial Release
