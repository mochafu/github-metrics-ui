import { rows, one } from "./db.mjs"

// Branches we treat as "production" for the merge/CI deployment proxies.
const MAIN = ["main", "master"]

// ===========================================================================
// DEPLOYMENT SIGNAL — the key piece of logic.
// 4 of the 5 DORA metrics need a "deployment". GitHub only gives a real one if
// a team uses the Deployments API, which most don't. So we fall down a ladder
// of proxies and report WHICH one we used, per repo:
//   1. GitHub Deployments (status=success)   ← the real signal
//   2. Releases (published)                   ← Leo's suggestion; good proxy
//   3. Merges to the default branch           ← trunk-based / continuous deploy
//   4. Successful CI runs on the default branch
// ===========================================================================
export async function deploymentEvents(repoId) {
  let ev = await rows(
    `select created_at as ts from deployments where repo_id=$1 and status='success' order by 1`,
    [repoId]
  )
  if (ev.length) return { method: "GitHub Deployments", events: ev }

  ev = await rows(
    `select published_at as ts from releases
     where repo_id=$1 and coalesce(draft,false)=false and published_at is not null order by 1`,
    [repoId]
  )
  if (ev.length) return { method: "Releases (proxy)", events: ev }

  ev = await rows(
    `select merged_at as ts from pull_requests
     where repo_id=$1 and merged_at is not null and base_branch = any($2) order by 1`,
    [repoId, MAIN]
  )
  if (ev.length) return { method: "Merges to main (proxy)", events: ev }

  ev = await rows(
    `select created_at as ts from workflow_runs
     where repo_id=$1 and conclusion='success' and head_branch = any($2) order by 1`,
    [repoId, MAIN]
  )
  if (ev.length) return { method: "CI on main (proxy)", events: ev }

  return { method: "none", events: [] }
}

// Org-wide deploy signal WITHOUT the per-repo N+1: one bucketed GROUP BY per
// ladder rung (4 queries total, constant in repo count), then the same
// first-non-empty-rung choice as deploymentEvents made per repo in JS. The
// old shape — deploymentEvents() for each repo — cost up to 4 round-trips × N
// repos per /api/trends call (~300 queries for this org) and was the whole
// reason trends took seconds. Rung choice counts ALL rows (even null
// timestamps, matching deploymentEvents); null timestamps just yield a null
// bucket that callers skip.
async function orgDeployRungBuckets(bucketExpr) {
  const [dep, rel, mrg, ci] = await Promise.all([
    rows(
      `select repo_id, ${bucketExpr("created_at")} b, count(*)::int n
       from deployments where status='success' group by 1, 2`
    ),
    rows(
      `select repo_id, ${bucketExpr("published_at")} b, count(*)::int n
       from releases where coalesce(draft,false)=false and published_at is not null group by 1, 2`
    ),
    rows(
      `select repo_id, ${bucketExpr("merged_at")} b, count(*)::int n
       from pull_requests where merged_at is not null and base_branch = any($1) group by 1, 2`,
      [MAIN]
    ),
    rows(
      `select repo_id, ${bucketExpr("created_at")} b, count(*)::int n
       from workflow_runs where conclusion='success' and head_branch = any($1) group by 1, 2`,
      [MAIN]
    ),
  ])
  return [
    { method: "GitHub Deployments",     rows: dep },
    { method: "Releases (proxy)",       rows: rel },
    { method: "Merges to main (proxy)", rows: mrg },
    { method: "CI on main (proxy)",     rows: ci },
  ]
}

// deploys per week over the active span, from count + first/last timestamps.
// Taking (count, min, max) instead of the full event list keeps the org-wide
// overview to a handful of GROUP BY queries no matter how many repos exist.
function perWeekFromSpan(n, mn, mx) {
  if (!n || !mn || !mx) return 0
  const weeks = Math.max(1, (new Date(mx) - new Date(mn)) / (1000 * 60 * 60 * 24 * 7))
  return n / weeks
}

// bucket any timestamped events into ISO-week start dates
function bucketByWeek(events) {
  const buckets = {}
  for (const e of events) {
    if (!e.ts) continue
    const key = weekKey(new Date(e.ts))
    buckets[key] = (buckets[key] || 0) + 1
  }
  return Object.entries(buckets)
    .sort()
    .map(([week, count]) => ({ week, count }))
}

// Monday of the ISO week, as YYYY-MM-DD (UTC) — matches Postgres date_trunc('week').
function weekKey(d) {
  const wk = new Date(d)
  wk.setUTCHours(0, 0, 0, 0)
  wk.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return wk.toISOString().slice(0, 10)
}

const asNum = (x) => (x == null ? null : Number(x))

