// ============================================================================
// AI layer: report generation + free-form Q&A over the metrics DB.
//
// Two entry points, both grounded in metrics.mjs (never raw SQL from a model):
//   generateReport(range, onText)  — deterministic context assembly: gather the
//     range's metrics JSON, one streaming Claude call, markdown out.
//   answerQuestion(messages, onEvent) — tool-use loop: Claude picks from a
//     fixed set of read-only tools that map 1:1 to the dashboard's own metric
//     functions, so it can only see what the dashboard itself can show.
//
// The Anthropic client is created lazily so the server boots (and every non-AI
// route works) without ANTHROPIC_API_KEY; AI routes answer 503 until it's set.
// ============================================================================
import {
  overview, trends, TREND_RANGES, teamDirectory, dataStatus, activityPunchcard,
  workflowInsights, reviewHealth, issueInsights, weeklyCommitDigest,
} from "./metrics.mjs"

const MODEL = process.env.AI_MODEL || "claude-opus-4-8"

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY)

let _client = null
async function client() {
  if (!_client) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk")
    _client = new Anthropic() // reads ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL) from env
  }
  return _client
}

// ---------------------------------------------------------------------------
// Shared grounding rules. These encode the dashboard's standing editorial
// policy (team-level framing, honest proxy labeling) so the model can't
// undo decisions the UI already made.
// ---------------------------------------------------------------------------
const GROUNDING = `
Data honesty rules (non-negotiable):
- Cite the specific numbers and time periods behind every claim. Never invent
  or extrapolate figures that are not in the data you were given or fetched.
- Label proxies as proxies: "deploys" may be inferred (deployMethod says how —
  GitHub Deployments, releases, merges to main, or CI on main); change failure
  rate and MTTR are proxies computed from CI runs on the default branch.
- Some figures are all-time and some are range-scoped — say which. In trends
  data, the current (last) bucket is usually incomplete; do not read it as a
  decline.
- This team's data is still backfilling. State the data-freshness timestamp
  when you have it, and prefer "no data" over guessing when coverage is thin.

Team framing rules (owner policy, non-negotiable):
- Metrics are about the TEAM and the SYSTEM, never about ranking individuals.
- Never produce leaderboards, "top contributor" rankings, or comparisons of
  individuals' output. If asked, decline briefly and reframe at the team or
  repo level (bus factor and review coverage are fine — they are risk signals).
`.trim()

// ---------------------------------------------------------------------------
// REPORT — gather everything the dashboard knows for a range, one Claude call.
// ---------------------------------------------------------------------------
const REPORT_SYSTEM = `
You are an engineering-metrics analyst writing for a company-wide audience.
You will receive a JSON snapshot from a GitHub engineering-metrics dashboard.

Write a markdown report with exactly these sections:
## Executive summary
3-6 sentences on overall engineering health for the selected period, leading
with the single most important takeaway.
## Concerning downtrends
The changes most worth acting on, worst first. For each: the metric, the
numbers over time that show the trend, which repos drive it, and one plausible
next step to investigate. If nothing is genuinely concerning, say so.
## Promising uptrends
Same treatment for improvements worth reinforcing.
## Watch items & data caveats
Early signals not yet trends, plus data-coverage caveats a reader needs
(proxy metrics in use, thin coverage, incomplete current bucket, freshness).

Style: plain prose, short paragraphs or tight bullet lists; every claim backed
by a number; no filler. End with a one-line footer: "Data through <latest
event timestamp> · deploys measured via <method>".

${GROUNDING}
`.trim()

// What each top-level key in the snapshot means, so the model reads it right.
const SNAPSHOT_LEGEND = `
Snapshot legend:
- range: the user-selected period. trendsSelected = per-bucket time series for
  that period (bucket sizes: 1d=hourly, 1w=daily, 6w=weekly, 12m/all=monthly).
- trends6w / trends12m: fixed weekly/monthly series included for baseline
  comparison regardless of the selected range.
- overview.totals and overview.repos are ALL-TIME; overview.rangeExtras
  (distinct contributors, lead-time p50) are scoped to the selected range.
- reviews, issues, workflows, activity are ALL-TIME aggregates.
- status: row counts per table + latest event timestamp (data freshness).
`.trim()

