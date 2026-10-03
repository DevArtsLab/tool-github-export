"""Export orchestration: fetch, normalize, apply overrides, split, write."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import __version__
from .categorize import derive_category
from .client import GitHubClient
from .models import Config, Export, ExportStats, RepoEntry


def apply_overrides(entry: RepoEntry, config: Config) -> RepoEntry:
    """Apply config overrides and derived fields to a repo entry."""
    override = config.overrides.get(entry.full_name)

    entry.category = derive_category(
        entry.name, config.categories, config.default_category
    )
    if override:
        if override.display_name:
            entry.display_name = override.display_name
        if override.description:
            entry.description = override.description
        if override.category:
            entry.category = override.category
        entry.featured = override.featured
        if override.tags_add:
            entry.tags = sorted(set(entry.tags) | set(override.tags_add))
    if entry.display_name is None:
        entry.display_name = entry.name.replace("-", " ").replace("_", " ").title()
    return entry


def passes_filters(node: dict[str, Any], config: Config) -> bool:
    """Decide whether a raw repo node belongs in the export at all."""
    if node.get("isDisabled") or node.get("isLocked"):
        return False
    if node.get("isFork") and not config.filters.include_forks:
        return False
    if node.get("isArchived") and not config.filters.include_archived:
        return False
    return not (node.get("isTemplate") and not config.filters.include_templates)


def fetch_entries(client: GitHubClient, config: Config) -> list[RepoEntry]:
    entries: list[RepoEntry] = []
    seen: set[str] = set()
    for source in config.sources:
        _, nodes = client.iter_repositories(source.login)
        for node in nodes:
            if not passes_filters(node, config):
                continue
            entry = apply_overrides(RepoEntry.from_node(node), config)
            if entry.full_name in seen:
                continue
            seen.add(entry.full_name)
            entries.append(entry)

    entries.sort(key=lambda e: (e.pushed_at or datetime.min.replace(tzinfo=UTC)), reverse=True)
    return entries


def build_export(entries: list[RepoEntry], config: Config, public_only: bool) -> Export:
    excluded = {
        name for name, o in config.overrides.items() if o.exclude
    }
    repos = [
        e
        for e in entries
        if (not public_only or (e.visibility == "public" and e.full_name not in excluded))
    ]

    by_category: dict[str, int] = {}
    for e in repos:
        by_category[e.category] = by_category.get(e.category, 0) + 1

    return Export(
        generated_at=datetime.now(UTC),
        generator={"name": "tool-github-export", "version": __version__},
        sources=config.sources,
        stats=ExportStats(
            total=len(repos),
            public=sum(1 for e in repos if e.visibility == "public"),
            private=sum(1 for e in repos if e.visibility != "public"),
            by_category=by_category,
        ),
        repositories=repos,
    )


def write_export(export: Export, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(export.model_dump(mode="json", exclude_none=True), indent=2)
        + "\n"
    )
    tmp.replace(path)
    return path


def run_export(
    client: GitHubClient,
    config: Config,
    out_dir: Path | None = None,
    public_only: bool = False,
    private_only: bool = False,
) -> dict[str, Path]:
    """Full pipeline. Returns {kind: path} of files written."""
    entries = fetch_entries(client, config)
    out_dir = out_dir or config.outputs.dir
    written: dict[str, Path] = {}

    if not private_only:
        public = build_export(entries, config, public_only=True)
        written["public"] = write_export(public, out_dir / config.outputs.public_file)
    if not public_only:
        private = build_export(entries, config, public_only=False)
        written["private"] = write_export(private, out_dir / config.outputs.private_file)

    return written
