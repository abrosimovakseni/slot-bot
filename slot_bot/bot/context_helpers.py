"""Small helper to pull shared objects out of PTB's `context`."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from telegram.ext import ContextTypes


def session_factory(context: ContextTypes.DEFAULT_TYPE) -> async_sessionmaker[AsyncSession]:
    return context.application.bot_data["session_factory"]
