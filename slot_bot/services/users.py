"""User registration and profile management."""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import PriorityStatus, User


@dataclass
class RegisterResult:
    user: User
    already_existed: bool


async def get_user(session: AsyncSession, telegram_user_id: int) -> User | None:
    return await session.get(User, telegram_user_id)


async def register_user(
    session: AsyncSession,
    *,
    telegram_user_id: int,
    display_name: str,
    username: str | None,
) -> RegisterResult:
    """Create the user's profile if it doesn't exist yet.

    If the user already exists, their profile (and priority status,
    history, etc.) is left untouched -- registering twice is a no-op that
    just returns the existing profile.
    """
    async with session.begin():
        existing = await session.get(User, telegram_user_id)
        if existing is not None:
            return RegisterResult(user=existing, already_existed=True)
        user = User(
            telegram_user_id=telegram_user_id,
            display_name=display_name,
            username=username,
            priority_status=PriorityStatus.PRIORITY.value,
        )
        session.add(user)
        await session.flush()
        return RegisterResult(user=user, already_existed=False)


async def update_display_name(session: AsyncSession, telegram_user_id: int, new_name: str) -> User:
    """Change the display name shown to other people.

    Never touches telegram_user_id, priority_status, history, or signups --
    only the display_name column.
    """
    async with session.begin():
        user = await session.get(User, telegram_user_id)
        if user is None:
            raise ValueError(f"user {telegram_user_id} not registered")
        user.display_name = new_name
        await session.flush()
        return user


async def sync_username(session: AsyncSession, telegram_user_id: int, username: str | None) -> None:
    """Keep the cached @username in sync with Telegram (best-effort, called
    opportunistically on every interaction). Never touches display_name."""
    async with session.begin():
        user = await session.get(User, telegram_user_id)
        if user is not None and user.username != username:
            user.username = username


async def mark_blocked(session: AsyncSession, telegram_user_id: int, blocked: bool = True) -> None:
    async with session.begin():
        user = await session.get(User, telegram_user_id)
        if user is not None:
            user.blocked = blocked


async def all_reachable_users(session: AsyncSession) -> list[User]:
    result = await session.execute(select(User).where(User.blocked.is_(False)))
    return list(result.scalars().all())
