# dev-metrics-dashboard

Read-only engineering-metrics dashboard over the `github-metrics` collector's
Supabase Postgres. Express serves a JSON API + a no-build vanilla-JS SPA
(`public/index.html` + `app.js` + `styles.css`, Chart.js vendored locally).

```bash
npm install
node src/server.mjs        # http://localhost:4000  (DASHBOARD_PORT to override)
```

`.env` needs `DATABASE_URL` (the Supabase **pooler** string — same one the
collector writes to; if they differ, the dashboard shows stale data), and
`ANTHROPIC_API_KEY` to enable the AI report + Ask-AI features (optional —
everything else works without it; see *AI endpoints* below).

> **Pooler mode note:** a `:5432` URL is Supabase's *session-mode* pooler — each
> dashboard connection pins a pooler slot for its lifetime, and the slot budget
> is shared with the collector. The pool is therefore capped at `max: 10` in
> `src/db.mjs` (raising it causes rejected connections → 500s during page-load
> bursts, especially while a backfill is running). If the dashboard ever needs
> more concurrency, switch this app's `DATABASE_URL` to the *transaction-mode*
> pooler (port `6543`): its connections are multiplexed per-statement, so they
> are cheap and don't compete with the collector. This code is compatible —
> single-statement `pool.query` only, no session state or LISTEN/NOTIFY.

## Philosophy

- **Team-level insight, not individual scoring.** There is deliberately no
  commit-count leaderboard. Contributor views are directories ordered by
  recency; volume columns exist for context and sorting, not ranking.
- **Honest proxies.** Most repos don't emit real GitHub Deployments, so
  deploy-based DORA metrics fall down a labeled ladder:
  Deployments → Releases → merges to main → green CI on main. Every number
  says which signal produced it.
- **Honest freshness.** Backfill may be in flight; the UI shows "data as of"
  everywhere and banners when data is stale, instead of pretending to be live.

## API

| Route | Returns |
|---|---|
| `GET /healthz` | `{ok}` + DB ping |
| `GET /api/overview[?range=1d\|1w\|6w\|12m\|all]` | all-time totals, per-repo stat rows (incl. CFR/MTTR/issues/lastActivity), `rangeExtras` (range-scoped distinct contributors + lead-time p50), freshness |
| `GET /api/trends?range=1d\|1w\|6w\|12m\|all[&repo=id]` | zero-filled buckets of every metric (1d→hourly, 1w→daily, 6w→weekly, 12m/all→monthly) |
| `GET /api/team` | contributor directory (recency-ordered), org work mix, active-30d |
| `GET /api/status` | row counts per table + latest event timestamp |
| `GET /api/activity[?repo=id]` | commit punchcard: 7×24 day-of-week × hour-of-day grid (UTC) + peak / after-hours / weekend shares |
| `GET /api/workflows[?repo=id]` | per-workflow CI reliability (runs, pass rate, retry rate, median duration, last run) + summary |
| `GET /api/reviews[?repo=id]` | review outcomes (approved / changes-requested / commented), coverage of merged PRs, reviews-per-PR |
| `GET /api/issues[?repo=id]` | resolution mix (completed vs not-planned), open-backlog age buckets, comment engagement, close p50 |
| `GET /api/repo/:id` | summary (incl. bus factor), deploy series, review health, recent PRs |
| `GET /api/repo/:id/weekly` | 12-week commit digest with LLM summaries |
| `GET /api/repo/:id/commits` | commit scatter-timeline rows |
| `GET /api/repo/:id/contributors` | per-contributor stats for one repo |
| `GET /api/contributor/:login` | cross-repo profile |
| `GET /api/contributor/:login/commits` | commits for the profile activity chart |
| `GET /api/report?range=…[&refresh=1]` | **AI** — streamed markdown report (downtrends / uptrends / summary) for the range; served from a 15-min server cache unless `refresh=1` |
| `POST /api/ask` `{messages:[{role,content}…]}` | **AI** — free-form Q&A; streams NDJSON (`start` → `tool`/`ping` progress → `answer`/`error`) |

DORA coverage: deployment frequency (`deployPerWeek` + method), lead time
(PR open→merge p50/p90 — a proxy; true DORA is commit→deploy), change failure
rate (failed CI on the default branch), time-to-restore (median red-streak →
next green on the default branch).

### AI endpoints

Both AI routes call Claude (`claude-opus-4-8`; override with `AI_MODEL`) and
require `ANTHROPIC_API_KEY` in `.env` — without it they answer 503 and the rest
of the app is unaffected. The report is one model call over a JSON snapshot
assembled from the endpoints above (deterministic, no retrieval). Q&A runs a
tool-use loop where the model's only tools are read-only wrappers of the same
metric functions the charts use — it never writes SQL and can't see anything
the dashboard can't show. Both routes carry the project's editorial policy in
the system prompt: team-level framing (no individual leaderboards) and honest
proxy labeling. Guardrails: 12 AI calls / 10 min / IP, max 3 in flight
org-wide, model calls aborted when the client disconnects. Cost is roughly
$0.10–0.35 per uncached report (the snapshot is ~60 KB of JSON) and usage is
logged per call (`ai report …` / `ai ask …` lines).

## How each metric is calculated

All figures come from the collector's raw tables (`commits`, `pull_requests`,
`pr_reviews`, `workflow_runs`, `issues`, `deployments`, `releases`). Bot
*authors* are excluded via `author_is_bot`; bot *reviewers* are counted and
broken out (see PR reviews below). "Default branch" means `main`/`master`.

