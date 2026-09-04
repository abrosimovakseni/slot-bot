/** Worker environment bindings + row shapes shared across modules. */

import type { ConsultationOpener } from "./consultationOpener";

export type NotifyMessage =
  | {
      kind: "opening";
      telegramUserId: number;
      consultationId: number;
      /** The class time string (HH:MM) to show. */
      detail: string;
      curator: string;
      room: string;
    }
  | {
      kind: "position_changed" | "consultation_cancelled";
      telegramUserId: number;
      consultationId: number;
      /** For "position_changed": the new 1-based position. For
       * "consultation_cancelled": the human-readable date/time label. */
      detail: string;
    }
  | {
      /** The curator changed who's teaching and/or the room for a
       * consultation someone's already signed up for (see the "✏️ Изменить
       * кабинет/куратора" admin action). `detail` is `${curator}|${room}`
       * -- not shown to the recipient, just there so notifications_sent's
       * dedupe treats two different edits as two different notifications,
       * while a retried delivery of the *same* edit still dedupes as one. */
      kind: "details_changed";
      telegramUserId: number;
      consultationId: number;
      detail: string;
      label: string;
      curator: string;
      room: string;
    }
  | {
      /** "The pinned queue-status message for this user may be stale --
       * recompute and re-edit it." Not a one-off notification (see
       * pinnedQueue.ts), so it carries no consultationId/detail and never
       * goes through the notifications_sent dedupe table. */
      kind: "queue_refresh";
      telegramUserId: number;
    };

export interface Env {
  DB: D1Database;
  NOTIFY_QUEUE: Queue<NotifyMessage>;
  /** One instance per admin one-off consultation -- see
   * consultationOpener.ts's doc comment for why this exists (exact-time
   * registration opening, free-tier SQLite-backed Durable Objects). */
  CONSULTATION_OPENER: DurableObjectNamespace<ConsultationOpener>;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_ID?: string;
  /** Test-only: the parsed migrations array, injected via vitest.config.ts
   * so test/apply-migrations.ts can apply them to the in-memory D1 before
   * each test file runs. Never set outside the test environment. */
  TEST_MIGRATIONS?: unknown;
}

export type PriorityStatus = "PRIORITY" | "RESTRICTED";

export interface UserRow {
  telegram_user_id: number;
  display_name: string;
  username: string | null;
  registered_at: string;
  priority_status: PriorityStatus;
  blocked: number; // 0 | 1
  /** message_id of the pinned "always visible" queue-status message the
   * bot keeps in this user's DM (see src/pinnedQueue.ts), or null if
   * they've never triggered one yet. */
  pinned_queue_message_id: number | null;
}

export interface ConsultationRow {
  id: number;
  label: string;
  scheduled_at: string;
  registration_opens_at: string;
  created_at: string;
  opened_notified_at: string | null;
  finalized_at: string | null;
  /** Who's teaching it and where -- defaults to config.DEFAULT_CURATOR /
   * DEFAULT_ROOM, editable per consultation (see bot/handlers/admin.ts's
   * "✏️ Изменить кабинет/куратора" flow). */
  curator: string;
  room: string;
}

export interface SignupRow {
  id: number;
  consultation_id: number;
  user_id: number;
  status_at_signup: PriorityStatus;
  created_at: string;
  active: number; // 0 | 1
  cancelled_at: string | null;
  counted_for_status: number; // 0 | 1
}

export interface UserStateRow {
  telegram_user_id: number;
  flow: "register" | "edit" | "admin_add" | "admin_edit_details";
  state:
    | "ASK_NAME"
    | "CONFIRM_NAME"
    | "ASK_DATETIME"
    | "CURATOR_ROOM_CHOICE"
    | "ASK_CURATOR"
    | "ASK_ROOM"
    | "CONFIRM_DATETIME"
    | "CONFIRM_EDIT_DETAILS";
  pending_name: string | null;
  /** Second generic pending-value slot -- see migrations/0003's comment for
   * why one slot stopped being enough once the admin flows started
   * carrying a curator name AND a room through multiple steps. */
  pending_extra: string | null;
  updated_at: string;
}
