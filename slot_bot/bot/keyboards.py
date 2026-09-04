from telegram import InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup

from . import texts

MAIN_MENU = ReplyKeyboardMarkup(
    [
        [texts.BTN_SIGNUP],
        [texts.BTN_MY_PLACE, texts.BTN_QUEUE],
        [texts.BTN_CANCEL],
        [texts.BTN_PROFILE],
    ],
    resize_keyboard=True,
    is_persistent=True,
)


def confirm_name_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton(texts.BTN_YES, callback_data="name_confirm_yes"),
                InlineKeyboardButton(texts.BTN_EDIT, callback_data="name_confirm_edit"),
            ]
        ]
    )


def profile_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton(texts.BTN_EDIT_NAME, callback_data="profile_edit_name")]])


def signup_inline_keyboard(consultation_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton(texts.BTN_SIGNUP, callback_data=f"signup:{consultation_id}")]]
    )
