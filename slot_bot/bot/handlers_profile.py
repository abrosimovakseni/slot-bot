"""Profile view + "Изменить имя" (edit display name) flow.

Editing the display name only ever touches the display_name column -- it
never resets history, priority status, or the Telegram user id, which
remains the durable identity key throughout.
"""
from __future__ import annotations

import re

from telegram import Update
from telegram.ext import (
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    ConversationHandler,
    MessageHandler,
    filters,
)

from ..services.users import get_user, update_display_name
from . import keyboards, states, texts
from .context_helpers import session_factory
from .handlers_start import cmd_start

_PROFILE_BUTTON_RE = re.compile(f"^{re.escape(texts.BTN_PROFILE)}$")


async def show_profile(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    session_fac = session_factory(context)
    async with session_fac() as session:
        user = await get_user(session, update.effective_user.id)
    if user is None:
        await update.message.reply_text(texts.NOT_REGISTERED)
        return
    await update.message.reply_text(
        texts.profile_card(user.display_name, user.username), reply_markup=keyboards.profile_keyboard()
    )


profile_handler = MessageHandler(_PROFILE_BUTTON_RE, show_profile)


async def edit_name_entry(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    await query.message.reply_text(texts.ASK_NEW_NAME)
    return states.ASK_NAME


async def edit_name_receive(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    name = (update.message.text or "").strip()
    if not name:
        await update.message.reply_text(texts.INVALID_NAME)
        return states.ASK_NAME
    context.user_data["pending_edit_name"] = name[:255]
    await update.message.reply_text(texts.confirm_name(name), reply_markup=keyboards.confirm_name_keyboard())
    return states.CONFIRM_NAME


async def edit_name_confirm_yes(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    name = context.user_data.pop("pending_edit_name", None)
    if not name:
        await query.edit_message_text(texts.ASK_NAME_AGAIN)
        return states.ASK_NAME
    session_fac = session_factory(context)
    async with session_fac() as session:
        await update_display_name(session, update.effective_user.id, name)
    await query.edit_message_text(texts.NAME_UPDATED)
    return ConversationHandler.END


async def edit_name_confirm_edit(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    await query.edit_message_text(texts.ASK_NAME_AGAIN)
    return states.ASK_NAME


edit_name_conversation = ConversationHandler(
    entry_points=[CallbackQueryHandler(edit_name_entry, pattern="^profile_edit_name$")],
    states={
        states.ASK_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, edit_name_receive)],
        states.CONFIRM_NAME: [
            CallbackQueryHandler(edit_name_confirm_yes, pattern="^name_confirm_yes$"),
            CallbackQueryHandler(edit_name_confirm_edit, pattern="^name_confirm_edit$"),
        ],
    },
    fallbacks=[CommandHandler("start", cmd_start)],
    name="edit_name",
)