// ===========================================================================
// REPO STATS — one object per repo with every column the overview table needs.
// All queries are org-wide GROUP BY repo_id (optionally filtered to one repo),
// so the query count stays constant as the number of repos grows.
// ===========================================================================
export async function repoStats(repoId = null) {
  const F = repoId ? "where repo_id=$1" : "" // for queries with no other where-clause
  const p = repoId ? [repoId] : []

  const [repos, commitAgg, prAgg, ciAgg, cfrAgg, mttrAgg, issueAgg, rungAgg, authorAgg] =
    await Promise.all([
      rows(`select id, full_name from repos ${repoId ? "where id=$1" : ""} order by full_name`, p),

      rows(
        `select repo_id,
                count(*)::int commits,
                count(distinct author_login) filter (where author_is_bot is not true and author_login is not null)::int contributors,
                max(authored_at) last_commit
         from commits ${F} group by repo_id`,
        p
      ),

      rows(
        `select repo_id,
                count(*)::int total,
                count(*) filter (where merged_at is not null)::int merged,
                count(*) filter (where state='open')::int open,
                count(*) filter (where state='closed' and merged_at is null)::int closed_unmerged,
                percentile_cont(0.5) within group (order by extract(epoch from (merged_at-created_at))/3600.0)
                  filter (where merged_at is not null) p50,
                percentile_cont(0.9) within group (order by extract(epoch from (merged_at-created_at))/3600.0)
                  filter (where merged_at is not null) p90,
                max(created_at) last_pr
         from pull_requests ${F} group by repo_id`,
        p
      ),

      rows(
        `select repo_id,
                count(*) filter (where conclusion='success')::int ok,
                count(*) filter (where conclusion is not null)::int done,
                max(created_at) last_run
         from workflow_runs ${F} group by repo_id`,
        p
      ),

      // DORA: change failure rate — failed CI runs on the default branch.
      // (Real deployment statuses would be better; none of our repos emit them yet.)
      rows(
        `select repo_id,
                count(*) filter (where conclusion='failure')::int bad,
                count(*) filter (where conclusion in ('success','failure'))::int done
         from workflow_runs where head_branch = any($1) ${repoId ? "and repo_id=$2" : ""}
         group by repo_id`,
        repoId ? [MAIN, repoId] : [MAIN]
      ),

      // DORA: MTTR proxy — median hours from the START of a red streak on the
      // default branch to the next green run. lag() marks streak starts so a
      // run of consecutive failures counts once, from its first failure.
      rows(
        `with evs as (
           select repo_id, created_at ts, conclusion c,
                  lag(conclusion) over (partition by repo_id order by created_at) prev
           from workflow_runs
           where head_branch = any($1) and conclusion in ('success','failure')
             ${repoId ? "and repo_id=$2" : ""}
         ),
         starts as (select repo_id, ts from evs where c='failure' and (prev is null or prev='success')),
         rec as (
           select s.repo_id, s.ts f,
                  (select min(e.ts) from evs e where e.repo_id=s.repo_id and e.c='success' and e.ts > s.ts) r
           from starts s
         )
         select repo_id,
                percentile_cont(0.5) within group (order by extract(epoch from (r-f))/3600.0)
                  filter (where r is not null) p50,
                count(*)::int failures,
                count(r)::int recovered
         from rec group by repo_id`,
        repoId ? [MAIN, repoId] : [MAIN]
      ),

      rows(
        `select repo_id,
                count(*) filter (where state='open')::int open,
                count(*) filter (where state='closed')::int closed,
                percentile_cont(0.5) within group (order by extract(epoch from (closed_at-created_at))/3600.0)
                  filter (where closed_at is not null) p50_close
         from issues ${F} group by repo_id`,
        p
      ),

      // Deploy-signal ladder, aggregated: (count, first, last) per rung per repo.
      // All 4 rungs ride ONE round-trip via UNION ALL — they were 4 separate
      // queries, and against a remote pooler the trip costs more than the scan.
      rows(
        `select 'dep' rung, repo_id, count(*)::int n, min(created_at) mn, max(created_at) mx
           from deployments where status='success' ${repoId ? "and repo_id=$2" : ""} group by repo_id
         union all
         select 'rel', repo_id, count(*)::int, min(published_at), max(published_at)
           from releases where coalesce(draft,false)=false and published_at is not null
             ${repoId ? "and repo_id=$2" : ""} group by repo_id
         union all
         select 'mrg', repo_id, count(*)::int, min(merged_at), max(merged_at)
           from pull_requests where merged_at is not null and base_branch = any($1)
             ${repoId ? "and repo_id=$2" : ""} group by repo_id
         union all
         select 'ci', repo_id, count(*)::int, min(created_at), max(created_at)
           from workflow_runs where conclusion='success' and head_branch = any($1)
             ${repoId ? "and repo_id=$2" : ""} group by repo_id`,
        repoId ? [MAIN, repoId] : [MAIN]
      ),

      // per-repo, per-author commit counts → contribution concentration (bus factor).
      // Team-level RISK signal, deliberately NOT a per-person ranking.
      // (Already has a WHERE, so scope with `and repo_id`, not the bare F clause.)
      rows(
        `select repo_id, author_login, count(*)::int n
         from commits where author_is_bot is not true and author_login is not null
           ${repoId ? "and repo_id=$1" : ""}
         group by repo_id, author_login`,
        p
      ),
    ])

  const byRepo = (list) => Object.fromEntries(list.map((r) => [r.repo_id, r]))
  const cM = byRepo(commitAgg), pM = byRepo(prAgg), ciM = byRepo(ciAgg), cfrM = byRepo(cfrAgg),
        mtM = byRepo(mttrAgg), isM = byRepo(issueAgg)

  // group author commit-counts by repo, descending, for concentration math
  const authorsByRepo = {}
  for (const a of authorAgg) (authorsByRepo[a.repo_id] ||= []).push(a.n)
  for (const id in authorsByRepo) authorsByRepo[id].sort((x, y) => y - x)
  // bus factor = fewest contributors whose commits together reach 50% of the repo's
  // commits; topContribShare = the single largest contributor's share. Low bus
  // factor / high share = knowledge concentrated in few people (a delivery risk).
  const concentration = (counts) => {
    if (!counts || !counts.length) return { busFactor: null, topShare: null }
    const total = counts.reduce((a, b) => a + b, 0)
    if (!total) return { busFactor: null, topShare: null }
    let cum = 0, bf = 0
    for (const n of counts) { cum += n; bf++; if (cum * 2 >= total) break }
    return { busFactor: bf, topShare: counts[0] / total }
  }
  const rungRows = (key) => rungAgg.filter((r) => r.rung === key)
  const rungs = [
    { method: "GitHub Deployments",     map: byRepo(rungRows("dep")) },
    { method: "Releases (proxy)",       map: byRepo(rungRows("rel")) },
    { method: "Merges to main (proxy)", map: byRepo(rungRows("mrg")) },
    { method: "CI on main (proxy)",     map: byRepo(rungRows("ci")) },
  ]

  return repos.map((r) => {
    const c = cM[r.id] || {}, pr = pM[r.id] || {}, ci = ciM[r.id] || {}, cfr = cfrM[r.id] || {},
          mt = mtM[r.id] || {}, is = isM[r.id] || {}
    const rung = rungs.find((x) => x.map[r.id]?.n > 0)
    const dep = rung ? rung.map[r.id] : null
    const conc = concentration(authorsByRepo[r.id])
    const mergedClosed = (pr.merged || 0) + (pr.closed_unmerged || 0)
    const last = [c.last_commit, pr.last_pr, ci.last_run].filter(Boolean).map((d) => new Date(d).getTime())
    return {
      id: r.id,
      full_name: r.full_name,
      lastActivity: last.length ? new Date(Math.max(...last)).toISOString() : null,
      commits: c.commits || 0,
      contributors: c.contributors || 0,
      prsTotal: pr.total || 0,
      prsMerged: pr.merged || 0,
      prsOpen: pr.open || 0,
      prsClosedUnmerged: pr.closed_unmerged || 0,
      mergeRate: mergedClosed ? (pr.merged || 0) / mergedClosed : null,
      leadTimeP50h: asNum(pr.p50),
      leadTimeP90h: asNum(pr.p90),
      ciPassRate: ci.done ? ci.ok / ci.done : null,
      ciRuns: ci.done || 0,
      changeFailureRate: cfr.done ? cfr.bad / cfr.done : null,
      cfrMethod: cfr.done ? "CI on main (proxy)" : "none",
      mttrP50h: asNum(mt.p50),
      mttrFailures: mt.failures || 0,
      mttrRecovered: mt.recovered || 0,
      issuesOpen: is.open || 0,
      issuesClosed: is.closed || 0,
      issueCloseP50h: asNum(is.p50_close),
      deployMethod: rung ? rung.method : "none",
      deployCount: dep ? dep.n : 0,
      deployPerWeek: dep ? perWeekFromSpan(dep.n, dep.mn, dep.mx) : 0,
      busFactor: conc.busFactor,
      topContribShare: conc.topShare,
    }
  })
}

