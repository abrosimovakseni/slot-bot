-- Tracks the one pinned "always visible" queue-status message the bot
-- keeps per user (see src/pinnedQueue.ts) -- NULL until their first
-- successful signup or their first "Посмотреть очередь" press, whichever
-- happens first; the bot edits this same message in place afterwards
-- instead of sending a new one every time the queue changes.
ALTER TABLE users ADD COLUMN pinned_queue_message_id INTEGER;
