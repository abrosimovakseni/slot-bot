"""
Pure, dependency-free time/schedule helpers.

Everything here takes `now` as an explicit argument instead of reading the
system clock internally, specifically so the weekly-schedule logic can be
unit tested with fixed timestamps (see tests/test_time_scheduling.py)
without mocking global time.
"""
from __future__ import annotations

import datetime

from .config import MOSCOW_TZ, WEEKLY_SCHEDULE, ScheduleEntry


def now_utc() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def now_moscow() -> datetime.datetime:
    return datetime.datetime.now(MOSCOW_TZ)


def week_occurrence(
    now: datetime.datetime, entry: ScheduleEntry
) -> tuple[datetime.datetime, datetime.datetime]:
    """Return (scheduled_at, registration_opens_at) -- both tz-aware in
    Europe/Moscow -- for the occurrence of `entry` in the ISO week (Mon-Sun)
    that contains `now`."""
    now_msk = now.astimezone(MOSCOW_TZ)
    monday = now_msk.date() - datetime.timedelta(days=now_msk.weekday())
    day = monday + datetime.timedelta(days=entry.weekday)
    scheduled_at = datetime.datetime.combine(day, entry.class_time, tzinfo=MOSCOW_TZ)
    opens_at = datetime.datetime.combine(day, entry.opens_time, tzinfo=MOSCOW_TZ)
    return scheduled_at, opens_at


def all_week_occurrences(
    now: datetime.datetime,
) -> list[tuple[ScheduleEntry, datetime.datetime, datetime.datetime]]:
    """All configured schedule entries' occurrences for the week containing `now`."""
    result = []
    for entry in WEEKLY_SCHEDULE:
        scheduled_at, opens_at = week_occurrence(now, entry)
        result.append((entry, scheduled_at, opens_at))
    return result
