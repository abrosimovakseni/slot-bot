/**
 * The queue position algorithm -- a direct, pure-function port of the
 * Railway version's services/queue.py:compute_positions. Deliberately has
 * no D1/IO dependency so it's trivial to unit test in isolation (mirrors
 * TEST1-4, TEST7-8, TEST10-11 from the original spec).
 *
 * THE RULE:
 *   Given all *active* signups for one consultation, ordered by `id`
 *   ascending (== signup order, since `id` is an autoincrementing column
 *   D1/SQLite assigns strictly in insertion order):
 *     1. Walk the list and pick out signups whose statusAtSignup is
 *        PRIORITY, in order. The first PRIORITY_SLOTS (5) of those get
 *        positions 1..5, in the order they signed up.
 *     2. Positions 1..5 are *reserved* for PRIORITY signups -- a RESTRICTED
 *        signup can never occupy them, even if it was the very first
 *        click. If fewer than 5 PRIORITY people have signed up, the
 *        remaining reserved slots stay empty rather than being backfilled.
 *     3. Every remaining signup (RESTRICTED signups, plus any PRIORITY
 *        signups past the first five) is ordered by signup time (`id`) and
 *        placed starting at position 6, with no further advantage for
 *        PRIORITY status.
 */
import { PRIORITY_SLOTS } from "./config";

export type PriorityStatus = "PRIORITY" | "RESTRICTED";

export interface SignupLike {
  id: number;
  statusAtSignup: PriorityStatus;
}

/** Returns a Map from signup.id -> 1-based position. */
export function computePositions(signups: SignupLike[]): Map<number, number> {
  const ordered = [...signups].sort((a, b) => a.id - b.id);
  const priorityInOrder = ordered.filter((s) => s.statusAtSignup === "PRIORITY");
  const reserved = priorityInOrder.slice(0, PRIORITY_SLOTS);
  const reservedIds = new Set(reserved.map((s) => s.id));

  const positions = new Map<number, number>();
  reserved.forEach((s, idx) => positions.set(s.id, idx + 1));

  let pos = PRIORITY_SLOTS + 1;
  for (const s of ordered) {
    if (reservedIds.has(s.id)) continue;
    positions.set(s.id, pos);
    pos += 1;
  }
  return positions;
}

export function toggleStatus(status: PriorityStatus): PriorityStatus {
  return status === "PRIORITY" ? "RESTRICTED" : "PRIORITY";
}
