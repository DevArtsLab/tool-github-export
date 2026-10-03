import json
from pathlib import Path

import httpx
import pytest
import respx

from github_export.client import GitHubClient, GitHubClientError, resolve_token

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "owner_response.json").read_text()
)


def _page(nodes, has_next, cursor):
    return {
        "data": {
            "repositoryOwner": {
                "login": "DevArtsLab",
                "__typename": "Organization",
                "repositories": {
                    "pageInfo": {"hasNextPage": has_next, "endCursor": "C1"},
                    "nodes": nodes,
                },
            },
            "rateLimit": {"cost": 1, "remaining": 4999},
        }
    }


@respx.mock
def test_iter_repositories_single_page():
    respx.post(url__regex=r"api\.github\.com/graphql/?").mock(
        return_value=httpx.Response(200, json=FIXTURE)
    )
    with GitHubClient("token") as client:
        owner_type, nodes = client.iter_repositories("DevArtsLab")
    assert owner_type == "Organization"
    assert len(nodes) == 3


@respx.mock
def test_iter_repositories_paginates():
    route = respx.post(url__regex=r"api\.github\.com/graphql/?")
    page1 = _page([{"name": "a", "nameWithOwner": "x/a", "url": "u"}], True, "C1")
    page2 = _page([{"name": "b", "nameWithOwner": "x/b", "url": "u"}], False, None)
    route.side_effect = [httpx.Response(200, json=page1), httpx.Response(200, json=page2)]
    with GitHubClient("token") as client:
        _, nodes = client.iter_repositories("x")
    assert [n["name"] for n in nodes] == ["a", "b"]
    # second request carried the cursor
    body = json.loads(route.calls[1].request.content)
    assert body["variables"]["cursor"] == "C1"


@respx.mock
def test_graphql_errors_raise():
    respx.post(url__regex=r"api\.github\.com/graphql/?").mock(
        return_value=httpx.Response(
            200, json={"errors": [{"message": "Bad credentials"}]}
        )
    )
    with GitHubClient("bad") as client, pytest.raises(GitHubClientError, match="Bad credentials"):
        client.iter_repositories("x")


@respx.mock
def test_unknown_owner_raises():
    respx.post(url__regex=r"api\.github\.com/graphql/?").mock(
        return_value=httpx.Response(200, json={"data": {"repositoryOwner": None}})
    )
    with GitHubClient("token") as client, pytest.raises(GitHubClientError, match="not found"):
        client.iter_repositories("nope")


def test_resolve_token_explicit_wins(monkeypatch):
    monkeypatch.setenv("GH_TOKEN", "env-token")
    assert resolve_token("explicit") == "explicit"
    assert resolve_token(None) == "env-token"


def test_resolve_token_missing(monkeypatch):
    for var in ("GH_EXPORT_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr("shutil.which", lambda _: None)

    def _no_gh(*a, **k):
        raise FileNotFoundError

    monkeypatch.setattr("subprocess.run", _no_gh)
    with pytest.raises(GitHubClientError, match="No GitHub token"):
        resolve_token(None)
