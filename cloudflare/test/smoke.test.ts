import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("D1 smoke test", () => {
  it("has the schema applied", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    expect(names).toContain("users");
    expect(names).toContain("consultations");
    expect(names).toContain("signups");
  });
});
