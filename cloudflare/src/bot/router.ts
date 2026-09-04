/**
 * Top-level webhook update dispatch. A Worker has no PTB-style
 * ConversationHandler to hold routing/state for it, so this replaces that:
 * a plain message/callback switch, with in-progress name-entry state read
 * from D1 (see db/state.ts) taking priority over the main-menu buttons,
 * exactly mirroring the original ConversationHandler's states.
 */
import { getState } from "../db/state";
import { TelegramClient, type TelegramCallbackQuery, type TelegramMessage, type TelegramUpdate } from "../telegram";
import type { Env } from "../types";
import {
  abortCancelConsultation,
  confirmCancelPick,
  confirmCreateConsultationNo,
  confirmCreateConsultationYes,
  executeCancelConsultation,
  isAdmin,
  receiveConsultationDateTime,
  showAdminMenu,
  showCancelList,
  startAddConsultation,
} from "./handlers/admin";
import { confirmEdit, confirmYes, receiveName } from "./handlers/nameFlow";
import { editNameEntry, showProfile } from "./handlers/profile";
import { onCancel, onMyPlace, onSignupCallback, onSignupButton, onViewQueue } from "./handlers/queue";
import { cmdStart } from "./handlers/start";
import * as texts from "./texts";

export async function routeUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const telegram = new TelegramClient(env.BOT_TOKEN);

  if (update.message !== undefined) {
    await routeMessage(env, telegram, update.message);
  } else if (update.callback_query !== undefined) {
    await routeCallback(env, telegram, update.callback_query);
  }
}

async function routeMessage(env: Env, telegram: TelegramClient, message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramUserId = message.from?.id;
  if (telegramUserId === undefined) return;
  const rawText = message.text ?? "";
  const text = rawText.trim();

  if (text === "/start") {
    await cmdStart(env, telegram, chatId, telegramUserId, message.from?.username ?? null);
    return;
  }

  // Any other slash command is left unhandled while a name-entry flow is in
  // progress, matching the original's `filters.TEXT & ~filters.COMMAND`.
  if (!text.startsWith("/")) {
    const state = await getState(env, telegramUserId);
    if (state !== null && state.state === "ASK_NAME") {
      // state.state === "ASK_NAME" is only ever set alongside flow
      // "register" or "edit" (see nameFlow.ts / start.ts / profile.ts) --
      // "admin_add" always pairs with "ASK_DATETIME"/"CONFIRM_DATETIME".
      await receiveName(env, telegram, chatId, telegramUserId, rawText, state.flow as "register" | "edit");
      return;
    }
    if (
      state !== null &&
      state.flow === "admin_add" &&
      state.state === "ASK_DATETIME" &&
      isAdmin(env, telegramUserId)
    ) {
      await receiveConsultationDateTime(env, telegram, chatId, telegramUserId, rawText);
      return;
    }
  }

  switch (text) {
    case texts.BTN_SIGNUP:
      await onSignupButton(env, telegram, chatId, telegramUserId);
      return;
    case texts.BTN_MY_PLACE:
      await onMyPlace(env, telegram, chatId, telegramUserId);
      return;
    case texts.BTN_QUEUE:
      await onViewQueue(env, telegram, chatId, telegramUserId);
      return;
    case texts.BTN_CANCEL:
      await onCancel(env, telegram, chatId, telegramUserId);
      return;
    case texts.BTN_PROFILE:
      await showProfile(env, telegram, chatId, telegramUserId);
      return;
    case texts.BTN_ADMIN:
      if (isAdmin(env, telegramUserId)) {
        await showAdminMenu(env, telegram, chatId);
      }
      return;
    default:
      return; // unrecognized text -- silently ignored, same as no PTB handler matching
  }
}

async function routeCallback(env: Env, telegram: TelegramClient, cq: TelegramCallbackQuery): Promise<void> {
  await telegram.answerCallbackQuery(cq.id);

  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const telegramUserId = cq.from.id;
  const data = cq.data ?? "";
  if (chatId === undefined || messageId === undefined) return;

  if (data === "name_confirm_yes") {
    await confirmYes(env, telegram, chatId, telegramUserId, cq.from.username ?? null, messageId);
    return;
  }
  if (data === "name_confirm_edit") {
    await confirmEdit(env, telegram, chatId, telegramUserId, messageId);
    return;
  }
  if (data === "profile_edit_name") {
    await editNameEntry(env, telegram, chatId, telegramUserId);
    return;
  }
  if (data.startsWith("signup:")) {
    const consultationId = Number(data.slice("signup:".length));
    if (Number.isFinite(consultationId)) {
      await onSignupCallback(env, telegram, chatId, telegramUserId, consultationId);
    }
    return;
  }

  // Admin-only callbacks (see bot/handlers/admin.ts) -- every one re-checks
  // isAdmin() itself, never trusting that only the admin could have sent
  // this callback_data.
  if (!isAdmin(env, telegramUserId)) return;

  if (data === "admin_add_start") {
    await startAddConsultation(env, telegram, chatId, telegramUserId);
    return;
  }
  if (data === "admin_create_yes") {
    await confirmCreateConsultationYes(env, telegram, chatId, telegramUserId, messageId);
    return;
  }
  if (data === "admin_create_no") {
    await confirmCreateConsultationNo(env, telegram, chatId, telegramUserId, messageId);
    return;
  }
  if (data === "admin_cancel_list") {
    await showCancelList(env, telegram, chatId);
    return;
  }
  if (data.startsWith("admin_cancel_pick:")) {
    const consultationId = Number(data.slice("admin_cancel_pick:".length));
    if (Number.isFinite(consultationId)) {
      await confirmCancelPick(env, telegram, chatId, messageId, consultationId);
    }
    return;
  }
  if (data.startsWith("admin_cancel_yes:")) {
    const consultationId = Number(data.slice("admin_cancel_yes:".length));
    if (Number.isFinite(consultationId)) {
      await executeCancelConsultation(env, telegram, chatId, messageId, consultationId);
    }
    return;
  }
  if (data.startsWith("admin_cancel_no")) {
    await abortCancelConsultation(env, telegram, chatId, messageId);
    return;
  }
}
