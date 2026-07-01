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

// deploys per week, averaged over the active span.
// Single-pass min/max (no Math.max(...spread)) so it stays safe on large event
// sets — the "CI on main" proxy can return thousands of rows.
function perWeek(events) {
  let min = Infinity
  let max = -Infinity
  let valid = 0
  for (const e of events) {
    if (!e.ts) continue
    const t = new Date(e.ts).getTime()
    if (Number.isNaN(t)) continue
    if (t < min) min = t
    if (t > max) max = t
    valid++
  }
  if (valid < 1) return 0
  const weeks = Math.max(1, (max - min) / (1000 * 60 * 60 * 24 * 7))
  return events.length / weeks
}

// bucket any timestamped events into ISO-week start dates
function bucketByWeek(events) {
  const buckets = {}
  for (const e of events) {
    if (!e.ts) continue
    const d = new Date(e.ts)
    const wk = new Date(d)
    wk.setUTCHours(0, 0, 0, 0)
    wk.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) // back to Monday
    const key = wk.toISOString().slice(0, 10)
    buckets[key] = (buckets[key] || 0) + 1
  }
  return Object.entries(buckets)
    .sort()
    .map(([week, count]) => ({ week, count }))
}

// ===========================================================================
// CORE METRICS
// ===========================================================================
export async function repoSummary(repoId, dep = null) {
  // The six reads below are independent, so run them concurrently instead of in
  // a waterfall. `dep` (the deployment-signal ladder) may be supplied by callers
  // that already computed it — e.g. repoDetail — so it isn't run twice per repo.
  const [pr, lead, commitsRow, contributorsRow, ci, deploy] = await Promise.all([
    one(
      `select
         count(*)::int total,
         count(*) filter (where merged_at is not null)::int merged,
         count(*) filter (where state='closed' and merged_at is null)::int closed_unmerged,
         count(*) filter (where state='open')::int open
       from pull_requests where repo_id=$1`,
      [repoId]
    ),
    one(
      `select
         percentile_cont(0.5) within group (order by extract(epoch from (merged_at-created_at))/3600.0) p50,
         percentile_cont(0.9) within group (order by extract(epoch from (merged_at-created_at))/3600.0) p90
       from pull_requests where repo_id=$1 and merged_at is not null`,
      [repoId]
    ),
    one(`select count(*)::int n from commits where repo_id=$1`, [repoId]),
    one(`select count(distinct author_login)::int n from commits where repo_id=$1 and author_login is not null`, [repoId]),
    one(
      `select count(*) filter (where conclusion='success')::int ok,
              count(*) filter (where conclusion is not null)::int done
       from workflow_runs where repo_id=$1`,
      [repoId]
    ),
    dep ?? deploymentEvents(repoId),
  ])
  const commits = commitsRow.n
  const contributors = contributorsRow.n
  const mergedClosed = pr.merged + pr.closed_unmerged

  return {
    prsTotal: pr.total,
    prsMerged: pr.merged,
    prsOpen: pr.open,
    prsClosedUnmerged: pr.closed_unmerged,
    mergeRate: mergedClosed ? pr.merged / mergedClosed : null,
    leadTimeP50h: lead.p50 != null ? Number(lead.p50) : null,
    leadTimeP90h: lead.p90 != null ? Number(lead.p90) : null,
    commits,
    contributors,
    ciPassRate: ci.done ? ci.ok / ci.done : null,
    ciRuns: ci.done,
    deployMethod: deploy.method,
    deployCount: deploy.events.length,
    deployPerWeek: perWeek(deploy.events),
  }
}

