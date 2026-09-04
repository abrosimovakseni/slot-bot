import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { applyD1Migrations, env } from "cloudflare:test";

// Re-applies the same migrations/ directory the real deploy uses, against
// the in-memory D1 instance Miniflare spins up for tests -- so tests never
// drift from the real schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS as D1Migration[]);
