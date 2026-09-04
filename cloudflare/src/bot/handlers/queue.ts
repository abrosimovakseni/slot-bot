/** Handlers for the four queue-related main-menu buttons plus the inline
 * "Записаться" button attached to the opening broadcast. D1 port of
 * bot/handlers_queue.py. */
import { cancelSignup, getCurrentConsultation, getMyPosition, getQueueView, signupUser } from "../../db/queue";
import { getUser } from "../../db/users";
import { enqueuePositionChanged } from "../../notify";
import { TelegramClient } from "../../telegram";
import type { Env } from "../../types";
import * as texts from "../texts";

async function requireRegistered(env: Env, telegram: TelegramClient, chatId: number, telegramUserId: number): Promise<boolean> {
  const user = await getUser(env, telegramUserId);
  if (user === null) {
    await telegram.sendMessage(chatId, texts.NOT_REGISTERED);
    return false;
  }
  return true;
}

async function doSignup(env: Env, telegram: TelegramClient, chatId: number, telegramUserId: number, consultationId: number): Promise<void> {
  const outcome = await signupUser(env, consultationId, telegramUserId);
  switch (outcome.kind) {
    case "registration_not_open":
      await telegram.sendMessage(chatId, texts.REGISTRATION_NOT_OPEN);
      return;
    case "consultation_not_open":
      await telegram.sendMessage(chatId, texts.NO_CURRENT_CONSULTATION);
      return;
    case "user_not_registered":
      await telegram.sendMessage(chatId, texts.NOT_REGISTERED);
      return;
    case "already_signed_up":
      await telegram.sendMessage(chatId, texts.ALREADY_SIGNED_UP_HEADER(outcome.position));
      return;
    case "signed_up": {
      let message = texts.signedUpSuccess(outcome.position);
      if (outcome.statusAtSignup === "RESTRICTED") {
        message += texts.RESTRICTED_NOTICE;
      }
      await telegram.sendMessage(chatId, message);
      return;
    }
  }
}

export async function onSignupButton(env: Env, telegram: TelegramClient, chatId: number, telegramUserId: number): Promise<void> {
  if (!(await requireRegistered(env, telegram, chatId, telegramUserId))) return;
  const consultation = await getCurrentConsultation(env);
  if (consultation === null) {
    await telegram.sendMessage(chatId, texts.REGISTRATION_NOT_OPEN);
    return;
  }
  await doSignup(env, telegram, chatId, telegramUserId, consultation.id);
}

export async function onSignupCallback(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  consultationId: number,
): Promise<void> {
  if (!(await requireRegistered(env, telegram, chatId, telegramUserId))) return;
  const current = await getCurrentConsultation(env);
  if (current === null || current.id !== consultationId) {
    await telegram.sendMessage(chatId, texts.NO_CURRENT_CONSULTATION);
    return;
  }
  await doSignup(env, telegram, chatId, telegramUserId, consultationId);
}

export async function onMyPlace(env: Env, telegram: TelegramClient, chatId: number, telegramUserId: number): Promise<void> {
  if (!(await requireRegistered(env, telegram, chatId, telegramUserId))) return;
  const consultation = await getCurrentConsultation(env);
  if (consultation === null) {
    await telegram.sendMessage(chatId, texts.MY_PLACE_NOT_SIGNED_UP);
    return;
  }
  const result = await getMyPosition(env, consultation.id, telegramUserId);
  if (!result.signedUp || result.position === undefined) {
    await telegram.sendMessage(chatId, texts.MY_PLACE_NOT_SIGNED_UP);
  } else {
    await telegram.sendMessage(chatId, texts.MY_PLACE_SIGNED_UP(result.position));
  }
}

export async function onViewQueue(env: Env, telegram: TelegramClient, chatId: number, telegramUserId: number): Promise<void> {
  if (!(await requireRegistered(env, telegram, chatId, telegramUserId))) return;
  const consultation = await getCurrentConsultation(env);
  if (consultation === null) {
    await telegram.sendMessage(chatId, texts.NO_CURRENT_CONSULTATION);
    return;
  }
  const entries = await getQueueView(env, consultation.id);
  if (entries.length === 0) {
    await telegram.sendMessage(chatId, `${texts.QUEUE_HEADER}\n${texts.QUEUE_EMPTY}`);
    return;
  }
  const lines = [texts.QUEUE_HEADER, ...entries.map((e) => `${e.position}. ${e.displayName}`)];
  await telegram.sendMessage(chatId, lines.join("\n"));
}

export async function onCancel(env: Env, telegram: TelegramClient, chatId: number, telegramUserId: number): Promise<void> {
  if (!(await requireRegistered(env, telegram, chatId, telegramUserId))) return;
  const consultation = await getCurrentConsultation(env);
  if (consultation === null) {
    await telegram.sendMessage(chatId, texts.CANCEL_NOTHING_TO_CANCEL);
    return;
  }
  const result = await cancelSignup(env, consultation.id, telegramUserId);
  if (!result.hadActiveSignup) {
    await telegram.sendMessage(chatId, texts.CANCEL_NOTHING_TO_CANCEL);
    return;
  }
  await telegram.sendMessage(chatId, texts.CANCEL_DONE);
  if (result.changedPositions.size > 0) {
    await enqueuePositionChanged(env, consultation.id, result.changedPositions);
  }
}
