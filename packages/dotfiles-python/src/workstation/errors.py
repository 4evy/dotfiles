class DotfilesError(RuntimeError):
    """A user-facing automation failure."""


class UsageError(DotfilesError):
    """Invalid command-line usage outside the main Cyclopts command tree."""
