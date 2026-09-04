/**
 * Minimal Telegram Bot API client, built on plain `fetch` (Workers ships a
 * standard fetch, no SDK needed). Every "send" call reports back whether
 * the recipient has blocked the bot, so callers can mark them blocked and
 * skip them in future broadcasts -- the equivalent of the Railway version's
 * `_safe_send` catching `telegram.error.Forbidden`.
 */

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

export interface SendResult {
  ok: boolean;
  /** true if Telegram reported the user blocked the bot / deleted their account (HTTP 403). */
  blocked: boolean;
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
      const data = (await resp.json()) as { ok: boolean; error_code?: number; description?: string };
      if (!data.ok) {
        if (data.error_code === 403) {
          return { ok: false, blocked: true };
        }
        console.warn(`telegram ${method} failed: ${data.error_code} ${data.description ?? ""}`);
        return { ok: false, blocked: false };
      }
      return { ok: true, blocked: false };
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
