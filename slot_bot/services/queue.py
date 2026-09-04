"""
The queue: signup, cancellation, and position computation.

THE ALGORITHM (see README for the human-readable version of these rules)
--------------------------------------------------------------------------
Given all *active* signups for a consultation, ordered by ``id`` ascending
(== the exact order people clicked "Записаться", since PostgreSQL assigns
identity values atomically and monotonically on INSERT):

1. Walk that list and pick out signups whose ``status_at_signup`` is
   PRIORITY, in order. The first ``PRIORITY_SLOTS`` (5) of those get
   positions 1..5, in the order they signed up.
2. Positions 1..5 are *reserved* for PRIORITY signups: a RESTRICTED signup
   can never occupy them, even if it was the very first click. If fewer
   than 5 PRIORITY people have signed up, the remaining slots in 1..5 stay
   reserved/empty rather than being backfilled by RESTRICTED users.
3. Every remaining signup (RESTRICTED signups, plus any PRIORITY signups
   past the first five) is ordered by signup time (``id``) and placed
   starting at position 6, with no further advantage for PRIORITY status.

This is a pure function of the signup list, so it's trivial to unit test in
isolation (tests/test_queue_positions.py) without touching a database.

CONCURRENCY SAFETY
--------------------------------------------------------------------------
``signup_user`` and ``cancel_signup`` both begin by taking a
``SELECT ... FOR UPDATE`` row lock on the parent ``consultations`` row.
That serializes *all* queue-mutating operations for one consultation through
Postgres's row-lock queue: two people clicking "Записаться" (or one
clicking cancel while another clicks signup) at the exact same instant are
handled one at a time, in whatever order Postgres grants the lock, and each
one sees a fully consistent snapshot to compute positions from. Operations
on *different* consultations never block each other.

On top of that, a partial unique index in the schema
(``consultation_id, user_id`` where ``active``) makes a duplicate active
signup for the same user impossible at the database level even if the
locking above were ever bypassed by a bug -- belt and suspenders.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import PRIORITY_SLOTS
from ..exceptions import ConsultationNotOpenError, RegistrationNotOpenYetError, UserNotRegisteredError
from ..models import Consultation, PriorityStatus, Signup, User
from ..time_utils import now_utc


# ---------------------------------------------------------------------------
# Pure position algorithm
# ---------------------------------------------------------------------------
def compute_positions(signups: list[Signup]) -> dict[int, int]:
    """signups: active signups for one consultation, any order.
    Returns {signup.id: position (1-based)}."""
    ordered = sorted(signups, key=lambda s: s.id)
    priority_in_order = [s for s in ordered if s.status_at_signup == PriorityStatus.PRIORITY.value]
    reserved = priority_in_order[:PRIORITY_SLOTS]
    reserved_ids = {s.id for s in reserved}

    positions: dict[int, int] = {}
    for pos, s in enumerate(reserved, start=1):
        positions[s.id] = pos

    pos = PRIORITY_SLOTS + 1
    for s in ordered:
        if s.id in reserved_ids:
            continue
        positions[s.id] = pos
        pos += 1
    return positions


# ---------------------------------------------------------------------------
# Loading helpers
# ---------------------------------------------------------------------------
async def _lock_consultation(session: AsyncSession, consultation_id: int) -> Consultation | None:
    """Take a row lock on the consultation, serializing concurrent
    signup/cancel calls for it. Must be called inside an open transaction."""
    result = await session.execute(
        select(Consultation).where(Consultation.id == consultation_id).with_for_update()
    )
    return result.scalar_one_or_none()


async def _load_active_signups(session: AsyncSession, consultation_id: int) -> list[Signup]:
    result = await session.execute(
        select(Signup)
        .where(Signup.consultation_id == consultation_id, Signup.active.is_(True))
        .order_by(Signup.id)
    )
    return list(result.scalars().all())


# ---------------------------------------------------------------------------
# Signup
# ---------------------------------------------------------------------------
@dataclass
class SignupResult:
    already_signed_up: bool
    position: int
    status_at_signup: str
    signup_id: int


async def signup_user(session: AsyncSession, consultation_id: int, telegram_user_id: int) -> SignupResult:
    async with session.begin():
        consultation = await _lock_consultation(session, consultation_id)
        if consultation is None or consultation.finalized_at is not None:
            raise ConsultationNotOpenError()
        if now_utc() < consultation.registration_opens_at:
            raise RegistrationNotOpenYetError()

        before = await _load_active_signups(session, consultation_id)
        existing = next((s for s in before if s.user_id == telegram_user_id), None)
        if existing is not None:
            positions = compute_positions(before)
            return SignupResult(
                already_signed_up=True,
                position=positions[existing.id],
                status_at_signup=existing.status_at_signup,
                signup_id=existing.id,
            )

        user = await session.get(User, telegram_user_id)
        if user is None:
            raise UserNotRegisteredError()

        new_signup = Signup(
            consultation_id=consultation_id,
            user_id=telegram_user_id,
            status_at_signup=user.priority_status,
            active=True,
        )
        session.add(new_signup)
        # Note: the FOR UPDATE lock on the consultation row above already
        # serializes every signup/cancel for this consultation, so by the
        # time we get here `before` is guaranteed fresh and this insert
        # cannot collide with a concurrent one for the same user. The
        # partial unique index in the schema still backstops this at the
        # database level; if it were ever violated it would raise
        # IntegrityError here, which callers treat as a generic failure
        # (log + ask the user to retry) rather than silent data corruption.
        await session.flush()

        after = before + [new_signup]
        positions_after = compute_positions(after)
        return SignupResult(
            already_signed_up=False,
            position=positions_after[new_signup.id],
            status_at_signup=new_signup.status_at_signup,
            signup_id=new_signup.id,
        )


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------
@dataclass
class CancelResult:
    had_active_signup: bool
    # user_id -> new position, only for users whose position actually changed
    changed_positions: dict[int, int] = field(default_factory=dict)


async def cancel_signup(session: AsyncSession, consultation_id: int, telegram_user_id: int) -> CancelResult:
    async with session.begin():
        consultation = await _lock_consultation(session, consultation_id)
        if consultation is None or consultation.finalized_at is not None:
            # A finalized consultation has already had its statuses
            # toggled and is no longer "current" (get_current_consultation
            # excludes it); nothing meaningful to cancel from it.
            return CancelResult(had_active_signup=False)

        before = await _load_active_signups(session, consultation_id)
        target = next((s for s in before if s.user_id == telegram_user_id), None)
        if target is None:
            return CancelResult(had_active_signup=False)

        positions_before = compute_positions(before)
        target.active = False
        target.cancelled_at = now_utc()
        await session.flush()

        after = [s for s in before if s.id != target.id]
        positions_after = compute_positions(after)

        changed: dict[int, int] = {}
        for s in after:
            old_pos = positions_before.get(s.id)
            new_pos = positions_after.get(s.id)
            if old_pos != new_pos:
                changed[s.user_id] = new_pos
        return CancelResult(had_active_signup=True, changed_positions=changed)


# ---------------------------------------------------------------------------
# Read-only views
# ---------------------------------------------------------------------------
@dataclass
class QueueEntry:
    position: int
    user_id: int
    display_name: str
    is_placeholder: bool = False


async def get_queue_view(session: AsyncSession, consultation_id: int) -> list[QueueEntry]:
    """Full queue for display, including "Свободно" placeholders for any
    still-unfilled reserved PRIORITY slots in 1..PRIORITY_SLOTS."""
    result = await session.execute(
        select(Signup, User)
        .join(User, User.telegram_user_id == Signup.user_id)
        .where(Signup.consultation_id == consultation_id, Signup.active.is_(True))
        .order_by(Signup.id)
    )
    rows = result.all()
    signups = [s for s, _ in rows]
    names = {s.id: u.display_name for s, u in rows}
    user_ids = {s.id: s.user_id for s in signups}

    positions = compute_positions(signups)
    filled_reserved = sum(1 for s in signups if positions.get(s.id, 999) <= PRIORITY_SLOTS)

    entries: list[QueueEntry] = []
    for pos in range(1, PRIORITY_SLOTS + 1):
        sid = next((s.id for s in signups if positions.get(s.id) == pos), None)
        if sid is not None:
            entries.append(QueueEntry(position=pos, user_id=user_ids[sid], display_name=names[sid]))
        elif pos <= filled_reserved:
            continue
        else:
            entries.append(QueueEntry(position=pos, user_id=0, display_name="Свободно", is_placeholder=True))

    rest = sorted(
        (s for s in signups if positions.get(s.id, 0) > PRIORITY_SLOTS),
        key=lambda s: positions[s.id],
    )
    for s in rest:
        entries.append(QueueEntry(position=positions[s.id], user_id=s.user_id, display_name=names[s.id]))

    return entries


@dataclass
class MyPositionResult:
    signed_up: bool
    position: int | None = None
    status_at_signup: str | None = None


async def get_my_position(session: AsyncSession, consultation_id: int, telegram_user_id: int) -> MyPositionResult:
    signups = await _load_active_signups(session, consultation_id)
    mine = next((s for s in signups if s.user_id == telegram_user_id), None)
    if mine is None:
        return MyPositionResult(signed_up=False)
    positions = compute_positions(signups)
    return MyPositionResult(
        signed_up=True, position=positions[mine.id], status_at_signup=mine.status_at_signup
    )


async def get_current_consultation(session: AsyncSession) -> Consultation | None:
    """The most recent not-yet-finalized consultation, or None if none
    exists (before the first opening of the week, or after the last one of
    the week has been finalized and the next hasn't been created yet)."""
    result = await session.execute(
        select(Consultation)
        .where(Consultation.finalized_at.is_(None))
        .order_by(Consultation.scheduled_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()
