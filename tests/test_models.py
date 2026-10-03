import json
from pathlib import Path

from github_export.models import Config, RepoEntry

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "owner_response.json").read_text()
)
NODES = FIXTURE["data"]["repositoryOwner"]["repositories"]["nodes"]


def test_from_node_normalizes_graphql_shape():
    entry = RepoEntry.from_node(NODES[0])
    assert entry.full_name == "DevArtsLab/tool-github-export"
    assert entry.owner == "DevArtsLab"
    assert entry.owner_type == "Organization"
    assert entry.visibility == "public"
    assert entry.primary_language == "Python"
    assert entry.license == "MIT"
    assert entry.tags == ["github-api", "json"]
    assert entry.latest_release is not None
    assert entry.latest_release.tag == "v0.1.0"


def test_language_percentages():
    entry = RepoEntry.from_node(NODES[0])
    assert entry.languages[0].name == "Python"
    assert entry.languages[0].percentage == 90.0
    assert entry.languages[1].percentage == 10.0


def test_private_visibility_lowercased():
    entry = RepoEntry.from_node(NODES[1])
    assert entry.visibility == "private"


def test_missing_optional_fields():
    entry = RepoEntry.from_node(NODES[2])
    assert entry.license is None
    assert entry.primary_language is None
    assert entry.latest_release is None
    assert entry.languages == []


def test_config_parses_minimal_yaml_shape():
    cfg = Config.model_validate(
        {
            "sources": [{"type": "organization", "login": "DevArtsLab"}],
            "categories": {"tool-": "tool"},
        }
    )
    assert cfg.sources[0].login == "DevArtsLab"
    assert cfg.filters.include_forks is True
    assert cfg.outputs.public_file == "repos.public.json"
    assert cfg.default_category == "project"
