import { expectTypeOf } from "vitest";
import * as z from "zod";

import { type DeepReadonly, type DefineConfigOptions, defineConfig, inline } from "../index";

async function verifyAsyncContract() {
  const result = await defineConfig({
    environment: {
      processEnv: false,
      schema: z.object({
        DEBUG: z.stringbool(),
        PORT: z.coerce.number(),
        SERVICE_URL: z.url(),
      }),
    },
    schema: z.object({ service: z.object({ port: z.number() }) }),
    sources: [inline({ service: { port: "%env(PORT)%" } })],
  });

  expectTypeOf(result.env.PORT).toEqualTypeOf<number>();
  expectTypeOf(result.env.DEBUG).toEqualTypeOf<boolean>();
  expectTypeOf(result.env.SERVICE_URL).toEqualTypeOf<string>();
  expectTypeOf(result.config.service.port).toEqualTypeOf<number>();

  // @ts-expect-error Unknown environment variables are rejected.
  result.env.NOT_DECLARED;
  // @ts-expect-error Configuration output is deeply readonly.
  result.config.service.port = 4000;
}

async function verifyReusableOptionsContract() {
  const configSchema = z.object({ enabled: z.boolean().default(true) });
  const environmentSchema = z.object({ NODE_ENV: z.string() });
  const options: DefineConfigOptions<typeof configSchema, typeof environmentSchema> = {
    environment: { schema: environmentSchema },
    schema: configSchema,
  };

  const result = await defineConfig(options);
  expectTypeOf(result.config.enabled).toEqualTypeOf<boolean>();
}

async function verifyEnvironmentFreeContract() {
  const result = await defineConfig({
    schema: z.object({ nested: z.object({ enabled: z.boolean() }) }),
    sources: [inline({ nested: { enabled: true } })],
  });

  expectTypeOf(result.env).toEqualTypeOf<DeepReadonly<Record<string, never>>>();
  expectTypeOf(result.config.nested.enabled).toEqualTypeOf<boolean>();
}

void verifyAsyncContract;
void verifyEnvironmentFreeContract;
void verifyReusableOptionsContract;
