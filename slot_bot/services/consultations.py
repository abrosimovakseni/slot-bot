"""
Consultation lifecycle: creating/opening the weekly slots, finalizing them
the next day, and reconciling all of that against whatever's actually in
the database (which is what makes the bot safe to restart at any time).

IDEMPOTENCY
--------------------------------------------------------------------------
Both "opening" a consultation (broadcasting the notification) and
"finalizing" one (toggling everyone's PRIORITY/RESTRICTED status) use the
same pattern: an atomic claim via

    UPDATE consultations SET <marker> = now() WHERE id = :id AND <marker> IS NULL
    RETURNING id

Only the caller that receives a row back actually proceeds to do the
one-time work (send messages / toggle statuses). Every other caller --
whether it's a concurrent scheduler tick, a duplicate manual retry, or the
same job re-run after a crash mid-way -- sees zero rows and does nothing.
This is what makes TEST 17 (finalize run twice) and the "no double
broadcast on restart" requirement hold even under real concurrency, not
just when called sequentially.

RESTART RECOVERY
--------------------------------------------------------------------------
`reconcile()` is the single entry point that makes the bot self-healing.
It is called once at startup and then on a repeating timer (see
bot/app.py) so that no matter how long the process was down for, it always
converges to the correct state:

  1. Any consultation whose calendar date (Europe/Moscow) is in the past
     and hasn't been finalized yet gets finalized.
  2. For each entry in the weekly schedule, if this week's occurrence's
     opening time has already passed, the consultation is created (if it
     doesn't exist yet) and opened (broadcast sent) -- both idempotently.

Nothing here depends on an in-memory scheduler having "remembered" what it
already did; the source of truth is always the database.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.sql import func

from ..config import MOSCOW_TZ, ScheduleEntry
from ..models import Consultation, PriorityStatus, Signup, User
from ..time_utils import all_week_occurrences, now_utc


def _toggle(status: str) -> str:
    return (
        PriorityStatus.RESTRICTED.value
        if status == PriorityStatus.PRIORITY.value
        else PriorityStatus.PRIORITY.value
    )


# ---------------------------------------------------------------------------
# Finalization
# ---------------------------------------------------------------------------
@dataclass
class FinalizeResult:
    already_finalized: bool
    toggled_user_ids: list[int] = field(default_factory=list)


async def finalize_consultation(session: AsyncSession, consultation_id: int) -> FinalizeResult:
    async with session.begin():
        claim = await session.execute(
            update(Consultation)
            .where(Consultation.id == consultation_id, Consultation.finalized_at.is_(None))
            .values(finalized_at=func.now())
            .returning(Consultation.id)
        )
        if claim.scalar_one_or_none() is None:
            return FinalizeResult(already_finalized=True)

        result = await session.execute(
            select(Signup).where(Signup.consultation_id == consultation_id, Signup.active.is_(True))
        )
        signups = list(result.scalars().all())

        toggled: list[int] = []
        for signup in signups:
            user = await session.get(User, signup.user_id, with_for_update=True)
            if user is None:
                continue
            user.priority_status = _toggle(user.priority_status)
            signup.counted_for_status = True
            toggled.append(user.telegram_user_id)

        return FinalizeResult(already_finalized=False, toggled_user_ids=toggled)


# ---------------------------------------------------------------------------
# Creation + opening
# ---------------------------------------------------------------------------
@dataclass
class EnsureResult:
    consultation_id: int
    created: bool
    just_opened: bool


async def ensure_created_and_opened(
    session: AsyncSession, entry: ScheduleEntry, scheduled_at, opens_at
) -> EnsureResult:
    async with session.begin():
        existing = await session.execute(
            select(Consultation).where(Consultation.scheduled_at == scheduled_at).with_for_update()
        )
        consultation = existing.scalar_one_or_none()
        created = False

        if consultation is None:
            # Use a SAVEPOINT (begin_nested) for the insert attempt: if two
            # reconcile ticks race to create the same slot, the loser's
            # INSERT blocks on the UNIQUE(scheduled_at) constraint until the
            # winner commits, then raises IntegrityError -- caught here and
            # rolled back to just the savepoint, leaving the outer
            # transaction perfectly usable to re-fetch the winner's row.
            try:
                async with session.begin_nested():
                    consultation = Consultation(
                        label=entry.name,
                        scheduled_at=scheduled_at,
                        registration_opens_at=opens_at,
                    )
                    session.add(consultation)
                    await session.flush()
                created = True
            except IntegrityError:
                refetch = await session.execute(
                    select(Consultation).where(Consultation.scheduled_at == scheduled_at).with_for_update()
                )
                consultation = refetch.scalar_one()

        just_opened = await _claim_opening(session, consultation.id)
        return EnsureResult(consultation_id=consultation.id, created=created, just_opened=just_opened)


async def _claim_opening(session: AsyncSession, consultation_id: int) -> bool:
    claim = await session.execute(
        update(Consultation)
        .where(Consultation.id == consultation_id, Consultation.opened_notified_at.is_(None))
        .values(opened_notified_at=func.now())
        .returning(Consultation.id)
    )
    return claim.scalar_one_or_none() is not None


# ---------------------------------------------------------------------------
# Reconciliation (restart recovery + safety-net polling)
# ---------------------------------------------------------------------------
@dataclass
class ReconcileReport:
    finalized: list[FinalizeResult] = field(default_factory=list)
    opened: list[EnsureResult] = field(default_factory=list)


async def reconcile(
    session_factory: async_sessionmaker[AsyncSession], now=None
) -> ReconcileReport:
    now = now or now_utc()
    report = ReconcileReport()
    today_msk = now.astimezone(MOSCOW_TZ).date()

    # 1. Finalize anything whose consultation date is strictly in the past.
    async with session_factory() as session:
        result = await session.execute(
            select(Consultation.id, Consultation.scheduled_at).where(Consultation.finalized_at.is_(None))
        )
        due_ids = [
            cid for cid, scheduled_at in result.all() if scheduled_at.astimezone(MOSCOW_TZ).date() < today_msk
        ]

    for consultation_id in due_ids:
        async with session_factory() as session:
            fr = await finalize_consultation(session, consultation_id)
            if not fr.already_finalized:
                report.finalized.append(fr)

    # 2. Create/open this week's occurrences that are due.
    #
    # Two conditions, both required:
    #   * `now >= opens_at`      -- the opening moment has arrived/passed.
    #   * today's Moscow date is not AFTER the consultation's own date --
    #     i.e. we only ever catch up *within* the consultation's own day.
    #     Without this second check, reconciling for the first time on
    #     Friday would also retroactively create Wednesday's slot (its
    #     opens_at is also "in the past" relative to Friday) even though
    #     that class already happened days ago and nobody could sign up
    #     for it anyway. Once a day has fully passed without the bot
    #     creating that slot, it's simply skipped -- correct, since a
    #     consultation students could never have signed up for is not
    #     worth manufacturing after the fact.
    #
    # A third, finer-grained bound applies only to brand-new rows: if this
    # exact slot has never been created yet AND the class time itself
    # (`scheduled_at`) has already passed today, don't manufacture it either
    # -- e.g. the bot's very first-ever startup happening at 15:00 on a
    # Friday must not open registration for the 10:30 class that already
    # happened that same morning. This does NOT apply once a row already
    # exists (a mid-day restart must still recognize and, if needed,
    # finish opening a consultation it created earlier that same day).
    for entry, scheduled_at, opens_at in all_week_occurrences(now):
        if now < opens_at:
            continue
        if now.astimezone(MOSCOW_TZ).date() > scheduled_at.astimezone(MOSCOW_TZ).date():
            continue
        async with session_factory() as session:
            already_exists = await session.scalar(
                select(Consultation.id).where(Consultation.scheduled_at == scheduled_at)
            )
        if already_exists is None and now >= scheduled_at:
            continue
        async with session_factory() as session:
            er = await ensure_created_and_opened(session, entry, scheduled_at, opens_at)
            if er.created or er.just_opened:
                report.opened.append(er)

    return report
