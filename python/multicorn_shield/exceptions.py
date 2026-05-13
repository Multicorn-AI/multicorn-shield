class ShieldError(Exception):
    """Base exception for Shield client errors."""


class ShieldAuthError(ShieldError):
    """Raised when authentication fails (401/403)."""


class ShieldNotFoundError(ShieldError):
    """Raised when a resource is not found (404)."""


class ShieldAPIError(ShieldError):
    """Raised for other API errors."""

    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        super().__init__(f"Shield API error {status_code}: {message}")
