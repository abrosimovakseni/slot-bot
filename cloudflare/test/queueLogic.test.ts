import { describe, expect, it } from "vitest";
import { computePositions, toggleStatus, type SignupLike } from "../src/queueLogic";

function s(id: number, status: "PRIORITY" | "RESTRICTED"): SignupLike {
  return { id, statusAtSignup: status };
}

describe("computePositions (pure)", () => {
  it("TEST1: first 5 PRIORITY signups take positions 1-5 in signup order", () => {
    const signups = [1, 2, 3, 4, 5].map((id) => s(id, "PRIORITY"));
    const positions = computePositions(signups);
    for (const id of [1, 2, 3, 4, 5]) {
      expect(positions.get(id)).toBe(id);
    }
  });

  it("TEST2: a RESTRICTED signup can never occupy positions 1-5, even signing up first", () => {
    const signups = [s(1, "RESTRICTED"), s(2, "PRIORITY")];
    const positions = computePositions(signups);
    expect(positions.get(2)).toBe(1); // PRIORITY takes slot 1 despite signing up second
    expect(positions.get(1)).toBe(6); // RESTRICTED starts at position 6
  });

  it("TEST3: fewer than 5 PRIORITY signups leaves the remaining reserved slots empty (not backfilled)", () => {
    const signups = [s(1, "PRIORITY"), s(2, "PRIORITY"), s(3, "RESTRICTED")];
    const positions = computePositions(signups);
    expect(positions.get(1)).toBe(1);
    expect(positions.get(2)).toBe(2);
    // RESTRICTED does NOT backfill position 3, 4, or 5 -- goes straight to 6.
    expect(positions.get(3)).toBe(6);
  });

  it("TEST4: PRIORITY signups beyond the first five get no further advantage, ordered by signup time from 6+", () => {
    const priorityFive = [1, 2, 3, 4, 5].map((id) => s(id, "PRIORITY"));
    const sixthPriority = s(6, "PRIORITY"); // 6th PRIORITY signup, arrives before a RESTRICTED one
    const restricted = s(7, "RESTRICTED");
    const positions = computePositions([...priorityFive, sixthPriority, restricted]);
    expect(positions.get(6)).toBe(6); // 6th PRIORITY -- no special treatment, ordered by id
    expect(positions.get(7)).toBe(7);
  });

  it("6+ ordering is strictly by signup time (id), regardless of status mix", () => {
    // 5 PRIORITY fill 1-5, then RESTRICTED(id=6) signs up before PRIORITY(id=7).
    const signups = [1, 2, 3, 4, 5].map((id) => s(id, "PRIORITY"));
    signups.push(s(6, "RESTRICTED"), s(7, "PRIORITY"));
    const positions = computePositions(signups);
    expect(positions.get(6)).toBe(6);
    expect(positions.get(7)).toBe(7);
  });

  it("handles an empty signup list", () => {
    expect(computePositions([]).size).toBe(0);
  });

  it("order of the input array doesn't matter -- always sorted by id", () => {
    const signups = [s(3, "PRIORITY"), s(1, "PRIORITY"), s(2, "RESTRICTED")];
    const positions = computePositions(signups);
    expect(positions.get(1)).toBe(1); // first PRIORITY by id
    expect(positions.get(3)).toBe(2); // second PRIORITY by id
    expect(positions.get(2)).toBe(6); // RESTRICTED, 6+
  });
});

describe("toggleStatus (pure)", () => {
  it("TEST7/TEST8: PRIORITY <-> RESTRICTED alternation", () => {
    expect(toggleStatus("PRIORITY")).toBe("RESTRICTED");
    expect(toggleStatus("RESTRICTED")).toBe("PRIORITY");
  });

  it("TEST10/TEST11: toggling twice returns to the original status (full cycle)", () => {
    expect(toggleStatus(toggleStatus("PRIORITY"))).toBe("PRIORITY");
    expect(toggleStatus(toggleStatus("RESTRICTED"))).toBe("RESTRICTED");
  });
});