export async function topContributors(repoId = null, limit = 8) {
  const lim = Math.min(50, Math.max(1, Math.floor(Number(limit) || 8)))
  const filt = repoId ? "and repo_id=$1" : ""
  const params = repoId ? [repoId] : []
  const limPlaceholder = `$${params.length + 1}` // bound param, never interpolated
  const [commits, prs] = await Promise.all([
    rows(
      `select author_login login, count(*)::int commits
       from commits where author_login is not null ${filt}
       group by 1 order by 2 desc limit ${limPlaceholder}`,
      [...params, lim]
    ),
    rows(
      `select author_login login, count(*)::int prs
       from pull_requests where author_login is not null ${filt} group by 1`,
      params
    ),
  ])
  const prMap = Object.fromEntries(prs.map((p) => [p.login, p.prs]))
  return commits.map((c) => ({ login: c.login, commits: c.commits, prs: prMap[c.login] || 0 }))
}

export async function prsPerWeek(repoId = null) {
  const filt = repoId ? "and repo_id=$1" : ""
  const params = repoId ? [repoId] : []
  return rows(
    `select to_char(date_trunc('week', created_at),'YYYY-MM-DD') week,
            count(*)::int opened,
            count(*) filter (where merged_at is not null)::int merged
     from pull_requests where created_at is not null ${filt}
     group by 1 order by 1`,
    params
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

// ===========================================================================
// PAGE-LEVEL AGGREGATES
// ===========================================================================
export async function repoList() {
  const repos = await rows(`select id, full_name from repos order by full_name`)
  // Summaries are independent per repo; fan them out. The pg pool (max 10) applies
  // backpressure, so this stays bounded even for orgs with many repos.
  // Promise.all preserves input order, so the result is still sorted by full_name.
  return Promise.all(
    repos.map(async (r) => ({ id: r.id, full_name: r.full_name, ...(await repoSummary(r.id)) }))
  )
}

export async function overview() {
  const repos = await repoList()
  const sum = (f) => repos.reduce((a, r) => a + (f(r) || 0), 0)
  const prsMerged = sum((r) => r.prsMerged)
  const mergedClosed = prsMerged + sum((r) => r.prsClosedUnmerged)
  // org-wide lead time + the two page charts are independent of each other
  const [lead, contributorsRow, prsPerWeekData, topContributorsData] = await Promise.all([
    one(
      `select percentile_cont(0.5) within group (order by extract(epoch from (merged_at-created_at))/3600.0) p50
       from pull_requests where merged_at is not null`
    ),
    one(`select count(distinct author_login)::int n from commits where author_login is not null`),
    prsPerWeek(null),
    topContributors(null, 8),
  ])
  return {
    totals: {
      repos: repos.length,
      prsOpened: sum((r) => r.prsTotal),
      prsMerged,
      mergeRate: mergedClosed ? prsMerged / mergedClosed : null,
      commits: sum((r) => r.commits),
      deployEvents: sum((r) => r.deployCount),
      leadTimeP50h: lead && lead.p50 != null ? Number(lead.p50) : null,
      contributors: contributorsRow.n,
    },
    repos,
    prsPerWeek: prsPerWeekData,
    topContributors: topContributorsData,
  }
}

// All contributors for a single repo with per-commit-type breakdown and PR stats.
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
     ORDER BY commits DESC`,
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
      leadTimeP50h: prStats.lead_time_p50h != null ? Number(prStats.lead_time_p50h) : null,
      leadTimeP90h: prStats.lead_time_p90h != null ? Number(prStats.lead_time_p90h) : null,
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

// All commits for a contributor — used for the per-profile scatter chart.
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
  const repo = await one(`select id, full_name from repos where id=$1`, [repoId])
  if (!repo) return null
  // Compute the deploy-signal ladder once and hand it to repoSummary so it isn't
  // re-run there; the remaining sections are independent and fan out together.
  const dep = await deploymentEvents(repoId)
  const [summary, prsPerWeekData, reviews, topContributorsData, recentPRsData] = await Promise.all([
    repoSummary(repoId, dep),
    prsPerWeek(repoId),
    reviewMetrics(repoId),
    topContributors(repoId, 8),
    recentPRs(repoId, 10),
  ])
  return {
    repo,
    summary,
    prsPerWeek: prsPerWeekData,
    deploys: { method: dep.method, series: bucketByWeek(dep.events) },
    reviews,
    topContributors: topContributorsData,
    recentPRs: recentPRsData,
  }
}