// ===========================================================================
// OVERVIEW — totals + per-repo table rows + data-freshness info.
// Freshness matters right now: the collector's backfill into the canonical DB
// is still in flight, so the UI must say how current the numbers are.
// ===========================================================================
export async function overview(range = "12m") {
  // Range-scoped `since` fragment for the two KPI figures the client can't
  // derive by summing trend buckets: DISTINCT contributors (summing per-bucket
  // counts would double-count anyone active in >1 bucket) and the median lead
  // time (a median of medians is not the median). Everything else the overview
  // KPIs show is a clean function of the bucket sums and is computed client-side
  // from /api/trends, so it stays perfectly consistent with the charts.
  const def = RANGE_DEFS[range] || RANGE_DEFS["12m"]
  const RS = (col) => (def.since ? `and ${col} >= ${def.since}` : "")

  // All-time / 30-day / in-range variants of the same aggregate are FILTER
  // clauses on ONE scan, not separate queries — the DB is remote, so each
  // avoided query is an avoided round-trip. (`where true ${RS(...)}` degrades
  // to an unfiltered aggregate for the "all" range, matching the old queries.)
  const [repos, lead, contrib] = await Promise.all([
    repoStats(),
    one(
      `select percentile_cont(0.5) within group (order by extract(epoch from (merged_at-created_at))/3600.0) p50,
              percentile_cont(0.5) within group (order by extract(epoch from (merged_at-created_at))/3600.0)
                filter (where true ${RS("merged_at")}) p50_range
       from pull_requests where merged_at is not null`
    ),
    one(
      `select count(distinct author_login)::int n,
              count(distinct author_login) filter (where authored_at >= now() - interval '30 days')::int n_30d,
              count(distinct author_login) filter (where true ${RS("authored_at")})::int n_range
       from commits where author_login is not null and author_is_bot is not true`
    ),
  ])
  const sum = (f) => repos.reduce((a, r) => a + (f(r) || 0), 0)
  const prsMerged = sum((r) => r.prsMerged)
  const mergedClosed = prsMerged + sum((r) => r.prsClosedUnmerged)
  const latest = repos.map((r) => r.lastActivity).filter(Boolean).sort().pop() || null
  return {
    totals: {
      repos: repos.length,
      prsOpened: sum((r) => r.prsTotal),
      prsMerged,
      mergeRate: mergedClosed ? prsMerged / mergedClosed : null,
      commits: sum((r) => r.commits),
      deployEvents: sum((r) => r.deployCount),
      leadTimeP50h: asNum(lead?.p50),
      contributors: contrib.n,
      activeContributors30d: contrib.n_30d,
      issuesOpen: sum((r) => r.issuesOpen),
      issuesClosed: sum((r) => r.issuesClosed),
      ciPassRate: (() => {
        const done = sum((r) => r.ciRuns)
        return done ? repos.reduce((a, r) => a + (r.ciPassRate || 0) * r.ciRuns, 0) / done : null
      })(),
    },
    repos,
    range,
    // Range-scoped figures for the top KPI cards (see note above).
    rangeExtras: {
      contributors: contrib.n_range,        // distinct authors who committed in-range
      leadTimeP50h: asNum(lead?.p50_range), // median PR open→merge for merges in-range
    },
    freshness: { latestEvent: latest, generatedAt: new Date().toISOString() },
  }
}

