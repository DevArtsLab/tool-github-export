"""Load and validate export.config.yaml."""

from pathlib import Path

import yaml

from .models import Config

DEFAULT_CONFIG_PATH = Path("export.config.yaml")


def load_config(path: Path = DEFAULT_CONFIG_PATH) -> Config:
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {path}")
    with path.open() as f:
        raw = yaml.safe_load(f) or {}
    return Config.model_validate(raw)
