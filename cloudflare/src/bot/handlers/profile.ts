/**
 * Profile view + "Изменить имя" entry point. Editing the display name only
 * ever touches that one column -- telegram_user_id, history, and priority
 * status are never reset.
 */
import { setState } from "../../db/state";
import { getUser } from "../../db/users";
import { profileKeyboard, TelegramClient } from "../../telegram";
import type { Env } from "../../types";
import * as texts from "../texts";

export async function showProfile(env: Env, telegram: TelegramClient, chatId: number, telegramUserId: number): Promise<void> {
  const user = await getUser(env, telegramUserId);
  if (user === null) {
    await telegram.sendMessage(chatId, texts.NOT_REGISTERED);
    return;
  }
  await telegram.sendMessage(chatId, texts.profileCard(user.display_name, user.username), {
    replyMarkup: profileKeyboard(),
  });
}

export async function editNameEntry(env: Env, telegram: TelegramClient, chatId: number, telegramUserId: number): Promise<void> {
  await setState(env, telegramUserId, "edit", "ASK_NAME", null);
  await telegram.sendMessage(chatId, texts.ASK_NEW_NAME);
}