// ===========================================================================
// TRENDS — the 6w / 12m / all-history engine behind every chart + sparkline.
// One bucket per ISO week (6w) or month (12m, all), zero-filled so charts
// don't silently skip quiet periods. Works org-wide or for a single repo.
// ===========================================================================
const RANGE_DEFS = {
  // since-expressions are fixed SQL fragments chosen by whitelist key — never
  // interpolated from user input. `trunc` is the bucket size for each range.
  "1d":  { trunc: "hour",  since: `now() - interval '24 hours'` },
  "1w":  { trunc: "day",   since: `date_trunc('day',   now()) - interval '6 days'` },
  "6w":  { trunc: "week",  since: `date_trunc('week',  now()) - interval '5 weeks'` },
  "12m": { trunc: "month", since: `date_trunc('month', now()) - interval '11 months'` },
  "all": { trunc: "month", since: null },
}
export const TREND_RANGES = Object.keys(RANGE_DEFS)

// to_char format string per bucket size — must match the JS keys below so
// deploy events (bucketed in JS) line up with the SQL-bucketed series.
const KEY_FMT = { hour: `YYYY-MM-DD"T"HH24`, day: "YYYY-MM-DD", week: "YYYY-MM-DD", month: "YYYY-MM" }

function bucketKeyFor(trunc, date) {
  const d = new Date(date)
  if (trunc === "month") return d.toISOString().slice(0, 7)
  if (trunc === "hour")  return d.toISOString().slice(0, 13) // YYYY-MM-DDTHH
  if (trunc === "day")   return d.toISOString().slice(0, 10)
  return weekKey(d) // week → Monday
}

function nextBucket(trunc, key) {
  if (trunc === "month") {
    const [y, m] = key.split("-").map(Number)
    return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7)
  }
  if (trunc === "hour") {
    const d = new Date(key + ":00:00Z")
    d.setUTCHours(d.getUTCHours() + 1)
    return d.toISOString().slice(0, 13)
  }
  const d = new Date(key + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + (trunc === "day" ? 1 : 7))
  return d.toISOString().slice(0, trunc === "day" ? 10 : 10)
}

function sinceDateJs(range) {
  const now = new Date()
  if (range === "1d") {
    const h = new Date(now); h.setUTCMinutes(0, 0, 0)
    h.setUTCHours(h.getUTCHours() - 23) // 24 hourly buckets incl. the current one
    return h
  }
  if (range === "1w") {
    const d = new Date(now); d.setUTCHours(0, 0, 0, 0)
    d.setUTCDate(d.getUTCDate() - 6) // 7 daily buckets incl. today
    return d
  }
  if (range === "6w") {
    const monday = new Date(weekKey(now) + "T00:00:00Z")
    monday.setUTCDate(monday.getUTCDate() - 35)
    return monday
  }
  if (range === "12m") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))
  return null
}

export async function trends(range, repoId = null) {
  const def = RANGE_DEFS[range] || RANGE_DEFS["12m"]
  const { trunc, since } = def
  const key = KEY_FMT[trunc]
  const B = (col) => `to_char(date_trunc('${trunc}', ${col}), '${key}')`
  const S = (col) => (since ? `and ${col} >= ${since}` : "")
  const RF = repoId ? "and repo_id=$1" : ""
  const p = repoId ? [repoId] : []

  const [commits, prsOpened, prsMerged, ci, issuesOpened, issuesClosed, reviews] = await Promise.all([
    rows(
      `select ${B("authored_at")} b, count(*)::int n,
              count(distinct author_login) filter (where author_login is not null)::int c
       from commits where authored_at is not null and author_is_bot is not true ${RF} ${S("authored_at")}
       group by 1`,
      p
    ),
    rows(
      `select ${B("created_at")} b, count(*)::int n
       from pull_requests where created_at is not null ${RF} ${S("created_at")} group by 1`,
      p
    ),
    rows(
      `select ${B("merged_at")} b, count(*)::int n,
              percentile_cont(0.5) within group (order by extract(epoch from (merged_at-created_at))/3600.0) p50
       from pull_requests where merged_at is not null ${RF} ${S("merged_at")} group by 1`,
      p
    ),
    rows(
      `select ${B("created_at")} b,
              count(*) filter (where conclusion='success')::int ok,
              count(*) filter (where conclusion is not null)::int done
       from workflow_runs where created_at is not null ${RF} ${S("created_at")} group by 1`,
      p
    ),
    rows(
      `select ${B("created_at")} b, count(*)::int n
       from issues where created_at is not null ${RF} ${S("created_at")} group by 1`,
      p
    ),
    rows(
      `select ${B("closed_at")} b, count(*)::int n
       from issues where closed_at is not null ${RF} ${S("closed_at")} group by 1`,
      p
    ),
    rows(
      `select ${B("submitted_at")} b, count(*)::int n
       from pr_reviews where submitted_at is not null ${RF} ${S("submitted_at")} group by 1`,
      p
    ),
  ])

  // Deploy series: the per-repo signal ladder, bucketed to match the SQL series.
  // The cutoff is bucket-aligned (sinceDateJs), so filtering by bucket key is
  // exactly the old per-event date filter.
  const cutoff = sinceDateJs(range)
  const cutoffKey = cutoff ? bucketKeyFor(trunc, cutoff) : null
  let deployMethod = "none"
  const deployBuckets = {}
  if (repoId) {
    const dep = await deploymentEvents(repoId)
    deployMethod = dep.method
    for (const e of dep.events) {
      if (!e.ts) continue
      const k = bucketKeyFor(trunc, new Date(e.ts))
      if (cutoffKey && k < cutoffKey) continue
      deployBuckets[k] = (deployBuckets[k] || 0) + 1
    }
  } else {
    // 4 org-wide queries instead of 4 × N-repos; same ladder, same buckets.
    const rungs = await orgDeployRungBuckets((col) => `to_char(date_trunc('${trunc}', ${col}), '${key}')`)
    const chosen = new Map() // repo_id -> { method, rows } for its first non-empty rung
    for (const rung of rungs) {
      for (const r of rung.rows) {
        let e = chosen.get(r.repo_id)
        if (!e) chosen.set(r.repo_id, (e = { method: rung.method, rows: [] }))
        if (e.method === rung.method) e.rows.push(r)
      }
    }
    const methods = new Set()
    for (const { method, rows: rs } of chosen.values()) {
      methods.add(method)
      for (const r of rs) {
        if (!r.b || (cutoffKey && r.b < cutoffKey)) continue
        deployBuckets[r.b] = (deployBuckets[r.b] || 0) + r.n
      }
    }
    deployMethod = methods.size === 0 ? "none" : methods.size === 1 ? [...methods][0] : "mixed (per-repo proxies)"
  }

  // Zero-fill from the first observed (or range-start) bucket through now.
  const maps = [commits, prsOpened, prsMerged, ci, issuesOpened, issuesClosed, reviews]
    .map((list) => Object.fromEntries(list.map((r) => [r.b, r])))
  const allKeys = [...maps.flatMap((m) => Object.keys(m)), ...Object.keys(deployBuckets)]
  let start = cutoff ? bucketKeyFor(trunc, cutoff) : allKeys.sort()[0]
  const end = bucketKeyFor(trunc, new Date())
  const buckets = []
  if (start) {
    // hard cap protects against a pathological timestamp far in the past
    for (let k = start, i = 0; k <= end && i < 600; k = nextBucket(trunc, k), i++) {
      const [cm, po, pm, cir, io, ic, rv] = maps.map((m) => m[k])
      buckets.push({
        bucket: k,
        commits: cm?.n || 0,
        activeContributors: cm?.c || 0,
        prsOpened: po?.n || 0,
        prsMerged: pm?.n || 0,
        leadTimeP50h: asNum(pm?.p50),
        ciRuns: cir?.done || 0,
        ciPassRate: cir?.done ? cir.ok / cir.done : null,
        deploys: deployBuckets[k] || 0,
        issuesOpened: io?.n || 0,
        issuesClosed: ic?.n || 0,
        reviews: rv?.n || 0,
      })
    }
  }
  return { range: RANGE_DEFS[range] ? range : "12m", interval: trunc, deployMethod, buckets }
}

