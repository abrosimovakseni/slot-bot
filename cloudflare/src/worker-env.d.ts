/**
 * Wires our own `Env` interface (src/types.ts) up as the ambient
 * `Cloudflare.Env` that `cloudflare:test`'s `env` export (and Wrangler's
 * own generated types) are typed against, so `import { env } from
 * "cloudflare:test"` in tests is fully typed without a separate
 * `wrangler types` codegen step to keep in sync.
 */
import type { Env as AppEnv } from "./types";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
  }
}

export {};
