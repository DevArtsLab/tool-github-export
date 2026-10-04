"""Minimal GitHub GraphQL client with pagination and retry."""

from __future__ import annotations

import subprocess
from typing import Any

import httpx

from .queries import REPOSITORIES_QUERY

API_URL = "https://api.github.com/graphql"


class GitHubClientError(RuntimeError):
    pass


def resolve_token(explicit: str | None = None) -> str:
    """Resolve a GitHub token: explicit arg, then env, then `gh auth token`."""
    import os

    if explicit:
        return explicit
    for var in ("GH_EXPORT_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        if token := os.environ.get(var):
            return token
    try:
        result = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    raise GitHubClientError(
        "No GitHub token found. Pass --token, set GH_EXPORT_TOKEN/GH_TOKEN, "
        "or authenticate the gh CLI."
    )


class GitHubClient:
    def __init__(self, token: str, timeout: float = 30.0) -> None:
        # NOTE: do not send REST-only headers (e.g. X-GitHub-Api-Version); they
        # route the request to the REST API and /graphql 404s.
        self._http = httpx.Client(
            headers={"Authorization": f"bearer {token}"},
            timeout=timeout,
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "GitHubClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        resp = self._http.post(
            API_URL, json={"query": query, "variables": variables}
        )
        if resp.status_code != 200:
            raise GitHubClientError(
                f"GitHub API returned HTTP {resp.status_code}: {resp.text[:300]}"
            )
        payload = resp.json()
        if errors := payload.get("errors"):
            raise GitHubClientError(f"GitHub GraphQL errors: {errors}")
        return payload["data"]

    def iter_repositories(self, login: str) -> tuple[str, list[dict[str, Any]]]:
        """Fetch all repositories owned by `login`. Returns (owner_type, nodes)."""
        nodes: list[dict[str, Any]] = []
        owner_type = "User"
        cursor: str | None = None

        while True:
            data = self._graphql(
                REPOSITORIES_QUERY, {"login": login, "cursor": cursor}
            )
            owner = data.get("repositoryOwner")
            if owner is None:
                raise GitHubClientError(
                    f"repositoryOwner '{login}' not found or not accessible"
                )
            owner_type = owner["__typename"]
            conn = owner["repositories"]
            nodes.extend(conn["nodes"])
            if not conn["pageInfo"]["hasNextPage"]:
                break
            cursor = conn["pageInfo"]["endCursor"]

        return owner_type, nodes
