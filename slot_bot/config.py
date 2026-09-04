"""
Central configuration for the SLOT bot.

Nothing secret lives here. Secrets (BOT_TOKEN, DATABASE_URL, ADMIN_ID) come
from environment variables so they never end up committed to Git.

The weekly consultation schedule lives here in one place, in plain,
easy-to-edit form -- change WEEKLY_SCHEDULE below if the curator's
schedule ever changes, no other file needs to change.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import time
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------------------
# Timezone
# ---------------------------------------------------------------------------
MOSCOW_TZ = ZoneInfo("Europe/Moscow")

# ---------------------------------------------------------------------------
# Weekly consultation schedule
# ---------------------------------------------------------------------------
# weekday follows Python's `date.weekday()` convention: Monday=0 ... Sunday=6


@dataclass(frozen=True)
class ScheduleEntry:
    name: str          # human readable label, used in bot messages/logs
    weekday: int       # 0=Monday ... 6=Sunday
    class_time: time   # when the consultation itself starts
    opens_time: time   # when signup opens for that consultation


WEEKLY_SCHEDULE: list[ScheduleEntry] = [
    ScheduleEntry(name="Среда", weekday=2, class_time=time(10, 30), opens_time=time(9, 30)),
    ScheduleEntry(name="Пятница", weekday=4, class_time=time(10, 30), opens_time=time(9, 30)),
]

# Size of the priority-reserved block at the top of the queue (positions 1..N).
PRIORITY_SLOTS = 5

# How often (seconds) the background reconciliation job re-checks DB state as
# a safety net, in addition to the precise cron-like triggers at opening time.
# Keeps the bot self-healing after any missed wakeup / restart / deploy.
RECONCILE_INTERVAL_SECONDS = int(os.environ.get("RECONCILE_INTERVAL_SECONDS", "900"))

# ---------------------------------------------------------------------------
# Secrets / environment
# ---------------------------------------------------------------------------
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
DATABASE_URL = os.environ.get("DATABASE_URL", "")

_admin_id_raw = os.environ.get("ADMIN_ID", "").strip()
ADMIN_ID: int | None = int(_admin_id_raw) if _admin_id_raw.isdigit() else None