// ===========================================================================
// TEAM — a directory, deliberately NOT a leaderboard. Sorted by recency of
// activity (who's around), never by volume. Volume columns exist for context
// and the client can sort, but the default framing is "who is on the team".
// ===========================================================================
export async function teamDirectory() {
  const [contributors, typeBreakdown, active30Row] = await Promise.all([
    rows(
      `with c as (
         select author_login login, count(*)::int commits, count(distinct repo_id)::int repos,
                min(authored_at) first_active, max(authored_at) last_active
         from commits where author_is_bot is not true and author_login is not null
         group by 1
       ),
       p as (
         select author_login login, count(*)::int prs_opened,
                count(*) filter (where merged_at is not null)::int prs_merged
         from pull_requests where author_login is not null group by 1
       ),
       r as (
         select reviewer_login login, count(*)::int reviews_given
         from pr_reviews where reviewer_login is not null and reviewer_is_bot is not true group by 1
       )
       select c.login, c.commits, c.repos, c.first_active, c.last_active,
              coalesce(p.prs_opened, 0)  prs_opened,
              coalesce(p.prs_merged, 0)  prs_merged,
              coalesce(r.reviews_given, 0) reviews_given
       from c left join p using(login) left join r using(login)
       order by c.last_active desc nulls last`
    ),
    rows(
      `select commit_analysis->>'change_type' change_type, count(*)::int count
       from commits
       where author_is_bot is not true and commit_analysis->>'change_type' is not null
       group by 1 order by 2 desc`
    ),
    one(
      `select count(distinct author_login)::int n from commits
       where author_login is not null and author_is_bot is not true
         and authored_at >= now() - interval '30 days'`
    ),
  ])
  return { contributors, typeBreakdown, activeLast30d: active30Row.n }
}

// ===========================================================================
// STATUS — diagnostic endpoint: row counts + freshest event per table, so
// "is the backfill still filling in?" is answerable from the UI itself.
// ===========================================================================
export async function dataStatus() {
  const [counts, freshest] = await Promise.all([
    one(
      `select
         (select count(*) from repos)::int          repos,
         (select count(*) from commits)::int        commits,
         (select count(*) from pull_requests)::int  pull_requests,
         (select count(*) from pr_reviews)::int     pr_reviews,
         (select count(*) from issues)::int         issues,
         (select count(*) from workflow_runs)::int  workflow_runs,
         (select count(*) from deployments)::int    deployments,
         (select count(*) from releases)::int       releases`
    ),
    one(
      `select greatest(
         (select max(authored_at) from commits),
         (select max(created_at) from pull_requests),
         (select max(created_at) from workflow_runs),
         (select max(created_at) from issues)
       ) latest`
    ),
  ])
  return { counts, latestEvent: freshest.latest, generatedAt: new Date().toISOString() }
}

// ===========================================================================
// ACTIVITY PUNCHCARD — commits by day-of-week × hour-of-day (UTC), a GitHub-
// style working-patterns heatmap. Purely descriptive & team-level. dow: 0=Sun.
// ===========================================================================
export async function activityPunchcard(repoId = null) {
  const where = repoId ? "and repo_id=$1" : ""
  const p = repoId ? [repoId] : []
  const data = await rows(
    `select extract(dow  from authored_at)::int as dow,
            extract(hour from authored_at)::int as hr,
            count(*)::int as n
     from commits
     where author_is_bot is not true and authored_at is not null ${where}
     group by 1, 2`,
    p
  )
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0))
  const byDow = new Array(7).fill(0), byHour = new Array(24).fill(0)
  let total = 0, weekend = 0, afterHours = 0, peak = { dow: 0, hour: 0, n: 0 }
  for (const r of data) {
    if (r.dow == null || r.hr == null) continue
    grid[r.dow][r.hr] = r.n
    byDow[r.dow] += r.n
    byHour[r.hr] += r.n
    total += r.n
    if (r.dow === 0 || r.dow === 6) weekend += r.n
    if (r.hr < 9 || r.hr >= 18) afterHours += r.n // outside 09:00–18:00 UTC
    if (r.n > peak.n) peak = { dow: r.dow, hour: r.hr, n: r.n }
  }
  return {
    grid, byDow, byHour, total,
    weekendPct: total ? weekend / total : null,
    afterHoursPct: total ? afterHours / total : null,
    peak: total ? peak : null,
    tz: "UTC",
  }
}

