import express from "express"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import {
  overview, repoDetail, weeklyCommitDigest, repoContributors, contributorProfile,
  repoCommitTimeline, contributorCommits, trends, TREND_RANGES, teamDirectory, dataStatus,
  activityPunchcard, workflowInsights, reviewHealth, issueInsights,
} from "./metrics.mjs"
import { db } from "./db.mjs"

const app = express()
app.disable("x-powered-by") // don't advertise the framework/version

// ---------------------------------------------------------------------------
// Security headers on every response. The CSP is strict because all JS/CSS is
// served from this origin (no CDNs): scripts must be same-origin files (no
// inline <script>), and the app only talks to its own /api.
// 'unsafe-inline' for styles covers the style="" attributes charts/bars use.
// ---------------------------------------------------------------------------
app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; " +
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  })
  next()
})

// ---------------------------------------------------------------------------
// Cheap in-memory rate limiter (fixed window, per IP). Enough to keep a stray
// loop or scraper from hammering the DB through us; a real deployment behind
// a proxy should also set `app.set('trust proxy', ...)` and use its limiter.
// ---------------------------------------------------------------------------
const RATE_LIMIT = 240 // requests per window per IP
const RATE_WINDOW_MS = 60_000
const hits = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [ip, rec] of hits) if (now - rec.start > RATE_WINDOW_MS) hits.delete(ip)
}, RATE_WINDOW_MS).unref()

app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store") // metrics change as backfill lands; never cache
  const now = Date.now()
  let rec = hits.get(req.ip)
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    rec = { start: now, n: 0 }
    hits.set(req.ip, rec)
  }
  if (++rec.n > RATE_LIMIT) return res.status(429).json({ error: "rate limit exceeded" })
  next()
})

const here = dirname(fileURLToPath(import.meta.url))
app.use(express.static(join(here, "..", "public")))

// GitHub numeric ids are BIGINT. Validate before it reaches Postgres so a bad id
// is a clean 400 instead of a 500 that leaks the raw "invalid input syntax for
// type bigint" / "out of range" driver error to the client.
const BIGINT_MAX = 9223372036854775807n
function parseRepoId(raw) {
  if (!/^\d+$/.test(raw)) return null
  try {
    if (BigInt(raw) > BIGINT_MAX) return null
  } catch {
    return null
  }
  return raw
}

// GitHub usernames: 1-39 chars, alphanumeric or hyphen, cannot start with hyphen.
function parseLogin(raw) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(raw) ? raw : null
}

// Wrap a handler so route code only throws and we answer 500 uniformly.
const guard = (label, fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (e) {
    console.error(`${label} error:`, e)
    res.status(500).json({ error: "internal server error" })
  }
}

app.get("/healthz", async (_req, res) => {
  try {
    await db.query("select 1")
    res.json({ ok: true })
  } catch (e) {
    console.error("healthz db error:", e)
    res.status(503).json({ ok: false })
  }
})

app.get("/api/overview", guard("overview", async (req, res) => {
  const range = TREND_RANGES.includes(req.query.range) ? req.query.range : "12m"
  res.json(await overview(range))
}))

// Time-series for every metric: ?range=6w|12m|all, optional &repo=<id>.
app.get("/api/trends", guard("trends", async (req, res) => {
  const range = TREND_RANGES.includes(req.query.range) ? req.query.range : "12m"
  let repoId = null
  if (req.query.repo != null) {
    repoId = parseRepoId(String(req.query.repo))
    if (!repoId) return res.status(400).json({ error: "invalid repo id" })
  }
  res.json(await trends(range, repoId))
}))

app.get("/api/team", guard("team", async (_req, res) => {
  res.json(await teamDirectory())
}))

app.get("/api/status", guard("status", async (_req, res) => {
  res.json(await dataStatus())
}))

// Optional ?repo=<id> scopes these to one repo; absent = org-wide.
function optionalRepo(req, res) {
  if (req.query.repo == null) return { repoId: null, ok: true }
  const repoId = parseRepoId(String(req.query.repo))
  if (!repoId) { res.status(400).json({ error: "invalid repo id" }); return { ok: false } }
  return { repoId, ok: true }
}

app.get("/api/activity", guard("activity", async (req, res) => {
  const r = optionalRepo(req, res); if (!r.ok) return
  res.json(await activityPunchcard(r.repoId))
}))

app.get("/api/workflows", guard("workflows", async (req, res) => {
  const r = optionalRepo(req, res); if (!r.ok) return
  res.json(await workflowInsights(r.repoId))
}))

app.get("/api/reviews", guard("reviews", async (req, res) => {
  const r = optionalRepo(req, res); if (!r.ok) return
  res.json(await reviewHealth(r.repoId))
}))

app.get("/api/issues", guard("issues", async (req, res) => {
  const r = optionalRepo(req, res); if (!r.ok) return
  res.json(await issueInsights(r.repoId))
}))

app.get("/api/repo/:id", guard("repo detail", async (req, res) => {
  const id = parseRepoId(req.params.id)
  if (!id) return res.status(400).json({ error: "invalid repo id" })
  const detail = await repoDetail(id)
  if (!detail) return res.status(404).json({ error: "repo not found" })
  res.json(detail)
}))

app.get("/api/repo/:id/weekly", guard("weekly digest", async (req, res) => {
  const id = parseRepoId(req.params.id)
  if (!id) return res.status(400).json({ error: "invalid repo id" })
  res.json(await weeklyCommitDigest(id))
}))

app.get("/api/repo/:id/commits", guard("commit timeline", async (req, res) => {
  const id = parseRepoId(req.params.id)
  if (!id) return res.status(400).json({ error: "invalid repo id" })
  res.json(await repoCommitTimeline(id))
}))

app.get("/api/repo/:id/contributors", guard("repo contributors", async (req, res) => {
  const id = parseRepoId(req.params.id)
  if (!id) return res.status(400).json({ error: "invalid repo id" })
  res.json(await repoContributors(id))
}))

app.get("/api/contributor/:login", guard("contributor profile", async (req, res) => {
  const login = parseLogin(req.params.login)
  if (!login) return res.status(400).json({ error: "invalid login" })
  const profile = await contributorProfile(login)
  if (profile.summary.totalCommits === 0) return res.status(404).json({ error: "contributor not found" })
  res.json(profile)
}))

app.get("/api/contributor/:login/commits", guard("contributor commits", async (req, res) => {
  const login = parseLogin(req.params.login)
  if (!login) return res.status(400).json({ error: "invalid login" })
  res.json(await contributorCommits(login))
}))

// Unknown /api/* routes answer with JSON, not Express's default HTML 404.
app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }))

const PORT = Number(process.env.DASHBOARD_PORT || 4000)
const server = app.listen(PORT, () => console.log(`dev-metrics dashboard on http://localhost:${PORT}`))

// Graceful shutdown: stop accepting connections, drain the pg pool, then exit.
// A hard cap guards against a stuck connection hanging the process forever.
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${signal} received — shutting down`)
  server.close(() => {
    db.end().finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
