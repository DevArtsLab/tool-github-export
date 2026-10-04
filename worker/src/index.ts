/**
 * data.devartslab.com - serve tool-github-export artifacts as a JSON API.
 *
 * Model: pull, not push. A cron trigger syncs the two export files from
 * GitHub (public export from tool-github-export, private export from the
 * private tool-github-export-data repo) into R2. Requests are served from
 * R2; a Bearer token upgrades the dataset to the private export.
 */

export interface Env {
  BUCKET: R2Bucket;
  /** GitHub token used only by the cron sync to fetch the private export. */
  GH_EXPORT_TOKEN: string;
  /** Bearer token consumers use to access private-dataset responses. */
  PRIVATE_API_TOKEN: string;
}

const PUBLIC_KEY = "repos.public.json";
const PRIVATE_KEY = "repos.private.json";
const PUBLIC_SOURCE =
  "https://raw.githubusercontent.com/DevArtsLab/tool-github-export/main/data/repos.public.json";
const PRIVATE_SOURCE =
  "https://raw.githubusercontent.com/DevArtsLab/tool-github-export-data/main/repos.private.json";
const PUBLIC_CACHE_SECONDS = 300; // edge/browser cache TTL for public responses

interface RepoEntry {
  name: string;
  full_name: string;
  owner: string;
  owner_type: string;
  display_name?: string;
  description?: string;
  url: string;
  homepage?: string;
  visibility: "public" | "internal" | "private";
  category: string;
  featured: boolean;
  tags: string[];
  primary_language?: string;
  languages: { name: string; bytes: number; percentage: number }[];
  license?: string;
  stars: number;
  forks: number;
  watchers: number;
  open_issues: number;
  size_kb: number;
  is_fork: boolean;
  is_archived: boolean;
  is_template: boolean;
  forked_from?: string;
  default_branch: string;
  created_at?: string;
  updated_at?: string;
  pushed_at?: string;
  latest_release?: { tag: string; published_at?: string };
  image_url?: string;
}

interface ExportDoc {
  schema_version: string;
  generated_at: string;
  generator: { name: string; version: string };
  sources: { type: string; login: string }[];
  stats: {
    total: number;
    public: number;
    private: number;
    by_category: Record<string, number>;
  };
  repositories: RepoEntry[];
}