// ===========================================================================
// WORKFLOW / CI RELIABILITY — per named workflow: run count, pass rate, retry
// rate (run_attempt>1), median wall-clock minutes, last run. Plus an org/repo
// summary. Answers "which pipelines are flaky or slow?".
// ===========================================================================
export async function workflowInsights(repoId = null) {
  const where = repoId ? "and repo_id=$1" : ""
  const p = repoId ? [repoId] : []
  const dur =
    `percentile_cont(0.5) within group (order by extract(epoch from (updated_at - run_started_at))/60.0)
       filter (where run_started_at is not null and updated_at is not null and conclusion is not null)`
  const [wf, summary] = await Promise.all([
    rows(
      `select name,
              count(*)::int runs,
              count(*) filter (where conclusion='success')::int ok,
              count(*) filter (where conclusion in ('success','failure'))::int done,
              count(*) filter (where run_attempt > 1)::int retried,
              ${dur} p50_min,
              max(created_at) last_run
       from workflow_runs where name is not null ${where}
       group by 1 order by runs desc limit 40`,
      p
    ),
    one(
      `select count(*)::int runs,
              count(*) filter (where conclusion='success')::int ok,
              count(*) filter (where conclusion in ('success','failure'))::int done,
              count(*) filter (where run_attempt > 1)::int retried,
              count(distinct name)::int workflows,
              ${dur} p50_min
       from workflow_runs where name is not null ${where}`,
      p
    ),
  ])
  return {
    workflows: wf.map((w) => ({
      name: w.name,
      runs: w.runs,
      passRate: w.done ? w.ok / w.done : null,
      retryRate: w.runs ? w.retried / w.runs : null,
      durationP50min: asNum(w.p50_min),
      lastRun: w.last_run,
    })),
    summary: {
      runs: summary.runs || 0,
      workflows: summary.workflows || 0,
      passRate: summary.done ? summary.ok / summary.done : null,
      retryRate: summary.runs ? summary.retried / summary.runs : null,
      durationP50min: asNum(summary.p50_min),
    },
  }
}

// ===========================================================================
// REVIEW HEALTH — outcome mix (approved / changes-requested / commented),
// review coverage of merged PRs, and reviews-per-merged-PR. Org-wide or per repo.
// ===========================================================================
export async function reviewHealth(repoId = null) {
  const rw = repoId ? "and repo_id=$1" : ""
  const p = repoId ? [repoId] : []
  const [states, cov] = await Promise.all([
    rows(
      `select upper(state) state, count(*)::int n from pr_reviews
       where reviewer_is_bot is not true and state is not null ${rw} group by 1`,
      p
    ),
    one(
      `select count(*)::int merged,
              count(*) filter (where exists (
                select 1 from pr_reviews r where r.repo_id=p.repo_id and r.pr_number=p.number
                  and r.reviewer_is_bot is not true
              ))::int reviewed
       from pull_requests p where merged_at is not null ${repoId ? "and p.repo_id=$1" : ""}`,
      p
    ),
  ])
  const byState = Object.fromEntries(states.map((s) => [s.state, s.n]))
  const total = states.reduce((a, s) => a + s.n, 0)
  return {
    total,
    approved: byState.APPROVED || 0,
    changesRequested: byState.CHANGES_REQUESTED || 0,
    commented: byState.COMMENTED || 0,
    dismissed: byState.DISMISSED || 0,
    mergedPRs: cov.merged || 0,
    coverage: cov.merged ? cov.reviewed / cov.merged : null,
    reviewsPerMergedPR: cov.merged ? total / cov.merged : null,
  }
}

// ===========================================================================
// ISSUE INSIGHTS — resolution mix (completed vs not-planned via state_reason),
// open-backlog aging buckets, comment engagement, median time-to-close.
// ===========================================================================
export async function issueInsights(repoId = null) {
  const w = repoId ? "and repo_id=$1" : ""
  const p = repoId ? [repoId] : []
  const r = await one(
    `select
       count(*) filter (where state='open')::int open,
       count(*) filter (where state='closed')::int closed,
       count(*) filter (where state='closed' and state_reason='completed')::int completed,
       count(*) filter (where state='closed' and state_reason='not_planned')::int not_planned,
       count(*) filter (where state='open' and created_at >= now() - interval '7 days')::int open_lt1w,
       count(*) filter (where state='open' and created_at <  now() - interval '7 days'
                          and created_at >= now() - interval '30 days')::int open_1to4w,
       count(*) filter (where state='open' and created_at <  now() - interval '30 days')::int open_gt1mo,
       percentile_cont(0.5) within group (order by comments) filter (where comments is not null) comments_p50,
       percentile_cont(0.5) within group (order by extract(epoch from (closed_at-created_at))/3600.0)
         filter (where closed_at is not null) close_p50h
     from issues where user_is_bot is not true ${w}`,
    p
  )
  const closedTyped = (r.completed || 0) + (r.not_planned || 0)
  return {
    open: r.open || 0, closed: r.closed || 0,
    completed: r.completed || 0, notPlanned: r.not_planned || 0,
    completionRate: closedTyped ? r.completed / closedTyped : null,
    aging: { lt1w: r.open_lt1w || 0, w1to4: r.open_1to4w || 0, gt1mo: r.open_gt1mo || 0 },
    commentsP50: asNum(r.comments_p50),
    closeP50h: asNum(r.close_p50h),
  }
}

