"""Derive a stable `category` for each repository.

Categories are derived from the repo name prefix so consumers can filter on a
stable enum instead of parsing topics. Ordering matters: first matching prefix
wins, so put more specific prefixes first in the config.
"""


def derive_category(
    name: str,
    mapping: dict[str, str],
    default: str = "project",
) -> str:
    """Map a repo name to a category via configured prefixes."""
    lowered = name.lower()
    for prefix, category in mapping.items():
        if lowered.startswith(prefix.lower()):
            return category
    return default
