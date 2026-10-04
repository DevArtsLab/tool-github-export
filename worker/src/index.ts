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

  if (path === "/") return browse(request, env, url, "/browse", "/");
  if (path === "/v1") return index(env);
  if (path === "/health") return health(env);
  if (path === "/v1/export.json") return rawExport(env, authed);
  if (path === "/browse" || path.startsWith("/browse/"))
    return browse(request, env, url, path);

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

const ENDPOINTS: [string, string][] = [
  ["GET /", "browse root (same as /browse)"],
  ["GET /health", "liveness + upstream sync status"],
  [
    "GET /v1/repos",
    "filtered list; params: category, owner, tag, lang, featured, q, sort, order, limit, offset",
  ],
  ["GET /v1/repos/{owner}/{name}", "single repository entry"],
  ["GET /v1/stats", "export stats block"],
  ["GET /v1/categories", "repo count per category"],
  ["GET /v1/tags", "repo count per tag/topic"],
  ["GET /v1/languages", "repo count per language"],
  ["GET /v1/export.json", "the whole export document"],
  ["GET /browse", "FTP-style browsable directory index (HTML)"],
  ["POST /v1/admin/sync", "force an R2 resync from GitHub (auth required)"],
];

async function index(env: Env): Promise<Response> {
  const doc = await load(env, false).catch(() => null);
  return json({
    service: "data.devartslab.com",
    description:
      "Repository metadata API over tool-github-export artifacts. Public by default; Authorization: Bearer <token> unlocks the private dataset.",
    generated_at: doc?.generated_at ?? null,
    schema_version: doc?.schema_version ?? null,
    endpoints: Object.fromEntries(ENDPOINTS),
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
  const m = (request.headers.get("Authorization") ?? "").match(/^(\S+)\s+(.+)$/);
  if (!m) return false;
  let token = "";
  const scheme = m[1].toLowerCase();
  if (scheme === "bearer") {
    token = m[2];
  } else if (scheme === "basic") {
    // browsers prompt for user:pass; accept the password as the token
    try {
      token = atob(m[2]).split(":").slice(1).join(":");
    } catch {
      token = "";
    }
  }
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

// ---------------------------------------------------------------------------
// FTP-style browsable directory index (/browse)
// ---------------------------------------------------------------------------

const BROWSE_CSS =
  "body{font-family:sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#222}" +
  "table{border-collapse:collapse;width:100%}" +
  "th,td{text-align:left;padding:2px 16px 2px 0;font-size:14px;white-space:nowrap}" +
  "th{border-bottom:1px solid #999}td{border-bottom:1px solid #eee}" +
  "a{color:#05c;text-decoration:none}a:hover{text-decoration:underline}" +
  "h1{font-size:17px;font-weight:600}h2{font-size:14px;font-weight:600;margin-top:1.5rem}address{font-size:12px;color:#888}";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function html(title: string, body: string): Response {
  const page =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>Index of ${esc(title)}</title><style>${BROWSE_CSS}</style></head><body>` +
    `<h1>Index of ${esc(title)}</h1><hr>${body}<hr>` +
    `<address>data.devartslab.com - tool-github-export worker</address></body></html>`;
  return new Response(page, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escAttr(s: string): string {
  return esc(s);
}

function fmtDate(iso?: string): string {
  return iso ? iso.slice(0, 10) : "-";
}

async function browse(
  request: Request,
  env: Env,
  _url: URL,
  path: string,
  title = path,
): Promise<Response> {
  const segs = path.slice("/browse".length).split("/").filter(Boolean);

  if (segs.length === 0) {
    const doc = await load(env, false).catch(() => null);
    const meta = doc
      ? `${doc.repositories.length} public repos - generated ${fmtDate(doc.generated_at)} - schema ${esc(String(doc.schema_version ?? "-"))}`
      : "dataset not synced yet";
    const apiRows = ENDPOINTS.map(
      ([m, d]) => `<tr><td><code>${esc(m)}</code></td><td>${esc(d)}</td></tr>`,
    ).join("");
    return html(
      title === "/" ? "/" : "/browse/",
      `<p>Repository metadata API over tool-github-export artifacts.<br>` +
        `${meta} - JSON index: <a href="/v1">/v1</a> - ` +
        `source: <a href="https://github.com/DevArtsLab/tool-github-export">github.com/DevArtsLab/tool-github-export</a></p>` +
        `<table><tr><th>Name</th><th>Description</th></tr>` +
        `<tr><td class="d"><a href="/browse/public/">public/</a></td><td>public repositories export</td></tr>` +
        `<tr><td class="d"><a href="/browse/private/">private/</a></td><td>all repositories export (auth required)</td></tr>` +
        `<tr><td><a href="/v1/export.json">repos.public.json</a></td><td>raw JSON document</td></tr></table>` +
        `<h2>API endpoints</h2><table>${apiRows}</table>`,
    );
  }

  const ds = segs[0];
  if (ds !== "public" && ds !== "private") {
    return html(
      path,
      `<p>Not a directory: ${esc(ds)}. Try <a href="/browse/">/browse/</a>.</p>`,
    );
  }

  const authed = ds === "private";
  if (authed && !authorized(request, env)) {
    return new Response("Authentication required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="data.devartslab.com"' },
    });
  }

  const doc = await load(env, authed);
  if (!doc) return html(path, "<p>Dataset not synced yet.</p>");

  if (segs.length === 1) return browseOwners(doc, ds);
  if (segs.length === 2) return browseRepos(doc, ds, segs[1]);
  if (segs.length === 3) return browseRepo(doc, ds, segs[1], segs[2]);
  return html(path, "<p>No such directory.</p>");
}

function parentRow(href: string): string {
  return `<tr><td class="d" colspan="6"><a href="${escAttr(href)}">../</a></td></tr>`;
}

async function browseOwners(doc: ExportDoc, ds: string): Promise<Response> {
  const byOwner = new Map<string, number>();
  for (const r of doc.repositories)
    byOwner.set(r.owner, (byOwner.get(r.owner) ?? 0) + 1);

  const rows = [...byOwner.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([owner, n]) =>
        `<tr><td class="d"><a href="/browse/${ds}/${encodeURIComponent(owner)}/">${esc(owner)}/</a></td><td>${n} repos</td></tr>`,
    )
    .join("");

  const fileRow =
    `<tr><td><a href="/v1/export.json">repos.${ds}.json</a></td>` +
    `<td>${doc.repositories.length} repos, generated ${fmtDate(doc.generated_at)}</td></tr>`;

  return html(
    `/browse/${ds}/`,
    `<table><tr><th>Name</th><th>Contents</th></tr>${parentRow("/browse/")}${rows}${fileRow}</table>`,
  );
}

async function browseRepos(
  doc: ExportDoc,
  ds: string,
  owner: string,
): Promise<Response> {
  const repos = doc.repositories.filter(
    (r) => r.owner.toLowerCase() === owner.toLowerCase(),
  );
  if (repos.length === 0)
    return html(
      `/browse/${ds}/${owner}/`,
      `<p>Empty directory.</p>${parentRow(`/browse/${ds}/`)}`,
    );

  const rows = repos
    .map(
      (r) =>
        `<tr>` +
        `<td class="d"><a href="/browse/${ds}/${encodeURIComponent(owner)}/${encodeURIComponent(r.name)}/">${esc(r.name)}/</a></td>` +
        `<td>${esc(r.category)}</td>` +
        `<td>${esc(r.primary_language ?? "-")}</td>` +
        `<td>${r.stars}</td>` +
        `<td>${fmtDate(r.pushed_at)}</td>` +
        `<td>${r.size_kb}</td>` +
        `</tr>`,
    )
    .join("");

  return html(
    `/browse/${ds}/${owner}/`,
    `<table><tr><th>Name</th><th>Category</th><th>Lang</th><th>Stars</th><th>Pushed</th><th>KB</th></tr>` +
      `${parentRow(`/browse/${ds}/`)}${rows}</table>`,
  );
}

async function browseRepo(
  doc: ExportDoc,
  ds: string,
  owner: string,
  name: string,
): Promise<Response> {
  const repo = doc.repositories.find(
    (r) => r.full_name.toLowerCase() === `${owner}/${name}`.toLowerCase(),
  );
  const base = `/browse/${ds}/${encodeURIComponent(owner)}/`;
  if (!repo)
    return html(`${base}${name}/`, `<p>No such repository.</p>${parentRow(base)}`);

  const rows = Object.entries(repo)
    .map(([k, v]) => {
      const val =
        v === null || v === undefined
          ? "-"
          : typeof v === "object"
            ? `<code>${esc(JSON.stringify(v))}</code>`
            : k === "url" || k === "homepage" || k === "image_url"
              ? `<a href="${escAttr(String(v))}">${esc(String(v))}</a>`
              : esc(String(v));
      return `<tr><td>${esc(k)}</td><td>${val}</td></tr>`;
    })
    .join("");

  const links =
    `<p><a href="/v1/repos/${escAttr(repo.full_name)}">repos/${esc(repo.full_name)}.json</a> (raw JSON)` +
    (ds === "private" ? ` &middot; private dataset` : "") +
    `</p>`;

  return html(
    `${base}${name}/`,
    `${parentRow(base)}${links}<table><tr><th>Field</th><th>Value</th></tr>${rows}</table>`,
  );
}
