/**
 * Minimal Telegram Bot API client, built on plain `fetch` (Workers ships a
 * standard fetch, no SDK needed). Every "send" call reports back whether
 * the recipient has blocked the bot, so callers can mark them blocked and
 * skip them in future broadcasts -- the equivalent of the Railway version's
 * `_safe_send` catching `telegram.error.Forbidden`.
 */
import { BTN_ADMIN } from "./bot/texts";

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };

export type ReplyKeyboardMarkup = {
  keyboard: string[][];
  resize_keyboard: true;
  is_persistent: true;
};

export const MAIN_MENU_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [["Записаться"], ["Моё место", "Посмотреть очередь"], ["Отменить запись"], ["Мой профиль"]],
  resize_keyboard: true,
  is_persistent: true,
};

/** The main menu, with an extra "🛠 Админ" row for env.ADMIN_ID only. */
export function mainMenuKeyboard(isAdmin: boolean): ReplyKeyboardMarkup {
  const keyboard = MAIN_MENU_KEYBOARD.keyboard.map((row) => [...row]);
  if (isAdmin) keyboard.push([BTN_ADMIN]);
  return { keyboard, resize_keyboard: true, is_persistent: true };
}

export interface SendResult {
  ok: boolean;
  /** true if Telegram reported the user blocked the bot / deleted their account (HTTP 403). */
  blocked: boolean;
  /** true if Telegram reported the target message no longer exists (e.g. the
   * user deleted or unpinned-and-deleted it) -- distinct from a generic
   * failure so callers can tell "recreate it" apart from "just retry". */
  notFound?: boolean;
  /** message_id of the message this call created, when applicable (sendMessage). */
  messageId?: number;
}

export class TelegramClient {
  private readonly base: string;

  constructor(botToken: string) {
    this.base = `https://api.telegram.org/bot${botToken}`;
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<SendResult> {
    try {
      const resp = await fetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (resp.status === 403) {
        return { ok: false, blocked: true };
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.warn(`telegram ${method} failed: HTTP ${resp.status} ${body}`);
        return { ok: false, blocked: false };
      }
      const data = (await resp.json()) as {
        ok: boolean;
        result?: { message_id?: number };
        error_code?: number;
        description?: string;
      };
      if (!data.ok) {
        if (data.error_code === 403) {
          return { ok: false, blocked: true };
        }
        if (data.error_code === 400 && /message to (edit|delete|pin) not found/i.test(data.description ?? "")) {
          return { ok: false, blocked: false, notFound: true };
        }
        console.warn(`telegram ${method} failed: ${data.error_code} ${data.description ?? ""}`);
        return { ok: false, blocked: false };
      }
      return { ok: true, blocked: false, messageId: data.result?.message_id };
    } catch (err) {
      console.warn(`telegram ${method} threw: ${String(err)}`);
      return { ok: false, blocked: false };
    }
  }

  sendMessage(
    chatId: number,
    text: string,
    opts?: { replyMarkup?: InlineKeyboardMarkup | ReplyKeyboardMarkup },
  ): Promise<SendResult> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: opts?.replyMarkup,
    });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts?: { replyMarkup?: InlineKeyboardMarkup },
  ): Promise<SendResult> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: opts?.replyMarkup,
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<SendResult> {
    return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }

  /** Pins a message in a chat without a notification -- used to keep the
   * per-user "always visible" queue-status message pinned to the top of
   * their DM with the bot (see src/pinnedQueue.ts). */
  pinChatMessage(chatId: number, messageId: number): Promise<SendResult> {
    return this.call("pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: true });
  }

  setWebhook(url: string, secretToken: string): Promise<SendResult> {
    return this.call("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
    });
  }
}

export function confirmNameKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Да", callback_data: "name_confirm_yes" },
        { text: "Изменить", callback_data: "name_confirm_edit" },
      ],
    ],
  };
}

export function profileKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: "Изменить имя", callback_data: "profile_edit_name" }]] };
}

export function signupInlineKeyboard(consultationId: number): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: "Записаться", callback_data: `signup:${consultationId}` }]] };
}

// ---------------------------------------------------------------------------
// Admin: one-off consultations
// ---------------------------------------------------------------------------
export function adminMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "➕ Добавить консультацию", callback_data: "admin_add_start" }],
      [{ text: "🗑 Отменить консультацию", callback_data: "admin_cancel_list" }],
      [{ text: "✏️ Изменить кабинет/куратора", callback_data: "admin_edit_details_start" }],
    ],
  };
}

/** Shown right after a valid date/time is entered, so the admin can accept
 * the usual curator/room or type a one-off replacement. */
export function curatorRoomChoiceKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Как обычно", callback_data: "admin_curator_default" },
        { text: "Указать другое", callback_data: "admin_curator_custom" },
      ],
      [{ text: "◀️ Отмена", callback_data: "admin_add_cancel" }],
    ],
  };
}

/** Attached to every prompt during the "type a date/time" step, so the
 * admin can back out before (or after a failed retry of) typing anything. */
export function cancelAddConsultationKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: "◀️ Отмена", callback_data: "admin_add_cancel" }]] };
}

export function confirmCreateConsultationKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Да", callback_data: "admin_create_yes" },
        { text: "Отмена", callback_data: "admin_create_no" },
      ],
    ],
  };
}

export function cancelConsultationListKeyboard(items: Array<{ id: number; label: string }>): InlineKeyboardMarkup {
  return { inline_keyboard: items.map((it) => [{ text: it.label, callback_data: `admin_cancel_pick:${it.id}` }]) };
}

export function confirmCancelConsultationKeyboard(consultationId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Да, отменить", callback_data: `admin_cancel_yes:${consultationId}` },
        { text: "Нет", callback_data: `admin_cancel_no:${consultationId}` },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Admin: change curator/room for an existing consultation
// ---------------------------------------------------------------------------
export function editDetailsListKeyboard(items: Array<{ id: number; label: string }>): InlineKeyboardMarkup {
  return { inline_keyboard: items.map((it) => [{ text: it.label, callback_data: `admin_edit_pick:${it.id}` }]) };
}

export function confirmEditDetailsKeyboard(consultationId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Да", callback_data: `admin_edit_yes:${consultationId}` },
        { text: "Отмена", callback_data: `admin_edit_no:${consultationId}` },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Incoming webhook update shapes (only the fields we actually read).
// ---------------------------------------------------------------------------
export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
