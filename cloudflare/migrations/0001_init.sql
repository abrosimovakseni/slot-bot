-- SLOT bot -- D1 schema.
--
-- Mirrors the PostgreSQL schema of the Railway version 1:1 in spirit, with
-- the adjustments SQLite/D1 needs:
--   * No native BOOLEAN -- 0/1 INTEGER, same as SQLite convention.
--   * No `now()` server default -- timestamps are ISO-8601 UTC strings
--     ('YYYY-MM-DDTHH:MM:SS.sssZ') written explicitly by the Worker, since
--     D1/SQLite's own datetime('now') has no timezone info attached.
--   * D1 supports RETURNING (SQLite >= 3.35), used the same way the
--     PostgreSQL version uses it: atomic
--       UPDATE ... SET x = ? WHERE x IS NULL RETURNING id
--     claims for idempotency, and atomic
--       INSERT INTO t SELECT ... WHERE NOT EXISTS (...)
--     for create-if-absent, so no explicit row locking is needed -- D1
--     serializes writes to a given database at the storage layer.
--   * Two extra tables not present in the Postgres version, needed because
--     a Worker has no long-lived process memory between requests:
--       - user_state       conversation state (name entry / confirm steps)
--       - processed_updates  webhook delivery idempotency guard
--       - notifications_sent  de-dupes queue-driven notification sends

PRAGMA foreign_keys = ON;

CREATE TABLE users (
    telegram_user_id INTEGER PRIMARY KEY,
    display_name     TEXT NOT NULL,
    username         TEXT,
    registered_at    TEXT NOT NULL,
    priority_status  TEXT NOT NULL DEFAULT 'PRIORITY'
                        CHECK (priority_status IN ('PRIORITY', 'RESTRICTED')),
    blocked          INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1))
);

CREATE TABLE consultations (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    label                    TEXT NOT NULL DEFAULT '',
    scheduled_at             TEXT NOT NULL,
    registration_opens_at    TEXT NOT NULL,
    created_at               TEXT NOT NULL,
    opened_notified_at       TEXT,
    finalized_at             TEXT,
    UNIQUE (scheduled_at)
);

CREATE TABLE signups (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    consultation_id      INTEGER NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
    user_id              INTEGER NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
    status_at_signup     TEXT NOT NULL CHECK (status_at_signup IN ('PRIORITY', 'RESTRICTED')),
    created_at           TEXT NOT NULL,
    active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    cancelled_at         TEXT,
    counted_for_status   INTEGER NOT NULL DEFAULT 0 CHECK (counted_for_status IN (0, 1))
);

CREATE INDEX ix_signups_consultation_active_id ON signups (consultation_id, active, id);

-- Partial unique index: at most one ACTIVE signup per (consultation, user).
-- The single source of truth preventing a duplicate active signup, exactly
-- like the Postgres version's partial unique index.
CREATE UNIQUE INDEX uq_signups_one_active_per_user_per_consultation
    ON signups (consultation_id, user_id)
    WHERE active = 1;

-- Conversation state for the registration / edit-name flows. A Worker has
-- no per-user in-memory state between webhook calls, so what PTB's
-- ConversationHandler kept in memory has to live in D1 instead.
--   flow:  'register' | 'edit'
--   state: 'ASK_NAME' | 'CONFIRM_NAME'
CREATE TABLE user_state (
    telegram_user_id INTEGER PRIMARY KEY,
    flow             TEXT NOT NULL,
    state            TEXT NOT NULL,
    pending_name     TEXT,
    updated_at       TEXT NOT NULL
);

-- Idempotency guard for Telegram webhook delivery: Telegram retries a
-- webhook call if it doesn't get a timely 200 OK, which would otherwise
-- reprocess the same update (e.g. double signup attempt, double message).
CREATE TABLE processed_updates (
    update_id    INTEGER PRIMARY KEY,
    processed_at TEXT NOT NULL
);

-- De-dupe guard for queue-driven notification sends (Cloudflare Queues is
-- at-least-once delivery, so a consumer retry must not double-send the
-- same "запись открыта" / "место изменилось" message to the same person).
CREATE TABLE notifications_sent (
    telegram_user_id INTEGER NOT NULL,
    consultation_id  INTEGER NOT NULL,
    kind             TEXT NOT NULL,
    detail           TEXT NOT NULL DEFAULT '',
    sent_at          TEXT NOT NULL,
    PRIMARY KEY (telegram_user_id, consultation_id, kind, detail)
);
