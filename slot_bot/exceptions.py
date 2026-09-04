class SlotBotError(Exception):
    """Base class for expected, user-facing error conditions."""


class ConsultationNotOpenError(SlotBotError):
    """There is no currently-open consultation to sign up for."""


class RegistrationNotOpenYetError(SlotBotError):
    """The consultation exists but its registration window hasn't opened yet."""


class UserNotRegisteredError(SlotBotError):
    """Action requires a registered user profile that doesn't exist yet."""
