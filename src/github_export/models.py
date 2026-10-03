"""Pydantic models for export configuration and output contract."""

from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = "1.0"

# ---------------------------------------------------------------------------
# Config (export.config.yaml)
# ---------------------------------------------------------------------------


class Source(BaseModel):
    type: Literal["user", "organization"]
    login: str


class Filters(BaseModel):
    include_forks: bool = True
    include_archived: bool = True
    include_templates: bool = True


class Outputs(BaseModel):
    dir: Path = Path("data")
    public_file: str = "repos.public.json"
    private_file: str = "repos.private.json"


class Override(BaseModel):
    """Manual per-repo overrides, keyed by full_name in Config.overrides."""

    display_name: str | None = None
    description: str | None = None
    category: str | None = None
    featured: bool = False
    exclude: bool = False  # hide from the public export
    tags_add: list[str] = Field(default_factory=list)


class Config(BaseModel):
    version: int = 1
    sources: list[Source] = Field(min_length=1)
    filters: Filters = Field(default_factory=Filters)
    categories: dict[str, str] = Field(default_factory=dict)
    default_category: str = "project"
    outputs: Outputs = Field(default_factory=Outputs)
    overrides: dict[str, Override] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Output contract (repos.public.json / repos.private.json)
# ---------------------------------------------------------------------------


class Language(BaseModel):
    name: str
    color: str | None = None
    bytes: int = 0
    percentage: float = 0.0


class Release(BaseModel):
    tag: str
    published_at: datetime | None = None


class RepoEntry(BaseModel):
    """One repository in the export. Field names are the stable public contract."""

    name: str
    full_name: str
    owner: str
    owner_type: Literal["User", "Organization"]
    display_name: str | None = None
    description: str | None = None
    url: str
    homepage: str | None = None
    visibility: Literal["public", "internal", "private"]
    category: str = "project"
    featured: bool = False
    tags: list[str] = Field(default_factory=list)
    primary_language: str | None = None
    languages: list[Language] = Field(default_factory=list)
    license: str | None = None
    stars: int = 0
    forks: int = 0
    watchers: int = 0
    open_issues: int = 0
    size_kb: int = 0
    is_fork: bool = False
    is_archived: bool = False
    is_template: bool = False
    forked_from: str | None = None
    default_branch: str = "main"
    created_at: datetime | None = None
    updated_at: datetime | None = None
    pushed_at: datetime | None = None
    latest_release: Release | None = None
    image_url: str | None = None

    @classmethod
    def from_node(cls, node: dict) -> "RepoEntry":
        """Normalize a GraphQL repository node into a RepoEntry (pre-override)."""
        lang_conn = node.get("languages") or {}
        total_size = lang_conn.get("totalSize") or 0
        languages = []
        for edge in lang_conn.get("edges") or []:
            size = edge.get("size") or 0
            languages.append(
                Language(
                    name=edge["node"]["name"],
                    color=edge["node"].get("color"),
                    bytes=size,
                    percentage=round(size / total_size * 100, 2) if total_size else 0.0,
                )
            )

        release = node.get("latestRelease")
        topics = [
            t["topic"]["name"]
            for t in (node.get("repositoryTopics") or {}).get("nodes") or []
        ]
        owner = node.get("owner") or {}

        return cls(
            name=node["name"],
            full_name=node["nameWithOwner"],
            owner=owner.get("login") or node["nameWithOwner"].split("/")[0],
            owner_type=owner.get("__typename") or "User",
            description=node.get("description"),
            url=node["url"],
            homepage=node.get("homepageUrl") or None,
            visibility=(node.get("visibility") or "PUBLIC").lower(),
            tags=sorted(topics),
            primary_language=(node.get("primaryLanguage") or {}).get("name"),
            languages=languages,
            license=(node.get("licenseInfo") or {}).get("spdxId"),
            stars=node.get("stargazerCount") or 0,
            forks=node.get("forkCount") or 0,
            watchers=(node.get("watchers") or {}).get("totalCount") or 0,
            open_issues=(node.get("issues") or {}).get("totalCount") or 0,
            size_kb=node.get("diskUsage") or 0,
            is_fork=node.get("isFork") or False,
            is_archived=node.get("isArchived") or False,
            is_template=node.get("isTemplate") or False,
            forked_from=(node.get("parent") or {}).get("nameWithOwner"),
            default_branch=(node.get("defaultBranchRef") or {}).get("name") or "main",
            created_at=node.get("createdAt"),
            updated_at=node.get("updatedAt"),
            pushed_at=node.get("pushedAt"),
            latest_release=(
                Release(tag=release["tagName"], published_at=release.get("publishedAt"))
                if release
                else None
            ),
            image_url=node.get("openGraphImageUrl"),
        )


class ExportStats(BaseModel):
    total: int
    public: int
    private: int
    by_category: dict[str, int] = Field(default_factory=dict)


class Export(BaseModel):
    """Top-level JSON document written to each output file."""

    schema_version: str = SCHEMA_VERSION
    generated_at: datetime
    generator: dict[str, str]
    sources: list[Source]
    stats: ExportStats
    repositories: list[RepoEntry]
