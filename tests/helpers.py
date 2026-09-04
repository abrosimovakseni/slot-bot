"""Small factories shared by the test suite."""
from __future__ import annotations

import datetime

from slot_bot.models import Consultation, PriorityStatus, User
from slot_bot.services.users import register_user


async def make_user(
    session_factory, user_id: int, name: str = "Тест Тестов", status: str = PriorityStatus.PRIORITY.value
) -> None:
    async with session_factory() as session:
        await register_user(session, telegram_user_id=user_id, display_name=name, username=None)
    if status != PriorityStatus.PRIORITY.value:
        async with session_factory() as session, session.begin():
            user = await session.get(User, user_id)
            user.priority_status = status


async def create_open_consultation(session_factory, scheduled_at: datetime.datetime | None = None) -> int:
    """A consultation whose registration window is already open (opened
    one minute ago) and which is not yet finalized -- ready to sign up for
    immediately, which is what almost every queue test needs."""
    now = datetime.datetime.now(datetime.timezone.utc)
    scheduled_at = scheduled_at or (now + datetime.timedelta(hours=1))
    opens_at = now - datetime.timedelta(minutes=1)
    async with session_factory() as session, session.begin():
        consultation = Consultation(label="test", scheduled_at=scheduled_at, registration_opens_at=opens_at)
        session.add(consultation)
        await session.flush()
        return consultation.id


async def create_unopened_consultation(session_factory, scheduled_at: datetime.datetime | None = None) -> int:
    """A consultation that exists but whose registration window has not
    opened yet."""
    now = datetime.datetime.now(datetime.timezone.utc)
    scheduled_at = scheduled_at or (now + datetime.timedelta(hours=1))
    opens_at = now + datetime.timedelta(minutes=30)
    async with session_factory() as session, session.begin():
        consultation = Consultation(label="test", scheduled_at=scheduled_at, registration_opens_at=opens_at)
        session.add(consultation)
        await session.flush()
        return consultation.id


async def get_user_status(session_factory, user_id: int) -> str:
    async with session_factory() as session:
        user = await session.get(User, user_id)
        return user.priority_status
