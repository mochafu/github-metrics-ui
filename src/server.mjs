import express from "express"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import { overview, repoDetail, weeklyCommitDigest, repoContributors, contributorProfile, repoCommitTimeline, contributorCommits } from "./metrics.mjs"
import { db } from "./db.mjs"

const app = express()
app.disable("x-powered-by") // don't advertise the framework/version
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

app.get("/healthz", async (_req, res) => {
  try {
    await db.query("select 1")
    res.json({ ok: true })
  } catch (e) {
    console.error("healthz db error:", e)
    res.status(503).json({ ok: false })
  }
})

app.get("/api/overview", async (_req, res) => {
  try {
    res.json(await overview())
  } catch (e) {
    console.error("overview error:", e)
    res.status(500).json({ error: "internal server error" })
  }
})

app.get("/api/repo/:id", async (req, res) => {
  const id = parseRepoId(req.params.id)
  if (!id) return res.status(400).json({ error: "invalid repo id" })
  try {
    const detail = await repoDetail(id)
    if (!detail) return res.status(404).json({ error: "repo not found" })
    res.json(detail)
  } catch (e) {
    console.error("repo detail error:", e)
    res.status(500).json({ error: "internal server error" })
  }
})

app.get("/api/repo/:id/weekly", async (req, res) => {
  const id = parseRepoId(req.params.id)
  if (!id) return res.status(400).json({ error: "invalid repo id" })
  try {
    res.json(await weeklyCommitDigest(id))
  } catch (e) {
    console.error("weekly digest error:", e)
    res.status(500).json({ error: "internal server error" })
  }
})

app.get("/api/repo/:id/commits", async (req, res) => {
  const id = parseRepoId(req.params.id)
  if (!id) return res.status(400).json({ error: "invalid repo id" })
  try {
    res.json(await repoCommitTimeline(id))
  } catch (e) {
    console.error("commit timeline error:", e)
    res.status(500).json({ error: "internal server error" })
  }
})

app.get("/api/repo/:id/contributors", async (req, res) => {
  const id = parseRepoId(req.params.id)
  if (!id) return res.status(400).json({ error: "invalid repo id" })
  try {
    res.json(await repoContributors(id))
  } catch (e) {
    console.error("repo contributors error:", e)
    res.status(500).json({ error: "internal server error" })
  }
})

// GitHub usernames: 1-39 chars, alphanumeric or hyphen, cannot start with hyphen.
function parseLogin(raw) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(raw) ? raw : null
}

app.get("/api/contributor/:login", async (req, res) => {
  const login = parseLogin(req.params.login)
  if (!login) return res.status(400).json({ error: "invalid login" })
  try {
    const profile = await contributorProfile(login)
    if (profile.summary.totalCommits === 0) return res.status(404).json({ error: "contributor not found" })
    res.json(profile)
  } catch (e) {
    console.error("contributor profile error:", e)
    res.status(500).json({ error: "internal server error" })
  }
})

app.get("/api/contributor/:login/commits", async (req, res) => {
  const login = parseLogin(req.params.login)
  if (!login) return res.status(400).json({ error: "invalid login" })
  try {
    res.json(await contributorCommits(login))
  } catch (e) {
    console.error("contributor commits error:", e)
    res.status(500).json({ error: "internal server error" })
  }
})

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
