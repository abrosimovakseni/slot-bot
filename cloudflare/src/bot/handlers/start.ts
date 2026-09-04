/**
 * /start and the registration entry point. The user's Telegram first_name
 * is deliberately never used as their display name -- they always type it
 * in manually and confirm it (see nameFlow.ts), per spec.
 */
import { clearState } from "../../db/state";
import { getUser, syncUsername } from "../../db/users";
import { setState } from "../../db/state";
import { MAIN_MENU_KEYBOARD, TelegramClient } from "../../telegram";
import type { Env } from "../../types";
import * as texts from "../texts";

export async function cmdStart(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  username: string | null,
): Promise<void> {
  const existing = await getUser(env, telegramUserId);
  if (existing !== null) {
    await syncUsername(env, telegramUserId, username);
    await clearState(env, telegramUserId); // /start also cancels any stray in-progress flow
    await telegram.sendMessage(chatId, texts.WELCOME_BACK, { replyMarkup: MAIN_MENU_KEYBOARD });
    return;
  }
  await setState(env, telegramUserId, "register", "ASK_NAME", null);
  await telegram.sendMessage(chatId, texts.WELCOME_NEW);
}
