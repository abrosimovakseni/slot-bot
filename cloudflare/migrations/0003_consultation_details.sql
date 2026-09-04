-- Adds curator name and room to each consultation. NOT NULL DEFAULT means
-- every existing INSERT that doesn't list these two columns explicitly
-- (ensureCreatedAndOpened, createConsultationIfAbsent) keeps working
-- unchanged and still gets sensible values -- see src/config.ts's
-- DEFAULT_CURATOR / DEFAULT_ROOM, the same values used here.
--
-- Also adds a second generic pending-value slot to user_state
-- (pending_extra), alongside the existing pending_name: the admin "create a
-- one-off consultation" and new "change curator/room" flows now each carry
-- two free-typed values (curator, then room) through their steps, not just
-- one -- see bot/handlers/admin.ts.
ALTER TABLE consultations ADD COLUMN curator TEXT NOT NULL DEFAULT 'Любовь Котлярова';
ALTER TABLE consultations ADD COLUMN room TEXT NOT NULL DEFAULT '332';
ALTER TABLE user_state ADD COLUMN pending_extra TEXT;
