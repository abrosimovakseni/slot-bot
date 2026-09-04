"""TEST 18, 19, 20, 21: the Wed/Fri 09:30 Europe/Moscow schedule."""
from __future__ import annotations

import datetime

from sqlalchemy import func, select

from slot_bot.config import MOSCOW_TZ, WEEKLY_SCHEDULE
from slot_bot.models import Consultation
from slot_bot.services.consultations import reconcile
from slot_bot.services.queue import get_queue_view, signup_user
from slot_bot.time_utils import week_occurrence

from .helpers import make_user

WED = next(e for e in WEEKLY_SCHEDULE if e.name == "Среда")
FRI = next(e for e in WEEKLY_SCHEDULE if e.name == "Пятница")


def test_python_to_ptb_weekday_conversion_used_in_bot_app():
    # Regression guard for the conversion in bot/app.py: PTB's JobQueue
    # uses 0=Sunday..6=Saturday (since PTB v20), while ScheduleEntry.weekday
    # uses Python's date.weekday() convention (0=Monday..6=Sunday). Getting
    # this wrong would silently move the "exact time" broadcast to the
    # wrong day of the week (the safety-net poll would still recover
    # within ~15 minutes, but the whole point of the cron job is to be
    # prompt).
    assert (WED.weekday + 1) % 7 == 3  # Wednesday -> PTB's Wednesday (3)
    assert (FRI.weekday + 1) % 7 == 5  # Friday -> PTB's Friday (5)


def _past_date_on_weekday(weekday: int) -> datetime.date:
    """Like _some_date_on_weekday, but anchored to *last* week so the
    returned date (and 09:30 on it) is safely in the past relative to the
    real wall clock -- needed for tests that call signup_user(), which
    checks the real current time, not the synthetic `now` passed to
    reconcile()."""
    today = datetime.date.today()
    this_monday = today - datetime.timedelta(days=today.weekday())
    anchor_monday = this_monday - datetime.timedelta(days=7)
    return anchor_monday + datetime.timedelta(days=weekday)


def _some_date_on_weekday(weekday: int) -> datetime.date:
    """A date with the given weekday, always taken from the SAME anchor
    week (the next upcoming Monday-Sunday week) so that, e.g., the
    Wednesday and Friday returned by two separate calls are always in the
    same week and correctly ordered relative to each other -- regardless
    of what day "today" happens to be when the test suite runs."""
    today = datetime.date.today()
    anchor_monday = today + datetime.timedelta(days=(7 - today.weekday()) % 7 or 7)
    return anchor_monday + datetime.timedelta(days=weekday)


async def _count_consultations(session_factory) -> int:
    async with session_factory() as session:
        return await session.scalar(select(func.count()).select_from(Consultation))


def test_pure_wednesday_930_produces_correct_scheduled_and_opens_time():
    # TEST 18: for a `now` on Wednesday, week_occurrence for the Среда
    # entry must yield class start 10:30 and opening 09:30, Europe/Moscow.
    wed_date = _some_date_on_weekday(WED.weekday)
    now = datetime.datetime.combine(wed_date, datetime.time(9, 30), tzinfo=MOSCOW_TZ)
    scheduled_at, opens_at = week_occurrence(now, WED)
    assert scheduled_at.astimezone(MOSCOW_TZ).time() == datetime.time(10, 30)
    assert opens_at.astimezone(MOSCOW_TZ).time() == datetime.time(9, 30)
    assert scheduled_at.astimezone(MOSCOW_TZ).weekday() == 2


def test_pure_friday_930_produces_correct_scheduled_and_opens_time():
    # TEST 19: same, for Пятница.
    fri_date = _some_date_on_weekday(FRI.weekday)
    now = datetime.datetime.combine(fri_date, datetime.time(9, 30), tzinfo=MOSCOW_TZ)
    scheduled_at, opens_at = week_occurrence(now, FRI)
    assert scheduled_at.astimezone(MOSCOW_TZ).time() == datetime.time(10, 30)
    assert opens_at.astimezone(MOSCOW_TZ).time() == datetime.time(9, 30)
    assert scheduled_at.astimezone(MOSCOW_TZ).weekday() == 4


async def test_reconcile_at_wednesday_930_creates_and_opens_the_right_consultation(session_factory):
    # TEST 18 (integration): reconcile() called exactly at Wednesday 09:30
    # Moscow creates exactly one consultation, correctly opened.
    wed_date = _some_date_on_weekday(WED.weekday)
    now = datetime.datetime.combine(wed_date, datetime.time(9, 30), tzinfo=MOSCOW_TZ).astimezone(
        datetime.timezone.utc
    )
    report = await reconcile(session_factory, now=now)
    assert len(report.opened) == 1
    assert report.opened[0].created is True
    assert report.opened[0].just_opened is True
    assert await _count_consultations(session_factory) == 1


