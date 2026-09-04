/** Worker environment bindings + row shapes shared across modules. */

export type NotifyMessage =
  | {
      kind: "opening" | "position_changed" | "consultation_cancelled";
      telegramUserId: number;
      consultationId: number;
      /** For "opening": the class time string (HH:MM) to show. For
       * "position_changed": the new 1-based position. For
       * "consultation_cancelled": the human-readable date/time label. */
      detail: string;
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
  flow: "register" | "edit" | "admin_add";
  state: "ASK_NAME" | "CONFIRM_NAME" | "ASK_DATETIME" | "CONFIRM_DATETIME";
  pending_name: string | null;
  updated_at: string;
}
