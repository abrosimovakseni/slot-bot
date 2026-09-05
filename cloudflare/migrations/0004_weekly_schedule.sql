-- Moves the recurring weekly consultation schedule out of static code
-- (src/config.ts's old WEEKLY_SCHEDULE constant) and into D1, so the bot's
-- own admin can add/remove weekly slots through Telegram itself (see
-- bot/handlers/admin.ts's "📅 Еженедельный график" flow) -- no code change
-- or redeploy needed, which is what makes this bot resellable as-is to a
-- different group/curator without a developer's involvement each time.
--
-- curator/room are nullable here (unlike consultations.curator/room, which
-- are NOT NULL DEFAULT): NULL means "no override -- use
-- config.DEFAULT_CURATOR/DEFAULT_ROOM at consultation-creation time", same
-- meaning ScheduleEntry.curator/room being `undefined` had in the old
-- static array. active lets an entry be paused without losing its settings
-- (e.g. a group taking a week off), instead of only ever being deleted.
--
-- Seeded with the exact three entries config.ts used to hardcode, so an
-- existing deployment (this bot's current production database) keeps
-- behaving identically after this migration -- nothing changes until the
-- admin edits something through the new bot flow.
CREATE TABLE weekly_schedule (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Monday..6=Sunday
    class_hour    INTEGER NOT NULL CHECK (class_hour BETWEEN 0 AND 23),
    class_minute  INTEGER NOT NULL CHECK (class_minute BETWEEN 0 AND 59),
    opens_hour    INTEGER NOT NULL CHECK (opens_hour BETWEEN 0 AND 23),
    opens_minute  INTEGER NOT NULL CHECK (opens_minute BETWEEN 0 AND 59),
    curator       TEXT,
    room          TEXT,
    active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at    TEXT NOT NULL
);

INSERT INTO weekly_schedule (name, weekday, class_hour, class_minute, opens_hour, opens_minute, curator, room, active, created_at)
VALUES
    ('Среда',   2, 10, 30, 9, 30, NULL, NULL, 1, '2026-09-05T00:00:00.000Z'),
    ('Пятница', 4, 10, 30, 9, 30, NULL, NULL, 1, '2026-09-05T00:00:00.000Z'),
    ('Суббота', 5, 10, 30, 9, 30, 'Боремир Иванович', '324', 1, '2026-09-05T00:00:00.000Z');