async def test_reconcile_at_friday_930_creates_and_opens_the_right_consultation(session_factory):
    # TEST 19 (integration).
    fri_date = _some_date_on_weekday(FRI.weekday)
    now = datetime.datetime.combine(fri_date, datetime.time(9, 30), tzinfo=MOSCOW_TZ).astimezone(
        datetime.timezone.utc
    )
    report = await reconcile(session_factory, now=now)
    assert len(report.opened) == 1
    assert await _count_consultations(session_factory) == 1


async def test_reconcile_outside_schedule_creates_nothing(session_factory):
    # TEST 20: calling reconcile() at a time before either this week's
    # opening moment must create no consultation at all.
    monday_date = _some_date_on_weekday(0)
    now = datetime.datetime.combine(monday_date, datetime.time(8, 0), tzinfo=MOSCOW_TZ).astimezone(
        datetime.timezone.utc
    )
    report = await reconcile(session_factory, now=now)
    assert report.opened == []
    assert await _count_consultations(session_factory) == 0


async def test_reconcile_called_repeatedly_never_duplicates(session_factory):
    # TEST 20 (extra): repeated reconcile calls at/after the opening moment
    # must not create a second consultation for the same slot, and must not
    # re-broadcast the opening.
    wed_date = _some_date_on_weekday(WED.weekday)
    now = datetime.datetime.combine(wed_date, datetime.time(9, 30), tzinfo=MOSCOW_TZ).astimezone(
        datetime.timezone.utc
    )
    first = await reconcile(session_factory, now=now)
    second = await reconcile(session_factory, now=now + datetime.timedelta(minutes=5))
    third = await reconcile(session_factory, now=now + datetime.timedelta(hours=2))

    assert len(first.opened) == 1
    assert second.opened == []  # already open, nothing new to broadcast
    assert third.opened == []
    assert await _count_consultations(session_factory) == 1


async def test_reconcile_after_class_time_same_day_creates_nothing(session_factory):
    # Regression test: if the bot's very first reconcile for a given slot
    # happens on the class's own day but AFTER the class time (10:30) has
    # already passed -- e.g. the bot is deployed for the first time at
    # 15:00 on a Friday -- it must not manufacture that consultation.
    # Nobody could have signed up for a class that's already over; the
    # existing calendar-day bound above only caught *entirely* skipped
    # days, not this same-day-but-too-late case.
    fri_date = _some_date_on_weekday(FRI.weekday)
    now = datetime.datetime.combine(fri_date, datetime.time(15, 0), tzinfo=MOSCOW_TZ).astimezone(
        datetime.timezone.utc
    )
    report = await reconcile(session_factory, now=now)
    assert report.opened == []
    assert await _count_consultations(session_factory) == 0


async def test_reconcile_still_finishes_opening_existing_slot_after_class_time(session_factory):
    # The same-day-too-late bound must only block *creating* a brand-new
    # row -- if a consultation was already created earlier that day (e.g.
    # the bot crashed right after creating it but before broadcasting), a
    # later-in-the-day reconcile must still recognize and finish opening it.
    fri_date = _some_date_on_weekday(FRI.weekday)
    open_time = datetime.datetime.combine(fri_date, datetime.time(9, 30), tzinfo=MOSCOW_TZ).astimezone(
        datetime.timezone.utc
    )
    first = await reconcile(session_factory, now=open_time)
    assert len(first.opened) == 1

    later = open_time + datetime.timedelta(hours=6)  # 15:30 MSK, well after 10:30 class time
    second = await reconcile(session_factory, now=later)
    assert second.opened == []  # already open -- nothing new, but not an error either
    assert await _count_consultations(session_factory) == 1


async def test_new_consultation_after_finalize_starts_with_empty_queue(session_factory):
    # TEST 21: after the previous consultation is auto-finalized, a newly
    # created consultation's queue is empty regardless of history.
    # Uses last week's Wed/Fri (via _past_date_on_weekday) so that the
    # synthetic registration_opens_at is safely before the real wall clock
    # -- signup_user() checks real time, unlike reconcile() which takes an
    # explicit `now`.
    wed_date = _past_date_on_weekday(WED.weekday)
    wed_open = datetime.datetime.combine(wed_date, datetime.time(9, 30), tzinfo=MOSCOW_TZ).astimezone(
        datetime.timezone.utc
    )
    await reconcile(session_factory, now=wed_open)

    async with session_factory() as session:
        old_consultation = await session.scalar(select(Consultation))

    await make_user(session_factory, 1)
    async with session_factory() as session:
        await signup_user(session, old_consultation.id, 1)

    # simulate the next day: finalize old, then open Friday's slot.
    fri_date = _past_date_on_weekday(FRI.weekday)
    fri_open = datetime.datetime.combine(fri_date, datetime.time(9, 30), tzinfo=MOSCOW_TZ).astimezone(
        datetime.timezone.utc
    )
    report = await reconcile(session_factory, now=fri_open)
    assert len(report.finalized) == 1
    assert len(report.opened) == 1

    new_consultation_id = report.opened[0].consultation_id
    assert new_consultation_id != old_consultation.id

    async with session_factory() as session:
        entries = await get_queue_view(session, new_consultation_id)
    assert entries == [] or all(e.is_placeholder for e in entries)
