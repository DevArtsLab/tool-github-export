from github_export.categorize import derive_category

MAPPING = {"tool-": "tool", "devarts-": "org-infra", "devartslab-": "org-infra"}


def test_prefix_match():
    assert derive_category("tool-github-export", MAPPING) == "tool"
    assert derive_category("devarts-mail", MAPPING) == "org-infra"
    assert derive_category("devartslab-site", MAPPING) == "org-infra"


def test_default_category():
    assert derive_category("voice-quote", MAPPING) == "project"


def test_custom_default():
    assert derive_category("voice-quote", MAPPING, default="misc") == "misc"


def test_case_insensitive():
    assert derive_category("Tool-Thing", MAPPING) == "tool"


def test_prefix_mid_name_does_not_match():
    assert derive_category("my-tool-box", MAPPING) == "project"
