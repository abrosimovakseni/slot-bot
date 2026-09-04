"""/start and the registration flow.

The user's Telegram full_name is deliberately never used as their final
display name -- they always type it in manually and confirm it, per spec.
"""
from __future__ import annotations

import logging

from telegram import Update
from telegram.ext import (
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    ConversationHandler,
    MessageHandler,
    filters,
)

from ..services.users import get_user, register_user, sync_username
from . import keyboards, states, texts
from .context_helpers import session_factory

logger = logging.getLogger(__name__)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    tg_user = update.effective_user
    session_fac = session_factory(context)

    async with session_fac() as session:
        existing = await get_user(session, tg_user.id)

    if existing is not None:
        async with session_fac() as session:
            await sync_username(session, tg_user.id, tg_user.username)
        await update.message.reply_text(texts.WELCOME_BACK, reply_markup=keyboards.MAIN_MENU)
        return ConversationHandler.END

    await update.message.reply_text(texts.WELCOME_NEW)
    return states.ASK_NAME


async def receive_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    name = (update.message.text or "").strip()
    if not name:
        await update.message.reply_text(texts.INVALID_NAME)
        return states.ASK_NAME
    context.user_data["pending_name"] = name[:255]
    await update.message.reply_text(texts.confirm_name(name), reply_markup=keyboards.confirm_name_keyboard())
    return states.CONFIRM_NAME


async def confirm_yes(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    name = context.user_data.get("pending_name")
    if not name:
        await query.edit_message_text(texts.ASK_NAME_AGAIN)
        return states.ASK_NAME

    tg_user = update.effective_user
    session_fac = session_factory(context)
    async with session_fac() as session:
        await register_user(
            session, telegram_user_id=tg_user.id, display_name=name, username=tg_user.username
        )
    context.user_data.pop("pending_name", None)
    await query.edit_message_text(texts.REGISTRATION_DONE)
    await context.bot.send_message(chat_id=tg_user.id, text="Главное меню:", reply_markup=keyboards.MAIN_MENU)
    return ConversationHandler.END


async def confirm_edit(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    await query.edit_message_text(texts.ASK_NAME_AGAIN)
    return states.ASK_NAME


registration_conversation = ConversationHandler(
    entry_points=[CommandHandler("start", cmd_start)],
    states={
        states.ASK_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, receive_name)],
        states.CONFIRM_NAME: [
            CallbackQueryHandler(confirm_yes, pattern="^name_confirm_yes$"),
            CallbackQueryHandler(confirm_edit, pattern="^name_confirm_edit$"),
        ],
    },
    fallbacks=[CommandHandler("start", cmd_start)],
    name="registration",
)
