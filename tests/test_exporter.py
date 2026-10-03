import json
from pathlib import Path

import jsonschema

from github_export.exporter import (
    build_export,
    fetch_entries,
    run_export,
)
from github_export.models import Config

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "owner_response.json").read_text()
)
NODES = FIXTURE["data"]["repositoryOwner"]["repositories"]["nodes"]
SCHEMA = json.loads(
    (Path(__file__).parents[1] / "schemas" / "repos.schema.json").read_text()
)


class FakeClient:
    def iter_repositories(self, login):
        return "Organization", NODES


def make_config(**over):
    base = {
        "sources": [{"type": "organization", "login": "DevArtsLab"}],
        "categories": {"tool-": "tool", "devarts-": "org-infra"},
        "overrides": {
            "DevArtsLab/hidden-by-override": {"exclude": True},
            "DevArtsLab/tool-github-export": {
                "display_name": "GitHub Export",
                "featured": True,
            },
        },
    }
    base.update(over)
    return Config.model_validate(base)


def test_fetch_entries_applies_category_and_overrides():
    entries = fetch_entries(FakeClient(), make_config())
    by_name = {e.name: e for e in entries}
    assert by_name["tool-github-export"].category == "tool"
    assert by_name["tool-github-export"].featured is True
    assert by_name["tool-github-export"].display_name == "GitHub Export"
    assert by_name["secret-internal-app"].category == "project"
    # default display_name derived from name
    assert by_name["secret-internal-app"].display_name == "Secret Internal App"


def test_public_export_excludes_private_and_overrides():
    entries = fetch_entries(FakeClient(), make_config())
    public = build_export(entries, make_config(), public_only=True)
    names = {e.name for e in public.repositories}
    assert "tool-github-export" in names
    assert "secret-internal-app" not in names  # private repo
    assert "hidden-by-override" not in names  # exclude: true
    assert public.stats.total == 1


def test_private_export_includes_everything():
    entries = fetch_entries(FakeClient(), make_config())
    private = build_export(entries, make_config(), public_only=False)
    names = {e.name for e in private.repositories}
    assert names == {
        "tool-github-export",
        "secret-internal-app",
        "hidden-by-override",
    }
    assert private.stats.private == 1


def test_filter_excludes_forks():
    cfg = make_config(filters={"include_forks": False})
    forked = dict(NODES[0], name="forked-repo", nameWithOwner="DevArtsLab/forked-repo",
                  isFork=True, parent={"nameWithOwner": "upstream/repo"})
    nodes = [*NODES, forked]

    class C(FakeClient):
        def iter_repositories(self, login):
            return "Organization", nodes

    entries = fetch_entries(C(), cfg)
    assert "forked-repo" not in {e.name for e in entries}


def test_output_conforms_to_schema(tmp_path):
    cfg = make_config()
    written = run_export(FakeClient(), cfg, out_dir=tmp_path)
    for path in written.values():
        instance = json.loads(path.read_text())
        jsonschema.validate(instance, SCHEMA)


def test_overrides_exclude_only_affects_public(tmp_path):
    cfg = make_config()
    written = run_export(FakeClient(), cfg, out_dir=tmp_path)
    public = json.loads(written["public"].read_text())
    private = json.loads(written["private"].read_text())
    pub_names = {r["name"] for r in public["repositories"]}
    prv_names = {r["name"] for r in private["repositories"]}
    assert "hidden-by-override" not in pub_names
    assert "hidden-by-override" in prv_names
