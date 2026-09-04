import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cancelSignup, getMyPosition, getQueueView, signupUser } from "../src/db/queue";
import { createOpenConsultation, createUnopenedConsultation, makeUser } from "./helpers";

describe("signupUser", () => {
  it("signs a registered user up and returns their position", async () => {
    const consultationId = await createOpenConsultation(env);
    const userId = await makeUser(env);
    const outcome = await signupUser(env, consultationId, userId);
    expect(outcome.kind).toBe("signed_up");
    if (outcome.kind === "signed_up") {
      expect(outcome.position).toBe(1);
      expect(outcome.statusAtSignup).toBe("PRIORITY");
    }
  });

  it("TEST5: signing up twice is idempotent -- returns already_signed_up with the same position", async () => {
    const consultationId = await createOpenConsultation(env);
    const userId = await makeUser(env);
    const first = await signupUser(env, consultationId, userId);
    const second = await signupUser(env, consultationId, userId);
    expect(second.kind).toBe("already_signed_up");
    if (first.kind === "signed_up" && second.kind === "already_signed_up") {
      expect(second.position).toBe(first.position);
    }

    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM signups WHERE consultation_id = ? AND user_id = ? AND active = 1",
    )
      .bind(consultationId, userId)
      .all<{ c: number }>();
    expect(results[0]!.c).toBe(1); // never more than one active signup row
  });

  it("TEST6: two different users may share the same display name -- telegram_user_id is the identity key", async () => {
    const consultationId = await createOpenConsultation(env);
    const userA = await makeUser(env, { displayName: "Иван Иванов" });
    const userB = await makeUser(env, { displayName: "Иван Иванов" });
    const a = await signupUser(env, consultationId, userA);
    const b = await signupUser(env, consultationId, userB);
    expect(a.kind).toBe("signed_up");
    expect(b.kind).toBe("signed_up");
    if (a.kind === "signed_up" && b.kind === "signed_up") {
      expect(a.position).not.toBe(b.position);
    }
  });

  it("refuses signup before registration opens", async () => {
    const consultationId = await createUnopenedConsultation(env);
    const userId = await makeUser(env);
    const outcome = await signupUser(env, consultationId, userId);
    expect(outcome.kind).toBe("registration_not_open");
  });

  it("refuses signup for an unregistered user", async () => {
    const consultationId = await createOpenConsultation(env);
    const outcome = await signupUser(env, consultationId, 123_456_789);
    expect(outcome.kind).toBe("user_not_registered");
  });

  it("TEST14: concurrent duplicate signup attempts from the SAME user never produce two active rows", async () => {
    const consultationId = await createOpenConsultation(env);
    const userId = await makeUser(env);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => signupUser(env, consultationId, userId)),
    );
    const signedUpCount = results.filter((r) => r.kind === "signed_up").length;
    const alreadyCount = results.filter((r) => r.kind === "already_signed_up").length;
    expect(signedUpCount).toBe(1);
    expect(alreadyCount).toBe(9);

    const { results: rows } = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM signups WHERE consultation_id = ? AND user_id = ? AND active = 1",
    )
      .bind(consultationId, userId)
      .all<{ c: number }>();
    expect(rows[0]!.c).toBe(1);
  });

  it("TEST15: concurrent signups from DIFFERENT users all succeed with distinct, consistent positions", async () => {
    const consultationId = await createOpenConsultation(env);
    const userIds = await Promise.all(Array.from({ length: 8 }, () => makeUser(env)));

    const results = await Promise.all(userIds.map((uid) => signupUser(env, consultationId, uid)));
    expect(results.every((r) => r.kind === "signed_up")).toBe(true);

    const positions = results.map((r) => (r.kind === "signed_up" ? r.position : -1));
    expect(new Set(positions).size).toBe(8); // all distinct
    expect([...positions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const view = await getQueueView(env, consultationId);
    const realEntries = view.filter((e) => !e.isPlaceholder);
    expect(realEntries).toHaveLength(8);
  });
});

describe("cancelSignup", () => {
  it("TEST9: cancelling an active signup frees the slot and recomputes the queue", async () => {
    const consultationId = await createOpenConsultation(env);
    const users = await Promise.all(Array.from({ length: 3 }, () => makeUser(env)));
    for (const u of users) await signupUser(env, consultationId, u);

    const result = await cancelSignup(env, consultationId, users[0]!);
    expect(result.hadActiveSignup).toBe(true);

    const myPos = await getMyPosition(env, consultationId, users[0]!);
    expect(myPos.signedUp).toBe(false);
  });

  it("TEST12: cancelling notifies only users whose position actually changed", async () => {
    const consultationId = await createOpenConsultation(env);
    // 3 PRIORITY users signed up in order: positions 1, 2, 3.
    const users = await Promise.all(Array.from({ length: 3 }, () => makeUser(env)));
    for (const u of users) await signupUser(env, consultationId, u);

    // Cancel the FIRST person -- the other two shift up (2->1, 3->2).
    const result = await cancelSignup(env, consultationId, users[0]!);
    expect(result.changedPositions.size).toBe(2);
    expect(result.changedPositions.get(users[1]!)).toBe(1);
    expect(result.changedPositions.get(users[2]!)).toBe(2);
  });

  it("TEST13: cancelling the LAST person in the queue changes nobody else's position", async () => {
    const consultationId = await createOpenConsultation(env);
    const users = await Promise.all(Array.from({ length: 3 }, () => makeUser(env)));
    for (const u of users) await signupUser(env, consultationId, u);

    const result = await cancelSignup(env, consultationId, users[2]!);
    expect(result.changedPositions.size).toBe(0);
  });

  it("cancelling with no active signup reports hadActiveSignup: false", async () => {
    const consultationId = await createOpenConsultation(env);
    const userId = await makeUser(env);
    const result = await cancelSignup(env, consultationId, userId);
    expect(result.hadActiveSignup).toBe(false);
  });

  it("cancelling twice in a row is idempotent (second call is a safe no-op)", async () => {
    const consultationId = await createOpenConsultation(env);
    const userId = await makeUser(env);
    await signupUser(env, consultationId, userId);
    const first = await cancelSignup(env, consultationId, userId);
    const second = await cancelSignup(env, consultationId, userId);
    expect(first.hadActiveSignup).toBe(true);
    expect(second.hadActiveSignup).toBe(false);
  });

  it("cancelling and re-signing up creates a fresh signup at the back of the queue", async () => {
    const consultationId = await createOpenConsultation(env);
    const users = await Promise.all(Array.from({ length: 2 }, () => makeUser(env)));
    await signupUser(env, consultationId, users[0]!);
    await signupUser(env, consultationId, users[1]!);
    await cancelSignup(env, consultationId, users[0]!);
    const rejoin = await signupUser(env, consultationId, users[0]!);
    expect(rejoin.kind).toBe("signed_up");
    if (rejoin.kind === "signed_up") {
      expect(rejoin.position).toBe(2); // now behind the person who never cancelled
    }
  });
});