// ===========================================================================
// WEEKLY COMMIT DIGEST
// Groups commits by ISO week (last 12 weeks), with per-change-type counts
// and LLM summaries from commit_analysis when available.
// ===========================================================================
export async function weeklyCommitDigest(repoId) {
  return rows(
    `SELECT
       to_char(date_trunc('week', authored_at), 'YYYY-MM-DD') AS week,
       count(*)::int                                            AS total,
       count(DISTINCT author_login)::int                       AS contributors,
       count(*) FILTER (WHERE commit_analysis->>'change_type' = 'new_feature')::int AS new_features,
       count(*) FILTER (WHERE commit_analysis->>'change_type' = 'bug_fix')::int     AS bug_fixes,
       count(*) FILTER (WHERE commit_analysis->>'change_type' = 'refactor')::int    AS refactors,
       count(*) FILTER (WHERE commit_analysis->>'change_type' = 'test')::int        AS tests,
       count(*) FILTER (WHERE commit_analysis->>'change_type' = 'docs')::int        AS docs,
       count(*) FILTER (WHERE commit_analysis->>'change_type' = 'config')::int      AS configs,
       count(*) FILTER (WHERE commit_analysis->>'change_type' = 'chore')::int       AS chores,
       jsonb_agg(
         jsonb_build_object(
           'sha',         sha,
           'summary',     commit_analysis->>'summary',
           'change_type', commit_analysis->>'change_type',
           'domain',      commit_analysis->>'domain',
           'author',      author_login
         ) ORDER BY authored_at DESC
       ) FILTER (WHERE commit_analysis IS NOT NULL) AS analyses
     FROM commits
     WHERE repo_id = $1
       AND author_is_bot IS NOT TRUE
       AND authored_at >= NOW() - INTERVAL '12 weeks'
     GROUP BY 1
     ORDER BY 1 DESC`,
    [repoId]
  )
}

export async function reviewMetrics(repoId) {
  const cov = await one(
    `select count(*)::int merged,
            count(*) filter (where exists (
              select 1 from pr_reviews r where r.repo_id=p.repo_id and r.pr_number=p.number
            ))::int reviewed
     from pull_requests p where p.repo_id=$1 and p.merged_at is not null`,
    [repoId]
  )
  const ttfr = await one(
    `select percentile_cont(0.5) within group (order by hrs) p50 from (
       select extract(epoch from (min(r.submitted_at) - p.created_at))/3600.0 hrs
       from pull_requests p
       join pr_reviews r on r.repo_id=p.repo_id and r.pr_number=p.number
       where p.repo_id=$1 and r.submitted_at is not null
       group by p.id, p.created_at
     ) s where hrs >= 0`,
    [repoId]
  )
  return {
    coverage: cov.merged ? cov.reviewed / cov.merged : null,
    timeToFirstReviewP50h: ttfr && ttfr.p50 != null ? Number(ttfr.p50) : null,
  }
}

export async function recentPRs(repoId, limit = 10) {
  const lim = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)))
  return rows(
    `select number, title, state, author_login, created_at, merged_at
     from pull_requests where repo_id=$1 order by created_at desc nulls last limit $2`,
    [repoId, lim]
  )
}

// All contributors for a single repo with per-commit-type breakdown and PR stats.
// Ordered by recency (who's active), not by commit count — no leaderboard.
export async function repoContributors(repoId) {
  return rows(
    `WITH commit_stats AS (
       SELECT
         author_login                                                                    AS login,
         COUNT(*)::int                                                                   AS commits,
         COUNT(*) FILTER (WHERE commit_analysis->>'change_type'='new_feature')::int     AS new_features,
         COUNT(*) FILTER (WHERE commit_analysis->>'change_type'='bug_fix')::int         AS bug_fixes,
         COUNT(*) FILTER (WHERE commit_analysis->>'change_type'='refactor')::int        AS refactors,
         COUNT(*) FILTER (WHERE commit_analysis->>'change_type'='test')::int            AS tests,
         COUNT(*) FILTER (WHERE commit_analysis->>'change_type'='docs')::int            AS docs,
         COUNT(*) FILTER (WHERE commit_analysis->>'change_type'='config')::int          AS configs,
         COUNT(*) FILTER (WHERE commit_analysis->>'change_type'='chore')::int           AS chores,
         MIN(authored_at)                                                                AS first_commit,
         MAX(authored_at)                                                                AS last_commit
       FROM commits
       WHERE repo_id=$1 AND author_is_bot IS NOT TRUE AND author_login IS NOT NULL
       GROUP BY author_login
     ),
     pr_stats AS (
       SELECT author_login AS login,
              COUNT(*)::int                                                              AS prs_opened,
              COUNT(*) FILTER (WHERE merged_at IS NOT NULL)::int                        AS prs_merged,
              COUNT(*) FILTER (WHERE state='closed' AND merged_at IS NULL)::int         AS prs_closed_unmerged
       FROM pull_requests WHERE repo_id=$1 AND author_login IS NOT NULL GROUP BY author_login
     )
     SELECT c.login, c.commits, c.new_features, c.bug_fixes, c.refactors, c.tests,
            c.docs, c.configs, c.chores, c.first_commit, c.last_commit,
            COALESCE(p.prs_opened, 0)           AS prs_opened,
            COALESCE(p.prs_merged, 0)           AS prs_merged,
            COALESCE(p.prs_closed_unmerged, 0)  AS prs_closed_unmerged
     FROM commit_stats c LEFT JOIN pr_stats p ON p.login=c.login
     ORDER BY last_commit DESC NULLS LAST`,
    [repoId]
  )
}