const SORT_FIELDS: Record<string, (r: RepoEntry) => string | number> = {
  stars: (r) => r.stars,
  forks: (r) => r.forks,
  name: (r) => r.name.toLowerCase(),
  created_at: (r) => r.created_at ?? "",
  pushed_at: (r) => r.pushed_at ?? "",
  updated_at: (r) => r.updated_at ?? "",
  size_kb: (r) => r.size_kb,
  open_issues: (r) => r.open_issues,
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsPreflight();
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (request.method === "POST" && url.pathname === "/v1/admin/sync") {
        if (!authorized(request, env)) return err(401, "unauthorized");
        return sync(env);
      }
      return err(405, "method_not_allowed");
    }

    // Public GET responses are edge-cached; authed responses never are.
    const authed = authorized(request, env);
    if (!authed) {
      const cached = await caches.default.match(request);
      if (cached) return cached;
    }

    let resp: Response;
    try {
      resp = await route(request, env, authed);
    } catch (e) {
      resp =
        e instanceof Error && e.message === "dataset_empty"
          ? err(503, "sync_pending", "Dataset not synced yet.")
          : err(500, "internal_error");
    }

    if (!authed && resp.status === 200) {
      resp.headers.set(
        "Cache-Control",
        `public, max-age=${PUBLIC_CACHE_SECONDS}, stale-while-revalidate=60`,
      );
      ctx.waitUntil(caches.default.put(request, resp.clone()));
    } else if (authed) {
      resp.headers.set("Cache-Control", "private, no-store");
    }
    return resp;
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(sync(env));
  },
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(request: Request, env: Env, authed: boolean): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/" || path === "/v1") return index(env);
  if (path === "/health") return health(env);
  if (path === "/v1/export.json") return rawExport(env, authed);

  if (path.startsWith("/v1/repos/")) {
    const name = decodeURIComponent(path.slice("/v1/repos/".length));
    return repoDetail(env, authed, name);
  }

  if (path === "/v1/repos") return repoList(env, authed, url.searchParams);
  if (path === "/v1/stats") return stats(env, authed);
  if (path === "/v1/categories") return aggregate(env, authed, (r) => r.category);
  if (path === "/v1/tags") return aggregateMany(env, authed, (r) => r.tags);
  if (path === "/v1/languages")
    return aggregateMany(env, authed, (r) => r.languages.map((l) => l.name));

  return err(404, "not_found", "See GET / for available endpoints.");
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function index(env: Env): Promise<Response> {
  const doc = await load(env, false).catch(() => null);
  return json({
    service: "data.devartslab.com",
    description:
      "Repository metadata API over tool-github-export artifacts. Public by default; Authorization: Bearer <token> unlocks the private dataset.",
    generated_at: doc?.generated_at ?? null,
    schema_version: doc?.schema_version ?? null,
    endpoints: {
      "GET /health": "liveness + upstream sync status",
      "GET /v1/repos":
        "filtered list; params: category, owner, tag, lang, featured, q, sort, order, limit, offset",
      "GET /v1/repos/{owner}/{name}": "single repository entry",
      "GET /v1/stats": "export stats block",
      "GET /v1/categories": "repo count per category",
      "GET /v1/tags": "repo count per tag/topic",
      "GET /v1/languages": "repo count per language",
      "GET /v1/export.json": "the whole export document",
      "POST /v1/admin/sync": "force an R2 resync from GitHub (auth required)",
    },
    source: "https://github.com/DevArtsLab/tool-github-export",
  });
}

async function health(env: Env): Promise<Response> {
  const head = await env.BUCKET.head(PUBLIC_KEY).catch(() => null);
  return json({
    ok: !!head,
    dataset: head
      ? { key: PUBLIC_KEY, size: head.size, uploaded: head.uploaded.toISOString() }
      : null,
  });
}

async function rawExport(env: Env, authed: boolean): Promise<Response> {
  const obj = await env.BUCKET.get(datasetKey(authed));
  if (!obj) return err(503, "sync_pending", "Dataset not synced yet.");
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ETag: obj.httpEtag,
    },
  });
}

async function repoList(
  env: Env,
  authed: boolean,
  params: URLSearchParams,
): Promise<Response> {
  const doc = await dataset(env, authed);
  let repos = doc.repositories;

  const category = params.get("category");
  const owner = params.get("owner")?.toLowerCase();
  const tag = params.get("tag");
  const lang = params.get("lang");
  const featured = params.get("featured");
  const q = params.get("q")?.toLowerCase();
  const visibility = params.get("visibility"); // authed only, else silently ignored

  if (category) repos = repos.filter((r) => r.category === category);
  if (owner) repos = repos.filter((r) => r.owner.toLowerCase() === owner);
  if (tag) repos = repos.filter((r) => r.tags.includes(tag));
  if (lang)
    repos = repos.filter(
      (r) => r.primary_language === lang || r.languages.some((l) => l.name === lang),
    );
  if (featured !== null)
    repos = repos.filter((r) => r.featured === (featured === "true"));
  if (authed && visibility) repos = repos.filter((r) => r.visibility === visibility);
  if (q)
    repos = repos.filter((r) =>
      `${r.name} ${r.full_name} ${r.display_name ?? ""} ${r.description ?? ""} ${r.tags.join(" ")}`
        .toLowerCase()
        .includes(q),
    );

  const sortKey =
    SORT_FIELDS[params.get("sort") ?? "pushed_at"] ?? SORT_FIELDS.pushed_at;
  const order = params.get("order") === "asc" ? 1 : -1;
  repos = [...repos].sort((a, b) => {
    const av = sortKey(a);
    const bv = sortKey(b);
    return av < bv ? -order : av > bv ? order : 0;
  });

  const total = repos.length;
  const limit = Math.min(Math.max(Number(params.get("limit")) || total, 0), 1000);
  const offset = Math.max(Number(params.get("offset")) || 0, 0);
  repos = repos.slice(offset, offset + limit);

  return json({
    generated_at: doc.generated_at,
    dataset: authed ? "private" : "public",
    count: repos.length,
    total,
    offset,
    limit,
    repositories: repos,
  });
}