// Reports are expensive (one Opus call over a big snapshot), so cache per
// range. The data only moves when the collector lands new rows; 15 minutes of
// staleness is invisible next to the backfill cadence.
const reportCache = new Map() // range -> { text, t }
const REPORT_CACHE_MS = 15 * 60_000

export function cachedReport(range) {
  const hit = reportCache.get(range)
  return hit && Date.now() - hit.t < REPORT_CACHE_MS ? hit.text : null
}

export async function generateReport(range, onText, signal) {
  if (!TREND_RANGES.includes(range)) range = "12m"

  const [ov, trSel, tr6, tr12, reviews, issues, workflows, activity, status] =
    await Promise.all([
      overview(range), trends(range), trends("6w"), trends("12m"),
      reviewHealth(), issueInsights(), workflowInsights(), activityPunchcard(),
      dataStatus(),
    ])

  const snapshot = {
    range, generatedAt: new Date().toISOString(),
    overview: ov, trendsSelected: trSel, trends6w: tr6, trends12m: tr12,
    reviews, issues, workflows, activity, status,
  }

  const anthropic = await client()
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    system: REPORT_SYSTEM,
    messages: [{
      role: "user",
      content: `Selected range: ${range}\n\n${SNAPSHOT_LEGEND}\n\n` +
        `Dashboard snapshot JSON:\n${JSON.stringify(snapshot)}`,
    }],
  }, { signal })
  stream.on("text", onText)
  const final = await stream.finalMessage()

  const text = final.content.filter((b) => b.type === "text").map((b) => b.text).join("")
  reportCache.set(range, { text, t: Date.now() })
  console.log(`ai report range=${range} in=${final.usage.input_tokens} out=${final.usage.output_tokens}`)
  return text
}

// ---------------------------------------------------------------------------
// Q&A — a fixed, read-only tool per dashboard dataset. The model composes
// them; it never writes SQL and never sees anything the dashboard can't show.
// ---------------------------------------------------------------------------
const ASK_SYSTEM = `
You are the Q&A assistant embedded in a GitHub engineering-metrics dashboard.
Answer questions about the org's repos, delivery trends, CI health, reviews,
and issues using the tools — they are the same functions the dashboard's own
charts are built on.

- ALWAYS fetch data with tools before answering a factual/numeric question;
  never answer from memory. Use several tools when the question spans datasets.
- get_overview's repos array is how you map repo names to numeric ids for the
  repo-scoped tools.
- Ranges available: 1d, 1w, 6w, 12m, all.
- Answer in concise markdown. Lead with the answer, then the supporting
  numbers (a small table when comparing repos or periods). State which period
  each figure covers. Suggest a relevant follow-up question only when natural.
- If the data can't answer the question, say exactly what's missing.

${GROUNDING}
`.trim()

// GitHub repo ids are numeric strings (BIGINT-safe). Same validation contract
// as server.mjs's parseRepoId.
const repoIdProp = {
  type: "string", pattern: "^\\d+$",
  description: "Numeric repo id (from get_overview's repos array). Omit for org-wide.",
}
const rangeProp = {
  type: "string", enum: [...TREND_RANGES],
  description: "Time range: 1d, 1w, 6w, 12m, or all.",
}
const noInput = { type: "object", properties: {}, additionalProperties: false }
const repoInput = (required = false) => ({
  type: "object", properties: { repoId: repoIdProp },
  ...(required ? { required: ["repoId"] } : {}), additionalProperties: false,
})
const checkRepoId = (repoId) => {
  if (repoId != null && !/^\d+$/.test(repoId)) throw new Error("invalid repoId")
  return repoId ?? null
}

