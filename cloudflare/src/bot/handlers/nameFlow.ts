/**
 * Shared "ask name -> confirm" flow, used by both registration (/start for
 * a new user) and editing the display name from the profile card. Both
 * flows share an identical two-step shape in the Railway version (separate
 * ConversationHandlers with duplicated states); here they're unified into
 * one flow parameterized by `flow: "register" | "edit"`, with the final
 * action (create the user vs. just rename them) branching at the end --
 * less duplication, identical externally-visible behavior.
 */
import { clearState, getState, setState } from "../../db/state";
import { registerUser, updateDisplayName } from "../../db/users";
import { confirmNameKeyboard, mainMenuKeyboard, TelegramClient } from "../../telegram";
import type { Env } from "../../types";
import * as texts from "../texts";
import { isAdmin } from "./admin";

export async function receiveName(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  rawText: string,
  flow: "register" | "edit",
): Promise<void> {
  const name = rawText.trim();
  if (!name) {
    await telegram.sendMessage(chatId, texts.INVALID_NAME);
    return;
  }
  await setState(env, telegramUserId, flow, "CONFIRM_NAME", name.slice(0, 255));
  await telegram.sendMessage(chatId, texts.confirmName(name), { replyMarkup: confirmNameKeyboard() });
}

export async function confirmYes(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  username: string | null,
  messageId: number,
): Promise<void> {
  const state = await getState(env, telegramUserId);
  if (state === null || state.pending_name === null) {
    await telegram.editMessageText(chatId, messageId, texts.ASK_NAME_AGAIN);
    return;
  }
  const name = state.pending_name;

  if (state.flow === "register") {
    await registerUser(env, telegramUserId, name, username);
    await clearState(env, telegramUserId);
    await telegram.editMessageText(chatId, messageId, texts.REGISTRATION_DONE);
    await telegram.sendMessage(chatId, "Главное меню:", {
      replyMarkup: mainMenuKeyboard(isAdmin(env, telegramUserId)),
    });
  } else {
    await updateDisplayName(env, telegramUserId, name);
    await clearState(env, telegramUserId);
    await telegram.editMessageText(chatId, messageId, texts.NAME_UPDATED);
  }
}

export async function confirmEdit(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  const state = await getState(env, telegramUserId);
  const flow = state?.flow ?? "register";
  await setState(env, telegramUserId, flow, "ASK_NAME", null);
  await telegram.editMessageText(chatId, messageId, texts.ASK_NAME_AGAIN);
}
