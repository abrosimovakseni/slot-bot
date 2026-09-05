import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(import.meta.dirname, "migrations");
      const migrations = await readD1Migrations(migrationsPath);
      return {
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only values -- never the real secrets. BOT_TOKEN is
            // deliberately fake: TelegramClient's calls to api.telegram.org
            // are expected to fail (404, invalid token) and are swallowed
            // by its own try/catch (see telegram.ts), so tests never depend
            // on a real bot -- but they're still REAL network round-trips,
            // and a test exercising several of them back-to-back (e.g. a
            // multi-step admin flow) can occasionally outrun vitest's
            // default 5s timeout on a slow connection, with no bearing on
            // whether the test's own assertions are right. See this file's
            // `testTimeout` below.
            BOT_TOKEN: "test-bot-token",
            WEBHOOK_SECRET: "test-webhook-secret",
            // A fixed telegram_user_id, deliberately outside the range
            // test/helpers.ts's makeUser() generates (900_000_000+), so
            // admin-flow tests can never collide with a helper-made user.
            ADMIN_ID: "1",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // Generous headroom over the 5s default -- see the BOT_TOKEN comment
    // above. Tests still fail on a genuine hang, just not on an ordinary
    // slow-network day.
    testTimeout: 20_000,
  },
});
