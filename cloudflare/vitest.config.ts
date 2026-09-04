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
            // fail fast in the test runtime and are swallowed by its own
            // try/catch (see telegram.ts), so tests never depend on network
            // access or a real bot.
            BOT_TOKEN: "test-bot-token",
            WEBHOOK_SECRET: "test-webhook-secret",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