| Metric | Exact calculation | Proxy / caveat |
|---|---|---|
| **Commits** | `count(*)` of non-bot commits (by `authored_at`). | — |
| **Active contributors** | `count(distinct author_login)` of non-bot commits in the window. | Overview KPI is scoped to the selected range; can't be summed from buckets (would double-count). |
| **PRs opened / merged** | `count(*)` by `created_at` / count where `merged_at is not null`. | — |
| **Merge rate** | KPIs & trend: `merged ÷ opened` in the window. Repo/contributor cards: `merged ÷ (merged + closed-unmerged)`. | Two definitions exist; each is labeled where shown. |
| **Lead time p50/p90** | `percentile_cont` of `(merged_at − created_at)` in hours, over PRs merged in the window. | Proxy for DORA lead time (true DORA is first-commit→deploy). Includes time waiting on review — read alongside time-to-first-review before treating a rise as a slowdown. |
| **CI pass rate** | `success ÷ (success + failure + other-completed)` workflow runs; org KPI is run-count-weighted across repos. | Counts all workflows, not only deploy pipelines. |
| **Deploy frequency** | Events per week from the first non-empty rung of the ladder: GitHub Deployments → published Releases → merges to default branch → successful CI on default branch. Reported method says which rung. | Most repos have no real Deployments API signal, so this is usually a merge/CI proxy. |
| **Change failure rate (CFR)** | `failure ÷ (success + failure)` workflow runs on the default branch. | Proxy — real CFR needs deployment outcomes, which we don't have. |
| **Time to restore (MTTR)** | Median hours from the **start** of a red streak on the default branch to the next green run (`lag()` collapses consecutive failures to one streak). | Proxy — CI recovery, not production incident recovery. |
| **Issues opened / closed** | `count(*)` by `created_at` / `closed_at` in the window. Issue close p50 = `percentile_cont` of `closed_at − created_at`. | — |
| **PR reviews** | `count(*)` of review submissions (`pr_reviews.submitted_at`), with a separate human-only count (`reviewer_is_bot`). Review coverage = merged PRs with ≥1 review ÷ merged PRs (any-reviewer and human-only variants). Time-to-first-review p50 = median `first review − PR created`, bucketed by when the first review landed. | Bots included by design, always shown split — automation is review activity, but it shouldn't pass silently as human review. |
| **Work mix / focus** | Grouped by `commit_analysis.change_type` (LLM-classified: feature / bug_fix / refactor / test / docs / config / chore). | Depends on LLM classification coverage. |
| **Working-patterns punchcard** | `count(*)` of non-bot commits grouped by `extract(dow …)` × `extract(hour …)` of `authored_at`. After-hours = outside 09:00–18:00; weekend = Sat/Sun. | **Timestamps are UTC**, not contributors' local time — read peaks as UTC. |
| **CI / workflow reliability** | Per `workflow_runs.name`: pass rate = `success ÷ (success+failure)`; retry rate = `run_attempt>1 ÷ runs`; duration p50 = median `updated_at − run_started_at`. | Wall-clock incl. queue time; duration only where both timestamps exist. |
| **Review health** | Outcome mix from `pr_reviews.state` (approved / changes-requested / commented), bots included with a human/bot split; coverage = merged PRs with ≥1 review (human-only variant alongside); reviews-per-PR = reviews ÷ merged PRs. | Review rows only advance on review webhooks/resyncs and can lag other tables — the panel and `/api/status` (`latestByTable`) show review-data freshness. |
| **Issue insights** | Resolution via `state_reason` (completed vs not-planned); backlog age buckets from open-issue `created_at` (<1w / 1–4w / >1mo); comment engagement = median `comments`. | `state_reason` may be null on older issues (shown as untyped). |
| **Bus factor / concentration** | Per repo: fewest contributors whose commits sum to ≥50% of the repo's commits; top-contributor share = largest author's fraction. | A **risk** signal (knowledge concentration), not a productivity ranking. |
| **▲▼ delta** | Last **complete** bucket vs the one before it (current still-running bucket excluded). Basis = the range's bucket size (hour/day/week/month). | Not YoY — it is period-over-period at the selected granularity. |

Two signals were deliberately **left out** because the collector only populates
them for a small fraction of rows (they'd mislead): per-commit code churn
(`additions`/`deletions`, ~5% coverage) and PR size (`changed_files`, ~11%).

## Security posture

- Strict CSP (`script-src 'self'`, no CDNs, no inline JS), `nosniff`,
  `frame-ancestors 'none'`, no-referrer. All DB-sourced strings are
  HTML-escaped client-side; no inline event handlers.
- Route params validated before Postgres (bigint ids, GitHub login shape);
  all SQL is parameterized; API errors are generic (no driver leakage).
- Per-IP rate limit (240 req/min) and `Cache-Control: no-store` on `/api`.
- CSV export defuses spreadsheet formula injection (`=`, `+`, `-`, `@`).
- **Recommended (manual, in Supabase):** create a read-only role for this app
  instead of using the owner connection, e.g.
  ```sql
  create role dashboard_ro login password '<generated>';
  grant usage on schema public to dashboard_ro;
  grant select on all tables in schema public to dashboard_ro;
  alter default privileges in schema public grant select on tables to dashboard_ro;
  ```
  then point this app's `DATABASE_URL` at it. The same role is the safe one to
  hand to any future SQL-generating LLM agent.

## Verifying changes

`preview`-style tooling can't run this server in some sandboxes; verify with:
```bash
node src/server.mjs &        # then
curl -s localhost:4000/api/overview | head -c 400
```
plus the jsdom render harness (drives the real SPA against the live API and
asserts on rendered views) if you keep one around from development.
