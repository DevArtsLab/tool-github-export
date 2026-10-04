# tool-github-export

Export GitHub repository metadata from multiple owners (orgs + users) into versioned JSON artifacts that any project can consume over HTTP.

This repo is the single source of truth for "which repos exist, what are they, and how should they be categorized" across DevArts Lab properties: the devartslab.com directory, portfolio components, the resume builder, and anything else that needs a project list.

## How it works

```
export.config.yaml  -->  github-export (GraphQL v4)  -->  data/repos.public.json   (committed here, public)
                        |                          -->  data/repos.private.json  (pushed to a private repo)
                        v
              categories | overrides | filters
```

A scheduled GitHub Action runs the exporter every 6 hours (or on demand via `workflow_dispatch`), validates the output against the JSON schema, and commits `data/repos.public.json` back to this repo. `repos.private.json` is pushed to a separate private repo (see [Private output](#private-output)).

## Outputs

| File                 | Visibility                                     | Where it goes                                                        |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `repos.public.json`  | public repos only, minus `exclude` overrides   | committed to `data/` in this repo                                    |
| `repos.private.json` | all repos the token can see (public + private) | pushed to the private repo named by the `PRIVATE_DATA_REPO` variable |

### Consumer URLs (public export)

| Endpoint     | URL                                                                                              | Notes                                                                |
| ------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| raw          | `https://raw.githubusercontent.com/DevArtsLab/tool-github-export/main/data/repos.public.json`    | always fresh, rate-limited lightly                                   |
| jsDelivr CDN | `https://cdn.jsdelivr.net/gh/DevArtsLab/tool-github-export@main/data/repos.public.json`          | cached, fast, CORS-friendly; pin `@<commit>` for deterministic reads |
| schema       | `https://raw.githubusercontent.com/DevArtsLab/tool-github-export/main/schemas/repos.schema.json` | JSON Schema 2020-12                                                  |

### Consuming it

```bash
# curl
curl -s https://cdn.jsdelivr.net/gh/DevArtsLab/tool-github-export@main/data/repos.public.json
```

```ts
// TypeScript / frontend
const res = await fetch(
  "https://cdn.jsdelivr.net/gh/DevArtsLab/tool-github-export@main/data/repos.public.json",
);
const { repositories, stats, generated_at } = await res.json();
const tools = repositories.filter((r) => r.category === "tool");
```

```python
# Python
import httpx
data = httpx.get(
    "https://cdn.jsdelivr.net/gh/DevArtsLab/tool-github-export@main/data/repos.public.json"
).json()
```

See `examples/consumer.html` for a working browser page (serve it with `uv run python -m http.server`).

## The contract

Top-level fields: `schema_version`, `generated_at`, `generator`, `sources`, `stats` (incl. `by_category`), `repositories[]`.

Each repository carries: identity (`name`, `full_name`, `owner`, `owner_type`, `display_name`), links (`url`, `homepage`, `image_url`), classification (`category`, `tags`, `featured`, `visibility`), code (`primary_language`, `languages[]` with byte percentages, `license`, `default_branch`, `size_kb`), activity (`created_at`, `updated_at`, `pushed_at`, `latest_release`), stats (`stars`, `forks`, `watchers`, `open_issues`), and flags (`is_fork`, `is_archived`, `is_template`, `forked_from`).

**`category` is the stable filter field.** It is derived from the repo name prefix via `categories` in `export.config.yaml` (`tool-` -> `tool`, `devarts-`/`devartslab-` -> `org-infra`, everything else -> `project`). Consumers should filter on `category`, not parse names. `tags` remains the freeform field (GitHub topics + override tags).

**Versioning:** `schema_version` follows semver. Additive fields bump the minor version; renames/removals bump the major version and are announced in release notes.

## Configuration (`export.config.yaml`)

```yaml
sources: # owners to scan: {type: user|organization, login: ...}
filters: # include_forks / include_archived / include_templates
categories: # "prefix-": category  (first match wins, case-insensitive)
default_category: project
outputs: # dir + filenames
overrides: # per-repo, keyed by "owner/repo"
```

Per-repo `overrides`:

```yaml
overrides:
  "DevArtsLab/tool-github-export":
    display_name: "GitHub Export" # pretty name for directories/resumes
    description: "..." # replaces the GitHub description
    category: tool # overrides prefix-derived category
    featured: true # consumers can surface this
    tags_add: ["cli"] # merged into tags
    exclude: true # kept out of repos.public.json only
```

## Running it

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
uv sync
uv run github-export export                 # writes data/repos.{public,private}.json
uv run github-export export --public-only   # public artifact only
uv run github-export validate data/repos.public.json
uv run github-export schema > my-schema.json
uv run pytest                               # tests
uv run ruff check .                         # lint
```

Token resolution order: `--token` flag -> `GH_EXPORT_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` env -> `gh auth token` fallback.

## GitHub Action

`.github/workflows/export.yml` runs every 6 hours + on demand:

1. `github-export export` writes `data/repos.public.json` + `data/repos.private.json`
2. both files are validated against `schemas/repos.schema.json`
3. `repos.public.json` is committed back to `main`
4. `repos.private.json` is pushed to the private data repo (if configured)

### Required secrets / variables

| Name                | Kind     | Value                                                                                                                                                                      |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GH_EXPORT_TOKEN`   | secret   | PAT that can read target repos. Classic PAT with `repo` + `read:org` covers both private org and personal repos. Public-only exports need just `public_repo` + `read:org`. |
| `PRIVATE_DATA_REPO` | variable | e.g. `DevArtsLab/tool-github-export-data`. If unset, the private file is generated and validated but not published.                                                        |

The `GITHUB_TOKEN` provided by Actions cannot be used here: it is scoped to this repository and cannot list org/user repositories.

## Private output

Private repos and repos marked `exclude: true` never reach `repos.public.json`. The private export is pushed to a separate **private** repo so it can be consumed by trusted consumers (e.g. the resume builder) via the GitHub API with a token, without exposing private repo names publicly.

## Roadmap

- Optional AI enrichment block (`ai` field per repo: summary, tech stack, highlights) via GitHub Models in the Action
- Phase 2 serving: Cloudflare Worker + R2 for `data.devartslab.com`-style endpoints with query filters
- `repos.featured.json` convenience view

## License

MIT