async function repoDetail(
  env: Env,
  authed: boolean,
  fullName: string,
): Promise<Response> {
  const doc = await dataset(env, authed);
  const repo = doc.repositories.find(
    (r) => r.full_name.toLowerCase() === fullName.toLowerCase(),
  );
  if (!repo)
    return err(404, "repo_not_found", `No repository '${fullName}' in the export.`);
  return json(repo);
}

async function stats(env: Env, authed: boolean): Promise<Response> {
  const doc = await dataset(env, authed);
  return json({
    generated_at: doc.generated_at,
    dataset: authed ? "private" : "public",
    ...doc.stats,
  });
}

async function aggregate(
  env: Env,
  authed: boolean,
  key: (r: RepoEntry) => string,
): Promise<Response> {
  const doc = await dataset(env, authed);
  const counts: Record<string, number> = {};
  for (const r of doc.repositories) counts[key(r)] = (counts[key(r)] ?? 0) + 1;
  return json({ generated_at: doc.generated_at, counts });
}

async function aggregateMany(
  env: Env,
  authed: boolean,
  keys: (r: RepoEntry) => string[],
): Promise<Response> {
  const doc = await dataset(env, authed);
  const counts: Record<string, number> = {};
  for (const r of doc.repositories)
    for (const k of keys(r)) counts[k] = (counts[k] ?? 0) + 1;
  return json({ generated_at: doc.generated_at, counts });
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

function datasetKey(authed: boolean): string {
  return authed ? PRIVATE_KEY : PUBLIC_KEY;
}

async function dataset(env: Env, authed: boolean): Promise<ExportDoc> {
  const doc = await load(env, authed);
  if (!doc) throw new Error("dataset_empty");
  return doc;
}

async function load(env: Env, authed: boolean): Promise<ExportDoc | null> {
  const obj = await env.BUCKET.get(datasetKey(authed));
  if (!obj) return null;
  return obj.json<ExportDoc>();
}

/** Fetch both exports from GitHub and write them to R2. */
async function sync(env: Env): Promise<Response> {
  const results: Record<string, string> = {};

  const pub = await fetch(PUBLIC_SOURCE);
  if (pub.ok) {
    const text = await pub.text();
    JSON.parse(text); // fail fast on malformed upstream
    await env.BUCKET.put(PUBLIC_KEY, text, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { synced_at: new Date().toISOString(), source: PUBLIC_SOURCE },
    });
    results[PUBLIC_KEY] = "synced";
  } else {
    results[PUBLIC_KEY] = `fetch_failed_${pub.status}`;
  }

  const prv = await fetch(PRIVATE_SOURCE, {
    headers: { Authorization: `Bearer ${env.GH_EXPORT_TOKEN}` },
  });
  if (prv.ok) {
    const text = await prv.text();
    JSON.parse(text);
    await env.BUCKET.put(PRIVATE_KEY, text, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { synced_at: new Date().toISOString(), source: PRIVATE_SOURCE },
    });
    results[PRIVATE_KEY] = "synced";
  } else {
    results[PRIVATE_KEY] = `fetch_failed_${prv.status}`;
  }

  const ok = Object.values(results).every((v) => v === "synced");
  return json({ ok, results, synced_at: new Date().toISOString() }, ok ? 200 : 502);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  return !!env.PRIVATE_API_TOKEN && token === env.PRIVATE_API_TOKEN;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function err(status: number, code: string, message?: string): Response {
  return json({ error: { code, message: message ?? code } }, status);
}

function corsPreflight(): Response {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}