async function buildTools() {
  const { betaTool } = await import("@anthropic-ai/sdk/helpers/beta/json-schema")
  const j = (fn) => async (input) => JSON.stringify(await fn(input ?? {}))
  return [
    betaTool({
      name: "get_overview",
      description:
        "Org-wide totals (PRs, commits, merge rate, lead time, CI pass rate, contributors, deploys) " +
        "plus a per-repo stats table (id, full_name, DORA proxies, bus factor, last activity). " +
        "Totals/repos are all-time; rangeExtras is scoped to the given range. " +
        "Call this first when you need repo ids or an org summary.",
      inputSchema: { type: "object", properties: { range: rangeProp }, additionalProperties: false },
      run: j(({ range }) => overview(TREND_RANGES.includes(range) ? range : "12m")),
    }),
    betaTool({
      name: "get_trends",
      description:
        "Time series (per-bucket: commits, activeContributors, PRs opened/merged, leadTimeP50h, " +
        "ciRuns, ciPassRate, deploys, issues opened/closed, reviews) for a range, org-wide or one repo. " +
        "Bucket sizes: 1d=hourly, 1w=daily, 6w=weekly, 12m/all=monthly. The last bucket is usually incomplete.",
      inputSchema: {
        type: "object", properties: { range: rangeProp, repoId: repoIdProp },
        required: ["range"], additionalProperties: false,
      },
      run: j(({ range, repoId }) =>
        trends(TREND_RANGES.includes(range) ? range : "12m", checkRepoId(repoId))),
    }),
    betaTool({
      name: "get_review_health",
      description:
        "PR review outcomes (approved/changes-requested/commented), review coverage of merged PRs, " +
        "and reviews per merged PR. All-time. Org-wide or one repo.",
      inputSchema: repoInput(),
      run: j(({ repoId }) => reviewHealth(checkRepoId(repoId))),
    }),
    betaTool({
      name: "get_issue_insights",
      description:
        "Issue resolution mix (completed vs not-planned), open-backlog aging buckets, median comments " +
        "and time-to-close. All-time. Org-wide or one repo.",
      inputSchema: repoInput(),
      run: j(({ repoId }) => issueInsights(checkRepoId(repoId))),
    }),
    betaTool({
      name: "get_workflow_insights",
      description:
        "CI reliability per named workflow: runs, pass rate, retry rate, median duration, last run — " +
        "answers 'which pipelines are flaky or slow?'. All-time. Org-wide or one repo.",
      inputSchema: repoInput(),
      run: j(({ repoId }) => workflowInsights(checkRepoId(repoId))),
    }),
    betaTool({
      name: "get_activity_punchcard",
      description:
        "Commit activity by day-of-week x hour (UTC), with weekend and after-hours percentages. " +
        "All-time. Org-wide or one repo.",
      inputSchema: repoInput(),
      run: j(({ repoId }) => activityPunchcard(checkRepoId(repoId))),
    }),
    betaTool({
      name: "get_team_directory",
      description:
        "Team directory sorted by recency of activity (NOT a leaderboard): contributors with first/last " +
        "active dates and activity counts, plus change-type breakdown and 30-day active count.",
      inputSchema: noInput,
      run: j(() => teamDirectory()),
    }),
    betaTool({
      name: "get_weekly_digest",
      description:
        "Last ~12 weeks of one repo's commits grouped by week, with per-change-type counts and short " +
        "summaries where available. Good for 'what happened in repo X recently'.",
      inputSchema: repoInput(true),
      run: j(({ repoId }) => weeklyCommitDigest(checkRepoId(repoId))),
    }),
    betaTool({
      name: "get_data_status",
      description: "Row counts per table and the latest event timestamp — data freshness/coverage.",
      inputSchema: noInput,
      run: j(() => dataStatus()),
    }),
  ]
}

// messages: [{role: "user"|"assistant", content: string}, ...] ending in user.
// onEvent receives {type:"tool", name, detail} as the loop runs, so the UI can
// show progress during a long-running answer.
export async function answerQuestion(messages, onEvent = () => {}, signal) {
  const anthropic = await client()
  const tools = await buildTools()

  const runner = anthropic.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: ASK_SYSTEM,
    tools,
    messages,
    max_iterations: 8,
  }, { signal })

  let last = null
  let usage = { input: 0, output: 0 }
  for await (const message of runner) {
    last = message
    usage.input += message.usage.input_tokens
    usage.output += message.usage.output_tokens
    for (const block of message.content) {
      if (block.type === "tool_use") {
        const input = block.input || {}
        const detail = [input.range, input.repoId && `repo ${input.repoId}`]
          .filter(Boolean).join(", ")
        onEvent({ type: "tool", name: block.name, detail })
      }
    }
    // No server-side tools in play, but guard pause_turn anyway so a paused
    // turn resumes instead of silently truncating the answer.
    if (message.stop_reason === "pause_turn") {
      runner.pushMessages({ role: "assistant", content: message.content })
    }
  }

  const text = (last?.content || [])
    .filter((b) => b.type === "text").map((b) => b.text).join("").trim()
  console.log(`ai ask turns=${messages.length} in=${usage.input} out=${usage.output}`)
  if (!text) throw new Error("model returned no answer")
  return text
}