// Full cross-repo profile for a single contributor.
export async function contributorProfile(login) {
  const [summary, prStats, typeBreakdown, topDomains, weeklyActivity, repoContribs, recentActivity] = await Promise.all([
    one(
      `SELECT COUNT(*)::int AS total_commits, COUNT(DISTINCT repo_id)::int AS repos_count,
              MIN(authored_at) AS first_commit, MAX(authored_at) AS last_commit
       FROM commits WHERE author_login=$1 AND author_is_bot IS NOT TRUE`,
      [login]
    ),
    one(
      `SELECT COUNT(*)::int                                                                    AS prs_opened,
              COUNT(*) FILTER (WHERE merged_at IS NOT NULL)::int                               AS prs_merged,
              COUNT(*) FILTER (WHERE state='closed' AND merged_at IS NULL)::int                AS prs_closed_unmerged,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
                EXTRACT(EPOCH FROM (merged_at-created_at))/3600.0)                            AS lead_time_p50h,
              PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY
                EXTRACT(EPOCH FROM (merged_at-created_at))/3600.0)                            AS lead_time_p90h
       FROM pull_requests WHERE author_login=$1`,
      [login]
    ),
    rows(
      `SELECT commit_analysis->>'change_type' AS change_type, COUNT(*)::int AS count
       FROM commits
       WHERE author_login=$1 AND author_is_bot IS NOT TRUE
         AND commit_analysis IS NOT NULL AND commit_analysis->>'change_type' IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC`,
      [login]
    ),
    rows(
      `SELECT commit_analysis->>'domain' AS domain, COUNT(*)::int AS count
       FROM commits
       WHERE author_login=$1 AND author_is_bot IS NOT TRUE
         AND commit_analysis->>'domain' IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
      [login]
    ),
    rows(
      `SELECT to_char(date_trunc('week', authored_at),'YYYY-MM-DD') AS week, COUNT(*)::int AS commits
       FROM commits
       WHERE author_login=$1 AND author_is_bot IS NOT TRUE
         AND authored_at >= NOW() - INTERVAL '12 weeks'
       GROUP BY 1 ORDER BY 1`,
      [login]
    ),
    rows(
      `SELECT r.id, r.full_name, c.commits, COALESCE(p.prs, 0) AS prs
       FROM (SELECT repo_id, COUNT(*)::int AS commits
             FROM commits WHERE author_login=$1 AND author_is_bot IS NOT TRUE GROUP BY repo_id) c
       JOIN repos r ON r.id=c.repo_id
       LEFT JOIN (SELECT repo_id, COUNT(*)::int AS prs
                  FROM pull_requests WHERE author_login=$1 GROUP BY repo_id) p ON p.repo_id=c.repo_id
       ORDER BY commits DESC`,
      [login]
    ),
    rows(
      `SELECT c.authored_at,
              c.commit_analysis->>'summary'     AS summary,
              c.commit_analysis->>'change_type' AS change_type,
              c.commit_analysis->>'domain'      AS domain,
              r.full_name                        AS repo
       FROM commits c JOIN repos r ON r.id=c.repo_id
       WHERE c.author_login=$1 AND c.author_is_bot IS NOT TRUE
         AND c.commit_analysis->>'summary' IS NOT NULL
       ORDER BY c.authored_at DESC LIMIT 15`,
      [login]
    ),
  ])
  const mergedClosed = (prStats.prs_merged || 0) + (prStats.prs_closed_unmerged || 0)
  return {
    login,
    summary: {
      totalCommits: summary?.total_commits || 0,
      reposCount:   summary?.repos_count   || 0,
      firstCommit:  summary?.first_commit  || null,
      lastCommit:   summary?.last_commit   || null,
      prsOpened:    prStats.prs_opened     || 0,
      prsMerged:    prStats.prs_merged     || 0,
      mergeRate:    mergedClosed ? (prStats.prs_merged / mergedClosed) : null,
      leadTimeP50h: asNum(prStats.lead_time_p50h),
      leadTimeP90h: asNum(prStats.lead_time_p90h),
    },
    typeBreakdown,
    topDomains,
    weeklyActivity,
    repos: repoContribs,
    recentActivity,
  }
}

// Every non-bot commit for the scatter timeline chart.
export async function repoCommitTimeline(repoId) {
  return rows(
    `SELECT sha, author_login,
            authored_at,
            commit_analysis->>'summary'     AS summary,
            commit_analysis->>'change_type' AS change_type,
            commit_analysis->>'domain'      AS domain
     FROM commits
     WHERE repo_id=$1 AND author_is_bot IS NOT TRUE AND author_login IS NOT NULL
     ORDER BY authored_at ASC
     LIMIT 2000`,
    [repoId]
  )
}

// All commits for a contributor — used for the per-profile stacked activity chart.
export async function contributorCommits(login) {
  return rows(
    `SELECT sha,
            authored_at,
            COALESCE(additions, 0)::int  AS additions,
            COALESCE(deletions, 0)::int  AS deletions,
            COALESCE(file_count, 0)::int AS file_count,
            commit_analysis->>'summary'     AS summary,
            commit_analysis->>'change_type' AS change_type,
            commit_analysis->>'domain'      AS domain
     FROM commits
     WHERE author_login=$1 AND author_is_bot IS NOT TRUE AND author_login IS NOT NULL
     ORDER BY authored_at ASC
     LIMIT 2000`,
    [login]
  )
}

export async function repoDetail(repoId) {
  const [stats] = await repoStats(repoId)
  if (!stats) return null
  // deploymentEvents runs once here for the weekly deploy series; the summary's
  // deploy columns come from the aggregated rung queries inside repoStats.
  const [dep, reviews, recent] = await Promise.all([
    deploymentEvents(repoId),
    reviewMetrics(repoId),
    recentPRs(repoId, 10),
  ])
  return {
    repo: { id: stats.id, full_name: stats.full_name },
    summary: stats,
    deploys: { method: dep.method, series: bucketByWeek(dep.events) },
    reviews,
    recentPRs: recent,
  }
}
