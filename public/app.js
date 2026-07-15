"use strict";
/* ============================================================================
   Dev Metrics SPA.
   No frameworks, no build step, no CDNs — a hash router + fetch + Chart.js.
   Everything rendered from API JSON is escaped with esc(); no inline event
   handlers anywhere (the CSP forbids them, and interpolating into onclick
   strings was an XSS foot-gun).
   ========================================================================== */

// ---------------------------------------------------------------- utilities
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => (s ?? "").toString().replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num  = (n) => (n ?? 0).toLocaleString();
const pct  = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
const freq = (f) => (f ? (f >= 10 ? Math.round(f) : f.toFixed(1)) : "0") + "/wk";
const fmtH = (h) => h == null ? "—" : h < 1 ? Math.round(h * 60) + "m" : h < 48 ? h.toFixed(1) + "h" : (h / 24).toFixed(1) + "d";
const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
const relTime = (d) => {
  if (!d) return "—";
  const days = Math.floor((Date.now() - new Date(d)) / 86400000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return days + "d ago";
  if (days < 365) return Math.floor(days / 30) + "mo ago";
  return (days / 365).toFixed(1) + "yr ago";
};
const initialsOf = (login) => (login || "?").slice(0, 2).toUpperCase();

const ACCENT = "#6366f1", GREEN = "#10b981", AMBER = "#f59e0b", RED = "#ef4444", SLATE = "#64748b";
const GRID = "#1d2a3f", TICK = "#64748b";

// ---------------------------------------------------------------- app state
const RANGES = ["1d", "1w", "6w", "12m", "all"];
const state = {
  range: RANGES.includes(localStorage.getItem("dm.range"))
    ? localStorage.getItem("dm.range") : "12m",
};
const RANGE_LABEL = {
  "1d": "last 24 hours", "1w": "last 7 days", "6w": "last 6 weeks",
  "12m": "last 12 months", all: "all history",
};
// The bucket size each range is plotted at — used to label deltas and averages.
const INTERVAL_NOUN = { "1d": "hour", "1w": "day", "6w": "week", "12m": "month", all: "month" };

// ------------------------------------------------------------------- fetch
// TTL cache: everything is prefetched once at boot (see prefetchAll), so this
// also holds the warmed data for the session. The API itself is no-store; the
// window is long enough to cover a browsing session but still refresh eventually
// (the data backfills over days, so minutes of client cache is harmless).
const cache = new Map();
const CACHE_MS = 300_000; // 5 min
async function fetchJSON(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.p;
  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try { res = await fetch(url, { signal: ctrl.signal }); }
    catch (e) { throw new Error(ctrl.signal.aborted ? "request timed out" : e.message); }
    finally { clearTimeout(timer); }
    let body = null;
    try { body = await res.json(); } catch { /* leave null */ }
    if (!res.ok) throw new Error((body && body.error) || "HTTP " + res.status);
    if (body == null) throw new Error("invalid response from server");
    return body;
  })();
  cache.set(url, { t: Date.now(), p });
  p.catch(() => cache.delete(url)); // don't cache failures
  return p;
}
const api = {
  overview:     (range)       => fetchJSON("/api/overview" + (range ? "?range=" + encodeURIComponent(range) : "")),
  status:       ()            => fetchJSON("/api/status"),
  team:         ()            => fetchJSON("/api/team"),
  trends:       (range, repo) => fetchJSON(`/api/trends?range=${range}${repo ? "&repo=" + encodeURIComponent(repo) : ""}`),
  repo:         (id)          => fetchJSON("/api/repo/" + encodeURIComponent(id)),
  weekly:       (id)          => fetchJSON("/api/repo/" + encodeURIComponent(id) + "/weekly"),
  repoCommits:  (id)          => fetchJSON("/api/repo/" + encodeURIComponent(id) + "/commits"),
  contributors: (id)          => fetchJSON("/api/repo/" + encodeURIComponent(id) + "/contributors"),
  contributor:  (l)           => fetchJSON("/api/contributor/" + encodeURIComponent(l)),
  contributorCommits: (l)     => fetchJSON("/api/contributor/" + encodeURIComponent(l) + "/commits"),
  activity:     (repo)        => fetchJSON("/api/activity"  + (repo ? "?repo=" + encodeURIComponent(repo) : "")),
  workflows:    (repo)        => fetchJSON("/api/workflows" + (repo ? "?repo=" + encodeURIComponent(repo) : "")),
  reviews:      (repo)        => fetchJSON("/api/reviews"   + (repo ? "?repo=" + encodeURIComponent(repo) : "")),
  issuesInsight:(repo)        => fetchJSON("/api/issues"    + (repo ? "?repo=" + encodeURIComponent(repo) : "")),
};

// ------------------------------------------------------------------ charts
let charts = [];
const clearCharts = () => { charts.forEach((c) => c.destroy()); charts = []; };
const addChart = (canvas, cfg) => { const c = new Chart(canvas, cfg); charts.push(c); return c; };

const legendOpts = { labels: { color: TICK, boxWidth: 10, font: { size: 11 }, padding: 10 } };
const scaleX = { ticks: { color: TICK, maxTicksLimit: 10, font: { size: 11 } }, grid: { color: GRID } };
const scaleY = (extra = {}) => ({ beginAtZero: true, ticks: { color: TICK, precision: 0, font: { size: 11 } }, grid: { color: GRID }, ...extra });

// A percentage y-axis. Bounded metrics (e.g. CI pass rate) cap at a hard 100%.
// Metrics that can legitimately exceed 100% — merge rate is merged÷opened per
// period, and a period can merge more PRs than it opened (they were opened
// earlier) — use suggestedMax so the axis GROWS to contain them instead of
// letting the line spill past a fixed 100% ceiling and out of the plot.
const pctTicks = { color: TICK, font: { size: 11 }, callback: (v) => Math.round(v * 100) + "%" };
const pctAxisExtra = (soft = false) => (soft ? { suggestedMax: 1, ticks: pctTicks } : { max: 1, ticks: pctTicks });

function stdChart(canvas, labels, datasets, { pctAxis = false, y1 = null, legend = true } = {}) {
  const scales = { x: scaleX, y: scaleY(pctAxis ? { max: 1, ticks: { color: TICK, font: { size: 11 }, callback: (v) => Math.round(v * 100) + "%" } } : {}) };
  if (y1) scales.y1 = { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, ticks: { color: TICK, font: { size: 11 }, ...(y1 === "pct" ? { callback: (v) => Math.round(v * 100) + "%" } : { precision: 0 }) }, ...(y1 === "pct" ? { max: 1 } : {}) };
  return addChart(canvas, {
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: legend ? legendOpts : { display: false } },
      scales,
    },
  });
}
// tension:0 → straight segments between points. A fitted (bezier) curve can
// overshoot above the highest / below the lowest data point — e.g. bulge past
// 100% on a rate axis — so we draw direct lines instead.
// order matters for z-order: Chart.js v4 draws sorted datasets in REVERSE, so
// the LOWEST `order` is painted LAST (on top). line order:0 / bar order:1 keeps
// the line above the bars in every mixed chart regardless of array position.
const line = (label, data, color, extra = {}) =>
  ({ type: "line", label, data, borderColor: color, backgroundColor: "transparent", tension: 0, pointRadius: 2, spanGaps: true, order: 0, ...extra });
const bars = (label, data, color, extra = {}) =>
  ({ type: "bar", label, data, backgroundColor: color, borderRadius: 4, order: 1, ...extra });

function doughnutChart(canvas, labels, data, colors) {
  return addChart(canvas, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "right", labels: { color: "#94a3b8", boxWidth: 10, font: { size: 11 }, padding: 8 } } },
      cutout: "68%",
    },
  });
}

// Amazon-style WBR "6 & 12" mini-chart: trailing 6 weeks (weekly) on the left,
// trailing 12 months (monthly) on the right, split by a divider. This is a
// fixed executive format — it does NOT follow the top-right range selector;
// it always shows the same 6-week + 12-month window so the cards read the same
// way every visit. `weekly`/`monthly` are the metric's per-bucket values.
function wbrSpark(canvas, weekly, monthly, color = ACCENT, { pct = false, soft = false } = {}) {
  const w = weekly.map((v) => (v == null ? null : v));
  const mo = monthly.map((v) => (v == null ? null : v));
  const gapAt = w.length;                 // index of the divider column
  const data = [...w, null, ...mo];       // null column = visual gap
  const softColor = color + "66", solid = color;
  const bg = data.map((_, i) => (i < gapAt ? softColor : solid));
  const dividerLine = {
    id: "wbrDivider",
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const x = scales.x.getPixelForValue(gapAt);
      ctx.save();
      ctx.strokeStyle = "rgba(148,163,184,.35)";
      ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
      ctx.restore();
    },
  };
  return addChart(canvas, {
    type: "bar",
    data: {
      labels: data.map((_, i) => i),
      datasets: [{ data, backgroundColor: bg, borderRadius: 1, barPercentage: 0.9, categoryPercentage: 0.9 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false, offset: true },
        y: { display: false, beginAtZero: true, ...(pct ? (soft ? { suggestedMax: 1 } : { max: 1 }) : {}) },
      },
      events: [],
    },
    plugins: [dividerLine],
  });
}

function sparkline(canvas, values, color = ACCENT) {
  return addChart(canvas, {
    type: "line",
    data: { labels: values.map((_, i) => i), datasets: [{ data: values, borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0, fill: { target: "origin", above: color + "22" }, spanGaps: true }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
      events: [],
    },
  });
}

// ------------------------------------------------------- commit-type lookup
const CT_LABELS = {
  new_feature: { cls: "chip-info",  label: "feature"  },
  bug_fix:     { cls: "chip-bad",   label: "bug fix"  },
  refactor:    { cls: "chip-good",  label: "refactor" },
  test:        { cls: "chip-warn",  label: "test"     },
  docs:        { cls: "chip-muted", label: "docs"     },
  config:      { cls: "chip-muted", label: "config"   },
  chore:       { cls: "chip-muted", label: "chore"    },
};
const CT_COLORS = {
  new_feature: "#6366f1", bug_fix: "#ef4444", refactor: "#10b981",
  test: "#f59e0b", docs: "#64748b", config: "#475569", chore: "#334155",
};
const ctChip = (type) => {
  if (!type) return "";
  const { cls, label } = CT_LABELS[type] || { cls: "chip-muted", label: type };
  return `<span class="chip ${cls}">${esc(label)}</span>`;
};
const methodChip = (m) =>
  m === "none" ? `<span class="chip chip-muted">no deploy signal</span>`
  : m === "GitHub Deployments" ? `<span class="chip chip-good">${esc(m)}</span>`
  : `<span class="chip chip-warn">${esc(m)}</span>`;

// =================================================================== METRICS
// Registry powering sparklines, chart cards and the expand-to-history modal.
// Every metric the API reports has an entry → "complete historical views of
// literally every single metric".
const METRICS = {
  commits: {
    label: "Commits", sub: "non-bot commits", fmt: num,
    primary: (b) => b.commits,
    datasets: (b) => [bars("commits", b.map((x) => x.commits), ACCENT)],
  },
  activeContributors: {
    label: "Active contributors", sub: "distinct commit authors per period", fmt: num,
    primary: (b) => b.activeContributors,
    datasets: (b) => [bars("active contributors", b.map((x) => x.activeContributors), GREEN)],
  },
  prs: {
    label: "Pull requests", sub: "opened vs merged", fmt: num,
    primary: (b) => b.prsMerged,
    datasets: (b) => [line("opened", b.map((x) => x.prsOpened), ACCENT), line("merged", b.map((x) => x.prsMerged), GREEN)],
  },
  mergeRate: {
    label: "Merge rate", sub: "merged ÷ opened, per period", fmt: pct, pctAxis: true, softMax: true,
    primary: (b) => (b.prsOpened ? b.prsMerged / b.prsOpened : null),
    datasets: (b) => [line("merge rate", b.map((x) => (x.prsOpened ? x.prsMerged / x.prsOpened : null)), GREEN)],
  },
  leadTime: {
    label: "Lead time (p50)", sub: "median hours, PR open → merge", fmt: fmtH, lowerIsBetter: true,
    primary: (b) => b.leadTimeP50h,
    datasets: (b) => [line("lead time p50 (h)", b.map((x) => x.leadTimeP50h), AMBER)],
  },
  deploys: {
    label: "Deploys", sub: "deploy-signal events", fmt: num,
    primary: (b) => b.deploys,
    datasets: (b) => [bars("deploys", b.map((x) => x.deploys), GREEN)],
  },
  ciPassRate: {
    label: "CI pass rate", sub: "successful ÷ completed workflow runs", fmt: pct, pctAxis: true,
    primary: (b) => b.ciPassRate,
    // line()/bars() carry order:0/1 so the pass-rate line always paints on top of the run-count bars.
    datasets: (b) => [bars("runs", b.map((x) => x.ciRuns), "rgba(99,102,241,.35)", { yAxisID: "y1" }), line("pass rate", b.map((x) => x.ciPassRate), GREEN)],
    y1: "count",
  },
  issues: {
    label: "Issues", sub: "opened vs closed", fmt: num,
    primary: (b) => b.issuesOpened,
    datasets: (b) => [line("opened", b.map((x) => x.issuesOpened), AMBER), line("closed", b.map((x) => x.issuesClosed), GREEN)],
  },
  reviews: {
    label: "PR reviews", sub: "review submissions", fmt: num,
    primary: (b) => b.reviews,
    datasets: (b) => [bars("reviews", b.map((x) => x.reviews), "#8b5cf6")],
  },
};

// Compare the last two *complete* buckets (the final bucket is the current,
// still-running week/month — comparing it against a full one would mislead).
function deltaFor(metric, buckets, noun = "period") {
  const full = buckets.slice(0, -1);
  if (full.length < 2) return null;
  const cur = METRICS[metric].primary(full[full.length - 1]);
  const prev = METRICS[metric].primary(full[full.length - 2]);
  if (cur == null || prev == null || prev === 0) return null;
  const change = (cur - prev) / Math.abs(prev);
  const good = METRICS[metric].lowerIsBetter ? change < 0 : change > 0;
  const cls = Math.abs(change) < 0.005 ? "flat" : good ? "up" : "down";
  const arrow = change > 0.005 ? "▲" : change < -0.005 ? "▼" : "•";
  const fmt = METRICS[metric].fmt;
  // basis spells out exactly what the % compares: the last COMPLETE bucket vs
  // the one before it (the still-running current bucket is excluded).
  const basis = `${METRICS[metric].label}: ${fmt(prev)} → ${fmt(cur)} vs previous ${noun}`;
  return { cls, text: `${arrow} ${Math.abs(Math.round(change * 100))}%`, basis };
}

// ------------------------------------------------------------------- modal
let modalChart = null;
let aiAbort = null; // in-flight AI report fetch; aborted when its modal closes
function closeModal() {
  if (modalChart) { modalChart.destroy(); modalChart = null; }
  if (aiAbort) { aiAbort.abort(); aiAbort = null; } // stop paying for a report nobody is reading
  const root = $("#modal-root");
  root.hidden = true;
  root.innerHTML = "";
  document.removeEventListener("keydown", modalEsc);
}
function modalEsc(e) { if (e.key === "Escape") closeModal(); }

// small helpers to render readable bucket labels in the WBR modal chart
const wkLabel = (key) => new Date(key + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
const moLabel = (key) => new Date(key + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "2-digit" });

// Full-history modal for one metric. Opens on the Amazon-style "6 & 12" (WBR)
// view — trailing 6 weeks + trailing 12 months side by side — with tabs to drop
// to any single range.
function openMetricModal(metricId, scope = {}) {
  const m = METRICS[metricId];
  if (!m) return;
  let range = "wbr"; // default to the 6&12 view the expand action is meant to surface
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" data-close></div>
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(m.label)} history">
      <div class="modal-head">
        <div>
          <div class="modal-title">${esc(m.label)}</div>
          <div class="modal-sub">${esc(m.sub)}${scope.title ? " · " + esc(scope.title) : " · all repos"}</div>
        </div>
        <button class="modal-x" data-close aria-label="Close">×</button>
      </div>
      <div class="range-tabs" data-modal-tabs>
        <button class="range-tab" data-r="wbr">6 &amp; 12 (WBR)</button>
        <button class="range-tab" data-r="1d">24 hours</button>
        <button class="range-tab" data-r="1w">7 days</button>
        <button class="range-tab" data-r="6w">6 weeks</button>
        <button class="range-tab" data-r="12m">12 months</button>
        <button class="range-tab" data-r="all">All history</button>
      </div>
      <div class="modal-chart"><canvas></canvas></div>
      <div class="modal-stats" data-stats></div>
    </div>`;
  root.hidden = false;
  document.addEventListener("keydown", modalEsc);
  root.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeModal));

  const statsEl = () => $("[data-stats]", root);
  const segStats = (label, buckets) => {
    const vals = buckets.map((b) => m.primary(b)).filter((v) => v != null);
    const sum = vals.reduce((a, v) => a + v, 0);
    if (m.pctAxis || m.lowerIsBetter) return `<span class="ms">${esc(label)} avg<b>${m.fmt(vals.length ? sum / vals.length : null)}</b></span>`;
    return `<span class="ms">${esc(label)} total<b>${num(sum)}</b></span>`;
  };

  // The Amazon WBR "6 & 12": 6 weekly buckets, a divider, then 12 monthly buckets.
  async function drawWBR() {
    const [t6, t12] = await Promise.all([
      api.trends("6w", scope.repoId).catch(() => null),
      api.trends("12m", scope.repoId).catch(() => null),
    ]);
    const el = statsEl();
    if (!t6 || !t12 || (!t6.buckets.length && !t12.buckets.length)) {
      if (el) el.innerHTML = `<span class="ms">no data for this range</span>`;
      return;
    }
    if (modalChart) { modalChart.destroy(); modalChart = null; }
    const canvas = $(".modal-chart canvas", root);
    if (!canvas) return;
    const gapIdx = t6.buckets.length;
    const labels = [...t6.buckets.map((b) => wkLabel(b.bucket)), "", ...t12.buckets.map((b) => moLabel(b.bucket))];
    const dsW = m.datasets(t6.buckets), dsM = m.datasets(t12.buckets);
    // merge each dataset's weekly + monthly data with a null gap; spanGaps:false
    // keeps the line from bridging the divider so the two panels read separately.
    const datasets = dsW.map((d, i) => ({ ...d, data: [...d.data, null, ...((dsM[i] && dsM[i].data) || [])], spanGaps: false }));
    const divider = {
      id: "wbrModalDivider",
      afterDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        const x = scales.x.getPixelForValue(gapIdx);
        ctx.save();
        ctx.strokeStyle = "rgba(148,163,184,.45)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        ctx.fillStyle = TICK; ctx.font = "10px sans-serif";
        ctx.textAlign = "center"; ctx.fillText("6 weeks", (chartArea.left + x) / 2, chartArea.top + 12);
        ctx.fillText("12 months", (x + chartArea.right) / 2, chartArea.top + 12);
        ctx.restore();
      },
    };
    modalChart = new Chart(canvas, {
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: legendOpts },
        scales: {
          x: { ...scaleX, ticks: { ...scaleX.ticks, maxTicksLimit: 20, maxRotation: 60, autoSkip: true } },
          y: scaleY(m.pctAxis ? pctAxisExtra(m.softMax) : {}),
          ...(m.y1 ? { y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, ticks: { color: TICK, precision: 0 } } } : {}),
        },
      },
      plugins: [divider],
    });
    const el2 = statsEl();
    if (el2) el2.innerHTML = [
      segStats("6-week", t6.buckets),
      segStats("12-month", t12.buckets),
      `<span class="ms">weeks · months<b>${t6.buckets.length} · ${t12.buckets.length}</b></span>`,
    ].join("");
  }

  async function drawRange() {
    const t = await api.trends(range, scope.repoId).catch(() => null);
    const el = statsEl();
    if (!t || !t.buckets.length) { if (el) el.innerHTML = `<span class="ms">no data for this range</span>`; return; }
    if (modalChart) { modalChart.destroy(); modalChart = null; }
    const canvas = $(".modal-chart canvas", root);
    if (!canvas) return;
    modalChart = new Chart(canvas, {
      data: { labels: t.buckets.map((b) => b.bucket), datasets: m.datasets(t.buckets) },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: legendOpts },
        scales: {
          x: scaleX,
          y: scaleY(m.pctAxis ? pctAxisExtra(m.softMax) : {}),
          ...(m.y1 ? { y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, ticks: { color: TICK, precision: 0 } } } : {}),
        },
      },
    });
    const vals = t.buckets.map((b) => m.primary(b)).filter((v) => v != null);
    const sum = vals.reduce((a, v) => a + v, 0);
    const statHtml = [];
    const nounPl = INTERVAL_NOUN[range] + "s";
    if (m.pctAxis || m.lowerIsBetter) {
      statHtml.push(`<span class="ms">average<b>${m.fmt(vals.length ? sum / vals.length : null)}</b></span>`);
      if (vals.length) {
        statHtml.push(`<span class="ms">best<b>${m.fmt(m.lowerIsBetter ? Math.min(...vals) : Math.max(...vals))}</b></span>`);
        statHtml.push(`<span class="ms">worst<b>${m.fmt(m.lowerIsBetter ? Math.max(...vals) : Math.min(...vals))}</b></span>`);
      }
    } else {
      statHtml.push(`<span class="ms">total<b>${num(sum)}</b></span>`);
      statHtml.push(`<span class="ms">avg / ${esc(INTERVAL_NOUN[range])}<b>${num(vals.length ? Math.round(sum / vals.length) : 0)}</b></span>`);
      if (vals.length) statHtml.push(`<span class="ms">peak<b>${num(Math.max(...vals))}</b></span>`);
    }
    statHtml.push(`<span class="ms">${esc(nounPl)} shown<b>${t.buckets.length}</b></span>`);
    if (el) el.innerHTML = statHtml.join("");
  }

  function draw() {
    root.querySelectorAll("[data-modal-tabs] .range-tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.r === range));
    return (range === "wbr" ? drawWBR() : drawRange()).catch(() => {});
  }
  root.querySelectorAll("[data-modal-tabs] .range-tab").forEach((b) =>
    b.addEventListener("click", () => { range = b.dataset.r; draw(); }));
  draw();
}

// ======================================================================== AI
// Report modal + Ask-AI drawer. Both render model-generated MARKDOWN through
// mdToHtml below — every character is esc()'d before any inline formatting is
// applied, so model output can never inject markup (same rule as API JSON).

// --- tiny markdown renderer (headings, lists, tables, code, bold/links) ----
function mdInline(s) {
  // s is already HTML-escaped; formatting is layered on top of escaped text.
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((#\/[^\s)]*)\)/g, '<a href="$2">$1</a>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function mdToHtml(md) {
  const lines = (md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${mdInline(esc(para.join(" ")))}</p>`); para = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) { // fenced code
      flushPara();
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    // table = pipe row followed by a |---|---| separator row
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => mdInline(esc(c.trim())));
      const head = cells(l);
      const body = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) body.push(cells(lines[i]));
      i--;
      out.push(`<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { flushPara(); const n = Math.min(h[1].length + 1, 5); out.push(`<h${n}>${mdInline(esc(h[2]))}</h${n}>`); continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { flushPara(); out.push("<hr>"); continue; }
    if (/^\s*>\s?/.test(l)) { // blockquote
      flushPara();
      const buf = [];
      for (; i < lines.length && /^\s*>\s?/.test(lines[i]); i++) buf.push(lines[i].replace(/^\s*>\s?/, ""));
      i--;
      out.push(`<blockquote>${mdInline(esc(buf.join(" ")))}</blockquote>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)/, ol = /^\s*\d+[.)]\s+(.*)/;
    if (ul.test(l) || ol.test(l)) { // flat lists (nesting renders flattened)
      flushPara();
      const ordered = ol.test(l), re = ordered ? ol : ul;
      const items = [];
      for (; i < lines.length && re.test(lines[i]); i++) items.push(mdInline(esc(lines[i].match(re)[1])));
      i--;
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${x}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (!l.trim()) { flushPara(); continue; }
    para.push(l.trim());
  }
  flushPara();
  return `<div class="md">${out.join("")}</div>`;
}

// --------------------------------------------------------- AI report modal
// GET /api/report streams markdown; re-render the accumulated text per chunk
// (reports are a few KB — re-parsing is cheap and keeps the code simple).
function openReportModal() {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" data-close></div>
    <div class="modal modal-ai" role="dialog" aria-modal="true" aria-label="AI engineering report">
      <div class="modal-head">
        <div>
          <div class="modal-title">AI Engineering Report</div>
          <div class="modal-sub">generated from live metrics · ${esc(RANGE_LABEL[state.range] || state.range)}</div>
        </div>
        <button class="btn" data-regen>Regenerate</button>
        <button class="modal-x" data-close aria-label="Close">×</button>
      </div>
      <div class="ai-report-body" data-body></div>
    </div>`;
  root.hidden = false;
  document.addEventListener("keydown", modalEsc);
  root.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeModal));
  $("[data-regen]", root).addEventListener("click", () => run(true));

  const pendingHtml = (label) => `<div class="ai-pending">${esc(label)}<span class="ai-dots">…</span></div>`;

  async function run(refresh) {
    if (aiAbort) aiAbort.abort();
    const ctrl = (aiAbort = new AbortController());
    const body = $("[data-body]", root);
    body.innerHTML = pendingHtml("Analyzing metrics");
    let text = "";
    try {
      const res = await fetch(
        `/api/report?range=${encodeURIComponent(state.range)}${refresh ? "&refresh=1" : ""}`,
        { signal: ctrl.signal });
      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try { msg = (await res.json()).error || msg; } catch { /* keep status msg */ }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        body.innerHTML = mdToHtml(text) + pendingHtml("Writing");
      }
      body.innerHTML = mdToHtml(text);
    } catch (e) {
      if (ctrl.signal.aborted) return; // modal closed mid-stream
      body.innerHTML = `<div class="ai-error">Report failed: ${esc(e.message)}</div>`;
    } finally {
      if (aiAbort === ctrl) aiAbort = null;
    }
  }
  run(false);
}

// ------------------------------------------------------------ Ask AI drawer
const TOOL_LABEL = {
  get_overview: "reading org overview",
  get_trends: "reading trends",
  get_review_health: "checking review health",
  get_issue_insights: "checking issues",
  get_workflow_insights: "checking CI workflows",
  get_activity_punchcard: "reading activity punchcard",
  get_team_directory: "reading team directory",
  get_weekly_digest: "reading weekly digest",
  get_data_status: "checking data freshness",
};
const ask = { history: [], busy: false };

function askIntroHtml() {
  const qs = [
    "How is engineering health trending over the last 12 months?",
    "Which repos are slowing down the most?",
    "Which CI workflows are flaky or slow?",
    "How healthy is our review process?",
  ];
  return `<div class="ask-msg assistant"><div class="md"><p>Ask me anything about the metrics — I answer from the same data the dashboard charts are built on.</p></div>
    <div class="ask-suggest">${qs.map((q) => `<button class="ask-chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div></div>`;
}
function openAskDrawer() { $("#ask-drawer").hidden = false; $("#ask-input").focus(); }
function closeAskDrawer() { $("#ask-drawer").hidden = true; }

async function sendAsk(q) {
  if (ask.busy) return;
  ask.busy = true;
  $("#ask-send").disabled = true;
  const msgs = $("#ask-msgs");
  msgs.insertAdjacentHTML("beforeend", `<div class="ask-msg user">${esc(q)}</div>`);
  ask.history.push({ role: "user", content: q });
  msgs.insertAdjacentHTML("beforeend",
    `<div class="ask-msg assistant pending"><div class="ai-pending">Thinking<span class="ai-dots">…</span></div><div class="ask-steps"></div></div>`);
  const bubble = msgs.lastElementChild;
  msgs.scrollTop = msgs.scrollHeight;
  try {
    // Send a window of recent turns; the server requires it to start and end
    // with a user message, so trim any leading assistant turn off the window.
    const win = ask.history.slice(-12);
    while (win.length && win[0].role !== "user") win.shift();
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: win }),
    });
    if (!res.ok) {
      let msg = "HTTP " + res.status;
      try { msg = (await res.json()).error || msg; } catch { /* keep status msg */ }
      throw new Error(msg);
    }
    // NDJSON stream: tool/ping progress lines, then one answer or error line.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", answer = null, errMsg = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "tool") {
          $(".ask-steps", bubble).insertAdjacentHTML("beforeend",
            `<div class="ask-step">→ ${esc(TOOL_LABEL[ev.name] || ev.name)}${ev.detail ? " (" + esc(ev.detail) + ")" : ""}</div>`);
          msgs.scrollTop = msgs.scrollHeight;
        } else if (ev.type === "answer") answer = ev.markdown;
        else if (ev.type === "error") errMsg = ev.message;
      }
    }
    if (answer == null) throw new Error(errMsg || "no answer received");
    bubble.classList.remove("pending");
    bubble.innerHTML = mdToHtml(answer);
    ask.history.push({ role: "assistant", content: answer });
  } catch (e) {
    bubble.classList.remove("pending");
    bubble.innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
    ask.history.pop(); // failed turn stays visible but out of the transcript we resend
  } finally {
    ask.busy = false;
    $("#ask-send").disabled = false;
    msgs.scrollTop = msgs.scrollHeight;
  }
}

// -------------------------------------------------------------- KPI render
// kpis: [{metric, label?, value, sub}] — sparkline + delta come from buckets.
function kpiGridHtml(kpis) {
  return `<div class="grid-kpi">${kpis.map((k, i) => `
    <button class="kpi" data-kpi="${i}" ${k.metric ? `data-metric="${k.metric}"` : ""} title="Click for full history">
      <div class="kpi-label"><span>${esc(k.label || (k.metric && METRICS[k.metric].label) || "")}</span><span class="kpi-expand">⤢</span></div>
      <div class="kpi-value num">${k.value}</div>
      <div class="kpi-sub">${k.sub || "&nbsp;"}</div>
      <div class="kpi-spark"><canvas data-spark="${i}"></canvas></div>
    </button>`).join("")}</div>`;
}
// wbr (optional) = { weekly:[buckets], monthly:[buckets] } → renders the 6&12
// mini-chart instead of the plain single-range sparkline. `deltaBuckets`
// (defaults to `buckets`) drives the ▲/▼ chip; `noun` labels its basis.
function activateKpis(container, kpis, buckets, scope, opts = {}) {
  const { wbr = null, noun = INTERVAL_NOUN[state.range], deltaBuckets = buckets } = opts;
  kpis.forEach((k, i) => {
    const canvas = container.querySelector(`canvas[data-spark="${i}"]`);
    const wbrReady = wbr && k.metric && ((wbr.weekly && wbr.weekly.length) || (wbr.monthly && wbr.monthly.length));
    if (canvas && wbrReady) {
      const pmap = (list) => (list || []).map((b) => METRICS[k.metric].primary(b));
      wbrSpark(canvas, pmap(wbr.weekly), pmap(wbr.monthly), k.color || ACCENT, { pct: !!METRICS[k.metric].pctAxis, soft: !!METRICS[k.metric].softMax });
      const cap = document.createElement("div");
      cap.className = "spark-cap";
      cap.innerHTML = `<span>6 wk</span><span>12 mo</span>`;
      canvas.parentElement.after(cap);
    } else if (canvas && k.metric && buckets && buckets.length > 1) {
      sparkline(canvas, buckets.map((b) => METRICS[k.metric].primary(b)), k.color || ACCENT);
    } else if (canvas) {
      canvas.parentElement.remove(); // no trend → compact card
    }
    const d = k.metric && deltaBuckets ? deltaFor(k.metric, deltaBuckets, noun) : null;
    if (d) {
      const lbl = container.querySelector(`[data-kpi="${i}"] .kpi-label`);
      const chip = document.createElement("span");
      chip.className = "delta " + d.cls;
      chip.textContent = d.text;
      chip.title = d.basis;
      lbl.insertBefore(chip, lbl.lastElementChild);
    }
  });
  container.querySelectorAll("[data-metric]").forEach((el) =>
    el.addEventListener("click", () => openMetricModal(el.dataset.metric, scope)));
}

// ============================================================== data table
// Sortable, filterable, exportable, optionally expandable. Sorting cycles
// desc → asc → cleared for numbers/dates (asc first for text), and a
// "clear sort" chip appears whenever a sort is active.
function dataTable({ columns, rows, searchText, csvName, emptyText, onRow, expandable, subLabel }) {
  const root = document.createElement("div");
  const st = { key: null, dir: null, q: "", expanded: new Set() };
  const hasTools = !!searchText || !!csvName;

  root.innerHTML = `
    ${hasTools ? `<div class="toolbar">
      ${searchText ? `<input class="input" type="search" placeholder="Filter…" aria-label="Filter rows">` : ""}
      <span class="spacer"></span>
      <button class="sort-clear" hidden>Sorted · clear ×</button>
      ${csvName ? `<button class="btn" data-csv>↓ Export CSV</button>` : ""}
    </div>` : `<div class="toolbar" hidden><button class="sort-clear" hidden></button></div>`}
    <div class="table-wrap"><table class="data">
      <thead><tr></tr></thead><tbody></tbody>
    </table></div>`;

  const theadTr = $("thead tr", root);
  const tbody = $("tbody", root);
  const clearBtn = $(".sort-clear", root);
  let display = [];

  function currentRows() {
    let out = rows;
    if (st.q && searchText) {
      const q = st.q.toLowerCase();
      out = out.filter((r) => searchText(r).toLowerCase().includes(q));
    }
    if (st.key) {
      const col = columns.find((c) => c.key === st.key);
      const mul = st.dir === "asc" ? 1 : -1;
      out = [...out].sort((a, b) => {
        const va = col.get(a), vb = col.get(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;  // nulls always last
        if (vb == null) return -1;
        return va < vb ? -mul : va > vb ? mul : 0;
      });
    }
    return out;
  }

  function renderHead() {
    theadTr.innerHTML = (expandable ? `<th style="width:36px"></th>` : "") + columns.map((c) => `
      <th class="${c.type === "text" ? "th-text" : ""}" aria-sort="${st.key === c.key ? (st.dir === "asc" ? "ascending" : "descending") : "none"}">
        <button class="th-btn ${st.key === c.key ? "sorted" : ""}" data-sort="${esc(c.key)}" title="Sort by ${esc(c.label)}">
          ${esc(c.label)}<span class="arrow">${st.key === c.key ? (st.dir === "asc" ? "▲" : "▼") : ""}</span>
        </button>
      </th>`).join("");
    theadTr.querySelectorAll("[data-sort]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const key = btn.dataset.sort;
        const col = columns.find((c) => c.key === key);
        const firstDir = col.type === "text" ? "asc" : "desc";
        const secondDir = firstDir === "asc" ? "desc" : "asc";
        if (st.key !== key) { st.key = key; st.dir = firstDir; }
        else if (st.dir === firstDir) st.dir = secondDir;
        else { st.key = null; st.dir = null; } // third click clears the sort
        render();
      }));
  }

  function renderBody() {
    display = currentRows();
    if (!display.length) {
      tbody.innerHTML = `<tr><td class="td-text" colspan="${columns.length + (expandable ? 1 : 0)}"><div class="empty">${esc(emptyText || "no data")}</div></td></tr>`;
      return;
    }
    tbody.innerHTML = display.map((r, i) => `
      <tr data-idx="${i}" class="${onRow ? "rowlink" : ""}">
        ${expandable ? `<td><button class="expander ${st.expanded.has(expandable.id(r)) ? "open" : ""}" data-expand="${i}" aria-label="Expand">▶</button></td>` : ""}
        ${columns.map((c) => `<td class="${c.type === "text" ? "td-text" : "num"}">${c.render(r)}</td>`).join("")}
      </tr>`).join("");
    if (expandable) {
      display.forEach((r, i) => { if (st.expanded.has(expandable.id(r))) mountSub(r, i); });
    }
  }

  function mountSub(row, idx) {
    const anchor = tbody.querySelector(`tr[data-idx="${idx}"]`);
    if (!anchor) return;
    const tr = document.createElement("tr");
    tr.className = "subrow";
    tr.dataset.subfor = idx;
    const td = document.createElement("td");
    td.colSpan = columns.length + 1;
    const mount = document.createElement("div");
    mount.className = "subtable-wrap";
    mount.innerHTML = `<div class="subtitle">${esc(subLabel || "Details")}</div><div class="empty">Loading…</div>`;
    td.appendChild(mount);
    tr.appendChild(td);
    anchor.after(tr);
    expandable.render(row, mount);
  }

  function render() {
    renderHead();
    renderBody();
    clearBtn.hidden = !st.key;
  }

  clearBtn.addEventListener("click", () => { st.key = null; st.dir = null; render(); });
  if (searchText) {
    $("input[type=search]", root).addEventListener("input", (e) => { st.q = e.target.value.trim(); render(); });
  }
  if (csvName) {
    $("[data-csv]", root).addEventListener("click", () => {
      const csvCell = (v) => {
        let s = (v ?? "").toString();
        if (/^[=+\-@]/.test(s)) s = "'" + s; // defuse spreadsheet formula injection
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const head = columns.map((c) => csvCell(c.label)).join(",");
      const body = display.map((r) => columns.map((c) => csvCell(c.csv ? c.csv(r) : c.get(r))).join(",")).join("\n");
      const blob = new Blob([head + "\n" + body], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = csvName + ".csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }
  tbody.addEventListener("click", (e) => {
    const ex = e.target.closest("[data-expand]");
    if (ex && expandable) {
      const idx = Number(ex.dataset.expand);
      const id = expandable.id(display[idx]);
      const open = st.expanded.has(id);
      if (open) {
        st.expanded.delete(id);
        ex.classList.remove("open");
        tbody.querySelector(`tr[data-subfor="${idx}"]`)?.remove();
      } else {
        st.expanded.add(id);
        ex.classList.add("open");
        mountSub(display[idx], idx);
      }
      return;
    }
    const tr = e.target.closest("tr[data-idx]");
    if (tr && onRow) onRow(display[Number(tr.dataset.idx)]);
  });

  render();
  return root;
}

// -------------------------------------------------------------- navigation
const view = $("#view");
// Render token: each view bumps this at entry and re-checks after its awaits.
// A slow view (e.g. the org-wide overview) that resolves AFTER the user has
// navigated elsewhere must not clobber the new view — it just bails.
let viewSeq = 0;
const startRender = () => ++viewSeq;
const stale = (seq) => seq !== viewSeq;
function setActiveNav(id) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  const el = id && (document.querySelector(`.nav-item[data-nav="${id}"]`) || document.querySelector(`.nav-item[data-repoid="${id}"]`));
  if (el) el.classList.add("active");
}
function crumbs(items) {
  $("#breadcrumb").innerHTML = items.map((c, i) => {
    const last = i === items.length - 1;
    const sep = i ? `<span class="crumb-sep">/</span>` : "";
    return sep + (last
      ? `<span class="crumb-here">${esc(c.label)}</span>`
      : `<a class="crumb" href="${esc(c.hash)}">${esc(c.label)}</a>`);
  }).join("");
}
function closeSidebar() { $("#sidebar").classList.remove("open"); $("#sidebar-overlay").hidden = true; }

async function refreshSidebar() {
  try {
    // reuse the ranged overview (repos list is range-independent) so we don't
    // fire a second heavy overview query just for the sidebar.
    const [d, s] = await Promise.all([api.overview(state.range), api.status()]);
    const el = $("#nav-repos");
    const reposByRecency = [...d.repos].sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
    el.innerHTML = reposByRecency.length ? reposByRecency.map((r) => {
      const name = esc((r.full_name || "").split("/")[1] || r.full_name);
      const hot = r.lastActivity && Date.now() - new Date(r.lastActivity) < 14 * 86400000;
      return `<a class="nav-item" href="#/repo/${esc(r.id)}" data-repoid="${esc(r.id)}" title="${esc(r.full_name)}">
        <span class="nav-dot ${hot ? "hot" : ""}"></span>${name}</a>`;
    }).join("") : `<div class="nav-empty">no repos yet</div>`;
    el.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeSidebar));
    $("#sidebar-foot").innerHTML =
      `${num(s.counts.commits)} commits · ${num(s.counts.pull_requests)} PRs · ${num(s.counts.repos)} repos<br>` +
      `data as of <strong>${esc(fmtDate(s.latestEvent))}</strong>`;
    setActiveNav(currentNavId);
  } catch { /* sidebar is decorative; views surface real errors */ }
}

// Freshness banner — the collector backfill is often in flight, so say so.
function freshnessBanner(latestEvent) {
  if (!latestEvent) return "";
  const hours = (Date.now() - new Date(latestEvent)) / 3600000;
  if (hours < 36 || sessionStorage.getItem("dm.bannerDismissed")) return "";
  return `<div class="banner" role="status">
    <span>⚠</span>
    <span><strong>Data is ${relTime(latestEvent)} old</strong> (latest event ${esc(fmtDate(latestEvent))}).
    Collector backfill may still be in progress — totals and history can shift as older data lands.</span>
    <button class="banner-x" data-dismiss-banner aria-label="Dismiss">×</button>
  </div>`;
}
function wireBanner(container) {
  container.querySelector("[data-dismiss-banner]")?.addEventListener("click", (e) => {
    sessionStorage.setItem("dm.bannerDismissed", "1");
    e.target.closest(".banner").remove();
  });
}

function showError(e, retry) {
  clearCharts();
  view.innerHTML = `<div class="error-box">Failed to load: ${esc(e && e.message ? e.message : e)}<br>
    <button class="btn" data-retry>Try again</button></div>`;
  view.querySelector("[data-retry]").addEventListener("click", retry);
}
const skeletonHtml = `
  <div class="grid-kpi">${`<div class="skel" style="height:120px"></div>`.repeat(4)}</div>
  <div class="grid-charts">${`<div class="skel" style="height:280px"></div>`.repeat(2)}</div>
  <div class="section"><div class="skel" style="height:320px"></div></div>`;

// ================================================================= OVERVIEW
async function overviewView() {
  const seq = startRender();
  clearCharts();
  setActiveNav("overview");
  crumbs([{ label: "Overview" }]);
  view.innerHTML = skeletonHtml;

  // Current-range series drives the big charts, the KPI numbers and the deltas.
  // 6w + 12m series feed the fixed WBR (6&12) mini-charts on each KPI card.
  const [d, t, t6, t12] = await Promise.all([
    api.overview(state.range), api.trends(state.range), api.trends("6w"), api.trends("12m"),
  ]);
  if (stale(seq)) return; // navigated away while loading
  const b = t.buckets;
  const RL = RANGE_LABEL[state.range];

  // Range-scoped KPI figures. Summable metrics are derived from the same
  // buckets the charts use (so a card and its chart can never disagree);
  // distinct contributors and median lead time come scoped from the API.
  const sumB = (f) => b.reduce((a, x) => a + (f(x) || 0), 0);
  const rCommits    = sumB((x) => x.commits);
  const rPrsOpened  = sumB((x) => x.prsOpened);
  const rPrsMerged  = sumB((x) => x.prsMerged);
  const rMergeRate  = rPrsOpened ? rPrsMerged / rPrsOpened : null;
  const rDeploys    = sumB((x) => x.deploys);
  const rCiRuns     = sumB((x) => x.ciRuns);
  const rCiPass     = rCiRuns ? b.reduce((a, x) => a + (x.ciPassRate || 0) * (x.ciRuns || 0), 0) / rCiRuns : null;
  const rIssuesOpen = sumB((x) => x.issuesOpened);
  const rIssuesDone = sumB((x) => x.issuesClosed);
  const rContribs   = d.rangeExtras.contributors;
  const rLead       = d.rangeExtras.leadTimeP50h;

  const kpis = [
    { metric: "commits",            value: num(rCommits),    sub: `commits · ${RL}` },
    { metric: "activeContributors", value: num(rContribs),   sub: `committed · ${RL} (of ${num(d.totals.contributors)} all-time)`, color: GREEN },
    { metric: "prs",                value: num(rPrsMerged),  sub: `merged · ${num(rPrsOpened)} opened · ${RL}` },
    { metric: "mergeRate",          value: pct(rMergeRate),  sub: `merged ÷ opened · ${RL}`, color: GREEN },
    { metric: "leadTime",           value: fmtH(rLead),      sub: `median PR open→merge · ${RL}`, color: AMBER },
    { metric: "deploys",            value: num(rDeploys),    sub: `deploy events · ${RL}`, color: GREEN },
    { metric: "ciPassRate",         value: pct(rCiPass),     sub: `${num(rCiRuns)} runs · ${RL}`, color: GREEN },
    { metric: "issues",             value: num(rIssuesOpen), sub: `opened · ${num(rIssuesDone)} closed · ${RL}`, color: AMBER },
  ];
  const noun = INTERVAL_NOUN[state.range];

  view.innerHTML = `
    ${freshnessBanner(d.freshness.latestEvent)}
    <div class="kpi-caption">Figures cover the <strong>${esc(RL)}</strong>; the ▲▼ badge is the last complete ${esc(noun)} vs the one before it. Mini-charts show the Amazon-style <strong>6-week &amp; 12-month</strong> (WBR) trend and don't change with the range.</div>
    ${kpiGridHtml(kpis)}
    <div class="grid-charts">
      <div class="card"><div class="card-head">
          <div><div class="card-title">Team throughput</div><div class="card-sub">commits + active contributors · ${esc(RANGE_LABEL[state.range])}</div></div>
          <button class="btn-ghost btn" data-open-metric="commits">history ⤢</button>
        </div><div class="chart-box"><canvas id="c-throughput"></canvas></div></div>
      <div class="card"><div class="card-head">
          <div><div class="card-title">Pull requests</div><div class="card-sub">opened vs merged · ${esc(RANGE_LABEL[state.range])}</div></div>
          <button class="btn-ghost btn" data-open-metric="prs">history ⤢</button>
        </div><div class="chart-box"><canvas id="c-prs"></canvas></div></div>
      <div class="card"><div class="card-head">
          <div><div class="card-title">Delivery &amp; stability</div><div class="card-sub">deploys (${esc(t.deployMethod)}) + CI pass rate</div></div>
          <button class="btn-ghost btn" data-open-metric="ciPassRate">history ⤢</button>
        </div><div class="chart-box"><canvas id="c-stability"></canvas></div></div>
      <div class="card"><div class="card-head">
          <div><div class="card-title">Issues</div><div class="card-sub">opened vs closed · ${esc(RANGE_LABEL[state.range])}</div></div>
          <button class="btn-ghost btn" data-open-metric="issues">history ⤢</button>
        </div><div class="chart-box"><canvas id="c-issues"></canvas></div></div>
    </div>
    <div class="section">
      <div class="section-label"><span>Repositories — click a row for detail, ▶ to expand contributors</span></div>
      <div id="repo-table"></div>
    </div>
    <div class="section">
      <div class="section-label"><span>When the team works — commits by day &amp; hour (UTC)</span></div>
      <div class="card" id="ov-punchcard"></div>
    </div>
    <div class="section">
      <div class="section-label"><span>CI &amp; workflow reliability — pass rate, retries &amp; duration per pipeline</span></div>
      <div class="card" id="ov-workflows"></div>
    </div>
    <div class="grid-charts">
      <div class="card"><div class="card-head"><div><div class="card-title">Issue backlog &amp; resolution</div><div class="card-sub">how issues get closed, and how old the open ones are</div></div></div>
        <div id="ov-issues"></div></div>
      <div class="card"><div class="card-head"><div><div class="card-title">Review health</div><div class="card-sub">review outcomes &amp; coverage across merged PRs</div></div></div>
        <div id="ov-reviews"></div></div>
    </div>`;
  wireBanner(view);

  // Progressive-enhancement sections: prefetched at boot, so these resolve from
  // cache immediately; if not yet warm they fill in without blocking first paint.
  fillAsync($("#ov-punchcard"), api.activity(), punchcardHtml);
  fillAsync($("#ov-issues"), api.issuesInsight(), issueInsightsHtml);
  fillAsync($("#ov-reviews"), api.reviews(), reviewHealthHtml);
  api.workflows().then((w) => mountWorkflowTable($("#ov-workflows"), w))
    .catch((e) => { const el = $("#ov-workflows"); if (el) el.innerHTML = `<div class="empty">couldn't load workflows: ${esc(e.message || e)}</div>`; });

  activateKpis(view, kpis, b, {}, { wbr: { weekly: t6.buckets, monthly: t12.buckets }, noun, deltaBuckets: b });
  view.querySelectorAll("[data-open-metric]").forEach((el) =>
    el.addEventListener("click", () => openMetricModal(el.dataset.openMetric, {})));

  const labels = b.map((x) => x.bucket);
  stdChart($("#c-throughput"), labels, [
    bars("commits", b.map((x) => x.commits), ACCENT),
    line("active contributors", b.map((x) => x.activeContributors), GREEN, { yAxisID: "y1" }),
  ], { y1: "count" });
  stdChart($("#c-prs"), labels, [
    line("opened", b.map((x) => x.prsOpened), ACCENT),
    line("merged", b.map((x) => x.prsMerged), GREEN),
  ]);
  stdChart($("#c-stability"), labels, [
    bars("deploys", b.map((x) => x.deploys), "rgba(16,185,129,.5)"),
    line("CI pass rate", b.map((x) => x.ciPassRate), AMBER, { yAxisID: "y1" }),
  ], { y1: "pct" });
  stdChart($("#c-issues"), labels, [
    line("opened", b.map((x) => x.issuesOpened), AMBER),
    line("closed", b.map((x) => x.issuesClosed), GREEN),
  ]);

  // ---- the SQL-style repo table: default order = most recently active ----
  const repoRows = [...d.repos].sort((a, bb) => (bb.lastActivity || "").localeCompare(a.lastActivity || ""));
  const cols = [
    { key: "repo", label: "Repository", type: "text", get: (r) => r.full_name.toLowerCase(), csv: (r) => r.full_name,
      render: (r) => `<span class="cell-primary">${esc(r.full_name)}</span>` },
    { key: "last", label: "Last activity", get: (r) => (r.lastActivity ? Date.parse(r.lastActivity) : null), csv: (r) => r.lastActivity || "",
      render: (r) => `<span title="${esc(fmtDate(r.lastActivity))}">${esc(relTime(r.lastActivity))}</span>` },
    { key: "commits", label: "Commits", get: (r) => r.commits, render: (r) => num(r.commits) },
    { key: "contributors", label: "People", get: (r) => r.contributors, render: (r) => num(r.contributors) },
    { key: "prs", label: "PRs", get: (r) => r.prsTotal, csv: (r) => r.prsTotal,
      render: (r) => `${num(r.prsTotal)}${r.prsOpen ? ` <span class="cell-dim">(${num(r.prsOpen)} open)</span>` : ""}` },
    { key: "mergeRate", label: "Merge rate", get: (r) => r.mergeRate, render: (r) => pct(r.mergeRate) },
    { key: "lead", label: "Lead time", get: (r) => r.leadTimeP50h, csv: (r) => r.leadTimeP50h ?? "", render: (r) => fmtH(r.leadTimeP50h) },
    { key: "dfreq", label: "Deploys/wk", get: (r) => r.deployPerWeek, csv: (r) => r.deployPerWeek?.toFixed(2) ?? "", render: (r) => freq(r.deployPerWeek) },
    { key: "cfr", label: "CFR", get: (r) => r.changeFailureRate, csv: (r) => r.changeFailureRate ?? "",
      render: (r) => `<span title="Change failure rate (${esc(r.cfrMethod)})">${pct(r.changeFailureRate)}</span>` },
    { key: "mttr", label: "MTTR", get: (r) => r.mttrP50h, csv: (r) => r.mttrP50h ?? "",
      render: (r) => `<span title="Median time to restore (CI on main)">${fmtH(r.mttrP50h)}</span>` },
    { key: "issues", label: "Open issues", get: (r) => r.issuesOpen, render: (r) => num(r.issuesOpen) },
    { key: "bus", label: "Bus factor", get: (r) => r.busFactor, csv: (r) => r.busFactor ?? "",
      render: (r) => busFactorChip(r) },
    { key: "signal", label: "Deploy signal", type: "text", get: (r) => r.deployMethod, csv: (r) => r.deployMethod,
      render: (r) => methodChip(r.deployMethod) },
  ];
  $("#repo-table").appendChild(dataTable({
    columns: cols,
    rows: repoRows,
    searchText: (r) => r.full_name,
    csvName: "repos-" + new Date().toISOString().slice(0, 10),
    emptyText: "no repositories yet — install the collector on a repo",
    onRow: (r) => { location.hash = "#/repo/" + r.id; },
    subLabel: "Contributors (most recent first)",
    expandable: {
      id: (r) => r.id,
      render: async (r, mount) => {
        try {
          const list = await api.contributors(r.id);
          if (!list.length) { mount.innerHTML = `<div class="empty">no contributor data</div>`; return; }
          const sub = dataTable({
            columns: [
              { key: "login", label: "Contributor", type: "text", get: (c) => c.login.toLowerCase(), csv: (c) => c.login,
                render: (c) => `<span class="avatar sm">${esc(initialsOf(c.login))}</span>&nbsp; <span class="cell-primary">${esc(c.login)}</span>` },
              { key: "last", label: "Last active", get: (c) => (c.last_commit ? Date.parse(c.last_commit) : null), render: (c) => relTime(c.last_commit) },
              { key: "commits", label: "Commits", get: (c) => c.commits, render: (c) => num(c.commits) },
              { key: "mix", label: "Top work", type: "text", get: (c) => topChangeType(c) || "", render: (c) => ctChip(topChangeType(c)) || `<span class="cell-dim">—</span>` },
              { key: "prso", label: "PRs opened", get: (c) => c.prs_opened, render: (c) => num(c.prs_opened) },
              { key: "prsm", label: "PRs merged", get: (c) => c.prs_merged, render: (c) => num(c.prs_merged) },
            ],
            rows: list,
            onRow: (c) => { location.hash = `#/contributor/${encodeURIComponent(c.login)}?repo=${r.id}`; },
          });
          mount.innerHTML = `<div class="subtitle">Contributors · ${esc(r.full_name)}</div>`;
          mount.appendChild(sub);
        } catch (e) {
          mount.innerHTML = `<div class="empty">failed to load contributors: ${esc(e.message)}</div>`;
        }
      },
    },
  }));
}

const topChangeType = (c) => [
  ["new_feature", c.new_features || 0], ["bug_fix", c.bug_fixes || 0],
  ["refactor", c.refactors || 0], ["test", c.tests || 0],
  ["docs", c.docs || 0], ["config", c.configs || 0], ["chore", c.chores || 0],
].filter(([, n]) => n > 0).sort(([, a], [, b]) => b - a)[0]?.[0] || null;

// ===================================================================== TEAM
async function teamView() {
  const seq = startRender();
  clearCharts();
  setActiveNav("team");
  crumbs([{ label: "Overview", hash: "#/" }, { label: "Team" }]);
  view.innerHTML = skeletonHtml;

  const [d, t] = await Promise.all([api.team(), api.trends(state.range)]);
  if (stale(seq)) return;
  const b = t.buckets;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Team</div>
        <div class="page-sub">${num(d.contributors.length)} contributors · ${num(d.activeLast30d)} active in the last 30 days</div>
      </div>
    </div>
    <p class="note">These are <strong>team-level</strong> signals about how the system of work behaves — flow, review health,
    where effort goes. They are not individual performance scores; commit counts vary wildly with task type and say
    nothing about impact.</p>
    <div class="grid-charts">
      <div class="card"><div class="card-head">
          <div><div class="card-title">Active contributors</div><div class="card-sub">people committing per ${esc(INTERVAL_NOUN[state.range])} · ${esc(RANGE_LABEL[state.range])}</div></div>
          <button class="btn-ghost btn" data-open-metric="activeContributors">history ⤢</button>
        </div><div class="chart-box"><canvas id="c-active"></canvas></div></div>
      <div class="card"><div class="card-head">
          <div><div class="card-title">Work mix</div><div class="card-sub">what kind of work the team ships (LLM-classified commits)</div></div>
        </div><div class="chart-box" id="c-mix-box"><canvas id="c-mix"></canvas></div></div>
      <div class="card"><div class="card-head">
          <div><div class="card-title">Review activity</div><div class="card-sub">PR reviews submitted · ${esc(RANGE_LABEL[state.range])}</div></div>
          <button class="btn-ghost btn" data-open-metric="reviews">history ⤢</button>
        </div><div class="chart-box"><canvas id="c-reviews"></canvas></div></div>
    </div>
    <div class="section">
      <div class="section-label"><span>Directory — ordered by recent activity, click a person for their profile</span></div>
      <div id="team-table"></div>
    </div>`;

  view.querySelectorAll("[data-open-metric]").forEach((el) =>
    el.addEventListener("click", () => openMetricModal(el.dataset.openMetric, {})));

  const labels = b.map((x) => x.bucket);
  stdChart($("#c-active"), labels, [bars("active contributors", b.map((x) => x.activeContributors), GREEN)], { legend: false });
  if (d.typeBreakdown.length) {
    doughnutChart($("#c-mix"),
      d.typeBreakdown.map((x) => CT_LABELS[x.change_type]?.label || x.change_type),
      d.typeBreakdown.map((x) => x.count),
      d.typeBreakdown.map((x) => CT_COLORS[x.change_type] || SLATE));
  } else {
    $("#c-mix-box").innerHTML = `<div class="empty">no classified commits yet</div>`;
  }
  stdChart($("#c-reviews"), labels, [bars("reviews", b.map((x) => x.reviews), "#8b5cf6")], { legend: false });

  $("#team-table").appendChild(dataTable({
    columns: [
      { key: "login", label: "Contributor", type: "text", get: (c) => c.login.toLowerCase(), csv: (c) => c.login,
        render: (c) => `<span class="avatar sm">${esc(initialsOf(c.login))}</span>&nbsp; <span class="cell-primary">${esc(c.login)}</span>` },
      { key: "last", label: "Last active", get: (c) => (c.last_active ? Date.parse(c.last_active) : null), csv: (c) => c.last_active || "", render: (c) => relTime(c.last_active) },
      { key: "first", label: "First seen", get: (c) => (c.first_active ? Date.parse(c.first_active) : null), csv: (c) => c.first_active || "", render: (c) => fmtDate(c.first_active) },
      { key: "repos", label: "Repos", get: (c) => c.repos, render: (c) => num(c.repos) },
      { key: "commits", label: "Commits", get: (c) => c.commits, render: (c) => num(c.commits) },
      { key: "prso", label: "PRs opened", get: (c) => c.prs_opened, render: (c) => num(c.prs_opened) },
      { key: "prsm", label: "PRs merged", get: (c) => c.prs_merged, render: (c) => num(c.prs_merged) },
      { key: "reviews", label: "Reviews given", get: (c) => c.reviews_given, render: (c) => num(c.reviews_given) },
    ],
    rows: d.contributors,
    searchText: (c) => c.login,
    csvName: "team-" + new Date().toISOString().slice(0, 10),
    emptyText: "no contributors yet",
    onRow: (c) => { location.hash = "#/contributor/" + encodeURIComponent(c.login); },
  }));
}

// ===================================================================== REPO
async function repoView(id) {
  const seq = startRender();
  clearCharts();
  setActiveNav(id);
  view.innerHTML = skeletonHtml;

  const [d, t, weekly, commits, contribs] = await Promise.all([
    api.repo(id),
    api.trends(state.range, id),
    api.weekly(id).catch(() => []),
    api.repoCommits(id).catch(() => []),
    api.contributors(id).catch(() => []),
  ]);
  if (stale(seq)) return;
  const s = d.summary;
  const b = t.buckets;
  crumbs([{ label: "Overview", hash: "#/" }, { label: d.repo.full_name }]);

  const scope = { repoId: id, title: d.repo.full_name };
  const doraKpis = [
    { metric: "deploys",  label: "Deploy frequency", value: freq(s.deployPerWeek), sub: `${num(s.deployCount)} events · ${esc(s.deployMethod)}`, color: GREEN },
    { metric: "leadTime", label: "Lead time (p50)",  value: fmtH(s.leadTimeP50h),  sub: "p90 " + fmtH(s.leadTimeP90h), color: AMBER },
    { metric: "ciPassRate", label: "Change failure rate", value: pct(s.changeFailureRate), sub: s.cfrMethod === "none" ? "no CI on main yet" : "failed CI on main (proxy)", color: RED },
    { metric: "ciPassRate", label: "Time to restore (p50)", value: fmtH(s.mttrP50h), sub: s.mttrFailures ? `${num(s.mttrRecovered)}/${num(s.mttrFailures)} streaks recovered` : "no failures recorded", color: RED },
  ];
  const actKpis = [
    { metric: "commits",            value: num(s.commits),      sub: "all-time" },
    { metric: "activeContributors", value: num(s.contributors), sub: "all-time authors", color: GREEN },
    { metric: "prs",                value: num(s.prsMerged),    sub: `${num(s.prsTotal)} opened · ${num(s.prsOpen)} open now` },
    { metric: "mergeRate",          value: pct(s.mergeRate),    sub: "of closed PRs", color: GREEN },
    { metric: "issues",             value: num(s.issuesOpen),   sub: `open · median close ${fmtH(s.issueCloseP50h)}`, color: AMBER },
    { metric: "reviews",            value: pct(d.reviews.coverage), label: "Review coverage", sub: "first review in " + fmtH(d.reviews.timeToFirstReviewP50h), color: "#8b5cf6" },
  ];

  view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">${esc(d.repo.full_name)}</div>
        <div class="page-sub">last activity ${esc(relTime(s.lastActivity))} · ${esc(fmtDate(s.lastActivity))}</div>
      </div>
      <div class="head-chips">
        ${methodChip(s.deployMethod)}
        ${s.busFactor != null ? `<span class="chip ${s.busFactor <= 1 ? "chip-bad" : s.busFactor <= 2 ? "chip-warn" : "chip-good"}" title="${num(s.busFactor)} contributor${s.busFactor !== 1 ? "s" : ""} account for ≥50% of commits — lower means knowledge is concentrated in fewer people (a delivery risk)">bus factor ${num(s.busFactor)}${s.topContribShare != null ? " · top " + Math.round(s.topContribShare * 100) + "%" : ""}</span>` : ""}
      </div>
    </div>
    <div class="section-label"><span>DORA · click any card for full history</span></div>
    <div id="dora-kpis"></div>
    <div class="section-label" style="margin-top:18px"><span>Activity</span></div>
    <div id="act-kpis"></div>
    <div class="grid-charts">
      <div class="card"><div class="card-head">
          <div><div class="card-title">Pull requests</div><div class="card-sub">opened vs merged · ${esc(RANGE_LABEL[state.range])}</div></div>
        </div><div class="chart-box"><canvas id="c-prs"></canvas></div></div>
      <div class="card"><div class="card-head">
          <div><div class="card-title">Delivery &amp; stability</div><div class="card-sub">deploys (${esc(t.deployMethod)}) + CI pass rate</div></div>
        </div><div class="chart-box"><canvas id="c-stability"></canvas></div></div>
    </div>
    <div class="section">
      <div class="section-label"><span>When this repo is worked on — commits by day &amp; hour (UTC)</span></div>
      <div class="card" id="repo-punchcard"></div>
    </div>
    <div class="section">
      <div class="section-label"><span>CI &amp; workflow reliability</span></div>
      <div class="card" id="repo-workflows"></div>
    </div>
    <div class="grid-charts">
      <div class="card"><div class="card-head"><div><div class="card-title">Issue backlog &amp; resolution</div><div class="card-sub">how issues close &amp; how old the open ones are</div></div></div>
        <div id="repo-issues"></div></div>
      <div class="card"><div class="card-head"><div><div class="card-title">Review health</div><div class="card-sub">review outcomes &amp; coverage</div></div></div>
        <div id="repo-reviews"></div></div>
    </div>
    <div class="section">
      <div class="card"><div class="card-head">
          <div><div class="card-title">Commit timeline</div><div class="card-sub">every commit by impact tier — hover a dot for details</div></div>
        </div><div class="chart-box tall" id="c-commits-box"><canvas id="c-commits"></canvas></div></div>
    </div>
    <div class="section">
      <div class="section-label"><span>Team on this repo — most recently active first</span>
        <a class="btn btn-ghost" href="#/repo/${esc(id)}/team">View all →</a></div>
      <div class="contrib-grid" id="repo-contribs"></div>
    </div>
    <div class="section">
      <div class="section-label"><span>Weekly digest — last 12 weeks</span></div>
      <div class="card" id="weekly-digest"></div>
    </div>
    <div class="section" style="padding-bottom:40px">
      <div class="section-label"><span>Recent pull requests</span></div>
      <div id="recent-prs"></div>
    </div>`;

  const doraEl = $("#dora-kpis"), actEl = $("#act-kpis");
  doraEl.innerHTML = kpiGridHtml(doraKpis);
  activateKpis(doraEl, doraKpis, b, scope);
  actEl.innerHTML = kpiGridHtml(actKpis);
  activateKpis(actEl, actKpis, b, scope);

  const labels = b.map((x) => x.bucket);
  stdChart($("#c-prs"), labels, [
    line("opened", b.map((x) => x.prsOpened), ACCENT),
    line("merged", b.map((x) => x.prsMerged), GREEN),
  ]);
  stdChart($("#c-stability"), labels, [
    bars("deploys", b.map((x) => x.deploys), "rgba(16,185,129,.5)"),
    line("CI pass rate", b.map((x) => x.ciPassRate), AMBER, { yAxisID: "y1" }),
  ], { y1: "pct" });

  // repo-scoped insight sections (prefetch is org-wide only, so these fetch here)
  fillAsync($("#repo-punchcard"), api.activity(id), punchcardHtml);
  fillAsync($("#repo-issues"), api.issuesInsight(id), issueInsightsHtml);
  fillAsync($("#repo-reviews"), api.reviews(id), reviewHealthHtml);
  api.workflows(id).then((w) => mountWorkflowTable($("#repo-workflows"), w))
    .catch((e) => { const el = $("#repo-workflows"); if (el) el.innerHTML = `<div class="empty">couldn't load workflows: ${esc(e.message || e)}</div>`; });

  if (commits.length) commitTimelineChart($("#c-commits"), commits);
  else $("#c-commits-box").innerHTML = `<div class="empty">no commit data</div>`;

  $("#repo-contribs").innerHTML = contribs.length
    ? contribs.slice(0, 8).map((c) => contribCardHtml(c)).join("")
    : `<div class="empty">no contributor data</div>`;
  wireContribCards($("#repo-contribs"), id);

  $("#weekly-digest").innerHTML = weeklyDigestHtml(weekly);

  $("#recent-prs").appendChild(dataTable({
    columns: [
      { key: "n", label: "#", get: (p) => p.number, render: (p) => `<span class="cell-dim">#${num(p.number)}</span>` },
      { key: "title", label: "Title", type: "text", get: (p) => (p.title || "").toLowerCase(), render: (p) => esc(p.title) },
      { key: "author", label: "Author", type: "text", get: (p) => (p.author_login || "").toLowerCase(), render: (p) => esc(p.author_login || "—") },
      { key: "created", label: "Opened", get: (p) => (p.created_at ? Date.parse(p.created_at) : null), render: (p) => fmtDate(p.created_at) },
      { key: "state", label: "State", type: "text", get: (p) => (p.merged_at ? "merged" : p.state),
        render: (p) => {
          const st = p.merged_at ? "merged" : p.state === "open" ? "open" : "closed";
          const cls = st === "merged" ? "chip-good" : st === "open" ? "chip-info" : "chip-bad";
          return `<span class="chip ${cls}">${st}</span>`;
        } },
    ],
    rows: d.recentPRs,
    emptyText: "no pull requests",
  }));
}

function contribCardHtml(c) {
  const mergedClosed = (c.prs_merged || 0) + (c.prs_closed_unmerged || 0);
  const mr = mergedClosed ? Math.round((c.prs_merged / mergedClosed) * 100) + "%" : "—";
  const top = topChangeType(c);
  return `<button class="contrib-card" data-login="${esc(c.login)}">
    <div class="cc-head">
      <span class="avatar md">${esc(initialsOf(c.login))}</span>
      <div style="min-width:0">
        <div class="cc-name">${esc(c.login)}</div>
        <div class="cc-sub">active ${esc(relTime(c.last_commit))}</div>
      </div>
    </div>
    <div class="cc-row"><span class="k">Commits</span><span class="v">${num(c.commits)}</span></div>
    <div class="cc-row"><span class="k">PRs opened</span><span class="v">${num(c.prs_opened)}</span></div>
    <div class="cc-row"><span class="k">Merge rate</span><span class="v">${mr}</span></div>
    ${top ? `<div class="cc-foot">${ctChip(top)}</div>` : ""}
  </button>`;
}
function wireContribCards(container, repoId) {
  container.querySelectorAll("[data-login]").forEach((el) =>
    el.addEventListener("click", () =>
      { location.hash = `#/contributor/${encodeURIComponent(el.dataset.login)}${repoId ? "?repo=" + repoId : ""}`; }));
}

// ------------------------------------------------------- repo contributors
async function repoTeamView(id) {
  const seq = startRender();
  clearCharts();
  setActiveNav(id);
  view.innerHTML = skeletonHtml;
  const [d, contribs] = await Promise.all([api.repo(id), api.contributors(id)]);
  if (stale(seq)) return;
  crumbs([
    { label: "Overview", hash: "#/" },
    { label: d.repo.full_name, hash: "#/repo/" + id },
    { label: "Contributors" },
  ]);
  view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">${esc(d.repo.full_name)} — contributors</div>
        <div class="page-sub">${contribs.length} contributor${contribs.length !== 1 ? "s" : ""} · ordered by recent activity · click a card for the full profile</div>
      </div>
    </div>
    ${contribs.length
      ? `<div class="contrib-grid" id="grid"></div>`
      : `<div class="card empty">no contributors found</div>`}`;
  if (contribs.length) {
    $("#grid").innerHTML = contribs.map((c) => contribCardHtml(c)).join("");
    wireContribCards($("#grid"), id);
  }
}

// ============================================================== CONTRIBUTOR
async function contributorView(login, params) {
  const seq = startRender();
  clearCharts();
  const fromRepo = params.get("repo");
  view.innerHTML = skeletonHtml;

  const reqs = [api.contributor(login), api.contributorCommits(login).catch(() => [])];
  if (fromRepo) reqs.push(api.repo(fromRepo).catch(() => null));
  const [d, activityCommits, fromRepoDetail] = await Promise.all(reqs);
  if (stale(seq)) return;
  const s = d.summary;
  setActiveNav(fromRepo || "team");
  crumbs([
    { label: "Overview", hash: "#/" },
    ...(fromRepoDetail ? [
      { label: fromRepoDetail.repo.full_name, hash: "#/repo/" + fromRepo },
      { label: "Contributors", hash: `#/repo/${fromRepo}/team` },
    ] : [{ label: "Team", hash: "#/team" }]),
    { label: "@" + login },
  ]);

  const totalTyped = d.typeBreakdown.reduce((a, x) => a + x.count, 0);
  const productWork = d.typeBreakdown.filter((x) => x.change_type === "new_feature" || x.change_type === "bug_fix").reduce((a, x) => a + x.count, 0);
  const focusPct = totalTyped ? Math.round((productWork / totalTyped) * 100) + "%" : "—";

  view.innerHTML = `
    <div class="page-head">
      <span class="avatar lg">${esc(initialsOf(login))}</span>
      <div>
        <div class="page-title">@${esc(login)}</div>
        <div class="page-sub">active since ${esc(fmtDate(s.firstCommit))} · last commit ${esc(relTime(s.lastCommit))}</div>
      </div>
    </div>
    <div class="grid-kpi">
      ${staticKpi("Commits", num(s.totalCommits), s.reposCount + " repo" + (s.reposCount !== 1 ? "s" : ""))}
      ${staticKpi("PRs opened", num(s.prsOpened), num(s.prsMerged) + " merged")}
      ${staticKpi("Merge rate", pct(s.mergeRate), "of closed PRs")}
      ${staticKpi("Lead time p50", fmtH(s.leadTimeP50h), "p90 " + fmtH(s.leadTimeP90h))}
      ${staticKpi("Product focus", focusPct, "features &amp; bug fixes")}
      ${staticKpi("Last active", relTime(s.lastCommit), fmtDate(s.lastCommit))}
    </div>
    <div class="section">
      <div class="card"><div class="card-head">
        <div><div class="card-title">Commit activity</div><div class="card-sub">commits per week, stacked by type</div></div>
      </div><div class="chart-box tall" id="c-activity-box"><canvas id="c-activity"></canvas></div></div>
    </div>
    <div class="grid-charts">
      <div class="card"><div class="card-head">
        <div><div class="card-title">Commit type breakdown</div><div class="card-sub">all-time distribution of work</div></div>
      </div><div class="chart-box" id="c-types-box"><canvas id="c-types"></canvas></div></div>
      <div class="card"><div class="card-head">
        <div><div class="card-title">Focus areas</div><div class="card-sub">by classified commit domain</div></div>
      </div><div id="domains"></div></div>
    </div>
    <div class="section">
      <div class="section-label"><span>Repos pushed to</span></div>
      <div id="repos-table"></div>
    </div>
    <div class="section" style="padding-bottom:40px" id="recent-box"></div>`;

  if (activityCommits.length) contributorActivityChart($("#c-activity"), activityCommits);
  else $("#c-activity-box").innerHTML = `<div class="empty">no commit history</div>`;

  if (d.typeBreakdown.length) {
    doughnutChart($("#c-types"),
      d.typeBreakdown.map((x) => CT_LABELS[x.change_type]?.label || x.change_type),
      d.typeBreakdown.map((x) => x.count),
      d.typeBreakdown.map((x) => CT_COLORS[x.change_type] || SLATE));
  } else {
    $("#c-types-box").innerHTML = `<div class="empty">no categorised commits</div>`;
  }

  $("#domains").innerHTML = d.topDomains.length ? d.topDomains.map((x) => {
    const maxD = Math.max(...d.topDomains.map((y) => y.count), 1);
    return `<div class="hbar-row">
      <div class="hbar-name">${esc(x.domain)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${Math.round((x.count / maxD) * 100)}%"></div></div>
      <div class="hbar-val">${num(x.count)} commits</div>
    </div>`;
  }).join("") : `<div class="empty">no domain data</div>`;

  $("#repos-table").appendChild(dataTable({
    columns: [
      { key: "repo", label: "Repo", type: "text", get: (r) => r.full_name.toLowerCase(), render: (r) => `<span class="cell-primary">${esc(r.full_name)}</span>` },
      { key: "commits", label: "Commits", get: (r) => r.commits, render: (r) => num(r.commits) },
      { key: "share", label: "Share of their work", get: (r) => r.commits,
        render: (r) => s.totalCommits ? Math.round((r.commits / s.totalCommits) * 100) + "%" : "—" },
      { key: "prs", label: "PRs", get: (r) => r.prs, render: (r) => num(r.prs) },
    ],
    rows: d.repos,
    emptyText: "no repos",
    onRow: (r) => { location.hash = "#/repo/" + r.id; },
  }));

  if (d.recentActivity.length) {
    $("#recent-box").innerHTML = `
      <div class="section-label"><span>Recent commits</span></div>
      <div class="card" style="padding:0">${d.recentActivity.map((a) => `
        <div style="padding:12px 20px;border-top:1px solid var(--border-soft);display:flex;gap:12px;align-items:flex-start">
          <div style="flex:none;margin-top:2px">${ctChip(a.change_type)}</div>
          <div style="min-width:0">
            <div style="font-size:13.5px;color:var(--text-mid);line-height:1.45">${esc(a.summary)}</div>
            <div class="note" style="margin-top:3px">${esc(a.repo)} · ${esc(fmtDate(a.authored_at))}${a.domain ? " · " + esc(a.domain) : ""}</div>
          </div>
        </div>`).join("")}</div>`;
  }
}
const staticKpi = (label, value, sub) => `
  <div class="kpi" style="cursor:default">
    <div class="kpi-label"><span>${label}</span></div>
    <div class="kpi-value num">${value}</div>
    <div class="kpi-sub">${sub || "&nbsp;"}</div>
  </div>`;

// -------------------------------------------------- ported feature charts
// Commit scatter timeline — X=time, Y=impact tier by change_type.
const TIER = { new_feature: 5, bug_fix: 4, refactor: 3, test: 2, docs: 1, config: 1, chore: 1 };
const TIER_LABEL = { 0: "unanalysed", 1: "chore / docs", 2: "test", 3: "refactor", 4: "bug fix", 5: "feature" };
const TIER_COLOR = {
  new_feature: "rgba(99,102,241,0.75)", bug_fix: "rgba(239,68,68,0.75)",
  refactor: "rgba(16,185,129,0.75)", test: "rgba(245,158,11,0.75)",
  docs: "rgba(100,116,139,0.70)", config: "rgba(100,116,139,0.70)",
  chore: "rgba(71,85,105,0.70)", unknown: "rgba(51,65,85,0.60)",
};
function commitTimelineChart(canvas, commits) {
  const groups = {};
  for (const c of commits) {
    const type = c.change_type || "unknown";
    (groups[type] ||= []).push({
      x: new Date(c.authored_at).getTime(),
      // deterministic jitter ±0.28 from the sha spreads same-tier dots
      y: (TIER[c.change_type] ?? 0) + ((parseInt((c.sha || "000").slice(-3), 16) % 57) - 28) / 100,
      author: c.author_login, summary: c.summary, change_type: c.change_type,
      domain: c.domain, authored_at: c.authored_at,
    });
  }
  const typeOrder = ["new_feature", "bug_fix", "refactor", "test", "docs", "config", "chore", "unknown"];
  addChart(canvas, {
    type: "scatter",
    data: {
      datasets: typeOrder.filter((t) => groups[t]).map((type) => ({
        label: CT_LABELS[type]?.label || "unanalysed",
        data: groups[type], backgroundColor: TIER_COLOR[type],
        pointRadius: 4, pointHoverRadius: 7, pointBorderWidth: 0,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: legendOpts,
        tooltip: {
          mode: "nearest", intersect: true,
          callbacks: {
            title: (items) => { const r = items[0]?.raw; return r ? "@" + r.author + "  ·  " + fmtDate(r.authored_at) : ""; },
            label: (item) => {
              const r = item.raw, lines = [];
              if (r.summary) lines.push(r.summary);
              const tier = CT_LABELS[r.change_type]?.label;
              if (tier) lines.push("Type: " + tier);
              if (r.domain) lines.push("Area: " + r.domain);
              return lines.length ? lines : ["(no analysis)"];
            },
          },
        },
      },
      scales: {
        x: { type: "linear", ticks: { color: TICK, maxTicksLimit: 8, font: { size: 11 }, callback: (v) => new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) }, grid: { color: GRID } },
        y: { min: -0.5, max: 5.8, ticks: { color: TICK, font: { size: 10 }, stepSize: 1, callback: (v) => TIER_LABEL[Math.round(v)] || "" }, grid: { color: GRID } },
      },
    },
  });
}

// Contributor weekly activity — stacked bars by commit type.
const ACT_SOLID = {
  new_feature: "rgba(99,102,241,0.85)", bug_fix: "rgba(239,68,68,0.85)",
  refactor: "rgba(16,185,129,0.85)", test: "rgba(245,158,11,0.85)",
  docs: "rgba(100,116,139,0.75)", config: "rgba(71,85,105,0.75)",
  chore: "rgba(51,65,85,0.75)", unknown: "rgba(71,85,105,0.55)",
};
function contributorActivityChart(canvas, commits) {
  const weekMap = {};
  for (const c of commits) {
    const d = new Date(c.authored_at);
    const wk = new Date(d);
    wk.setUTCHours(0, 0, 0, 0);
    wk.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = wk.toISOString().slice(0, 10);
    (weekMap[key] ||= {})[c.change_type || "unknown"] = (weekMap[key]?.[c.change_type || "unknown"] || 0) + 1;
  }
  const weeks = Object.keys(weekMap).sort();
  const labels = weeks.map((w) => new Date(w + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  const typeOrder = ["new_feature", "bug_fix", "refactor", "test", "docs", "config", "chore", "unknown"];
  addChart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: typeOrder.filter((tp) => weeks.some((w) => weekMap[w][tp])).map((type) => ({
        label: CT_LABELS[type]?.label || "unanalysed",
        data: weeks.map((w) => weekMap[w][type] || 0),
        backgroundColor: ACT_SOLID[type], borderWidth: 0, borderRadius: 2, stack: "commits",
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: legendOpts,
        tooltip: {
          mode: "index", intersect: false,
          callbacks: {
            title: (items) => "Week of " + labels[items[0].dataIndex],
            label: (item) => item.raw > 0 ? " " + item.dataset.label + ": " + item.raw : null,
            footer: (items) => "Total: " + items.reduce((s, i) => s + i.raw, 0) + " commits",
          },
        },
      },
      scales: {
        x: { stacked: true, ticks: { color: TICK, font: { size: 11 }, maxTicksLimit: Math.min(weeks.length, 16), maxRotation: 45 }, grid: { color: GRID } },
        y: { stacked: true, beginAtZero: true, ticks: { color: TICK, font: { size: 11 }, precision: 0 }, grid: { color: GRID } },
      },
    },
  });
}

// Weekly digest list (per-repo).
function weeklyDigestHtml(weeks) {
  if (!weeks || !weeks.length) return `<div class="empty">no commits in the last 12 weeks</div>`;
  return weeks.map((w) => {
    const badges = [
      { key: "new_feature", n: w.new_features }, { key: "bug_fix", n: w.bug_fixes },
      { key: "refactor", n: w.refactors }, { key: "test", n: w.tests },
      { key: "docs", n: w.docs }, { key: "config", n: w.configs }, { key: "chore", n: w.chores },
    ].filter((x) => x.n > 0).map((x) => {
      const { cls, label } = CT_LABELS[x.key] || { cls: "chip-muted", label: x.key };
      return `<span class="chip ${cls}">${num(x.n)}&nbsp;${esc(label)}</span>`;
    }).join(" ");
    const summaries = (w.analyses || []).filter((a) => a.summary).slice(0, 5);
    return `<div class="digest-week">
      <div class="digest-head">
        <span class="digest-date">${esc(w.week)}</span>
        <span class="digest-meta">${num(w.total)} commit${w.total !== 1 ? "s" : ""} · ${num(w.contributors)} contributor${w.contributors !== 1 ? "s" : ""}</span>
        <div class="digest-badges">${badges || `<span class="chip chip-muted">unclassified</span>`}</div>
      </div>
      ${summaries.length ? `<ul class="digest-list">${summaries.map((a) =>
        `<li><span>${esc(a.summary)} <span class="by">${esc(a.author || "")}</span></span></li>`).join("")}</ul>` : ""}
    </div>`;
  }).join("");
}

// ----------------------------------------------------- new insight renderers
const fmtMin = (m) => m == null ? "—" : m < 1 ? Math.round(m * 60) + "s" : m < 60 ? m.toFixed(1) + "m" : (m / 60).toFixed(1) + "h";
const DOW_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Fill a container from a promise, with graceful loading / empty / error states.
function fillAsync(el, promise, render) {
  if (!el) return;
  el.innerHTML = `<div class="empty">Loading…</div>`;
  promise
    .then((d) => { el.innerHTML = render(d) || `<div class="empty">no data</div>`; if (el._after) el._after(d); })
    .catch((e) => { el.innerHTML = `<div class="empty">couldn't load: ${esc(e.message || e)}</div>`; });
}

// GitHub-style commit punchcard: day-of-week × hour-of-day heatmap (UTC).
function punchcardHtml(a) {
  if (!a || !a.total) return `<div class="empty">no commit history yet</div>`;
  const max = Math.max(...a.grid.flat(), 1);
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon…Sun
  const rows = order.map((d) => {
    const cells = a.grid[d].map((n, h) => {
      const alpha = n ? (0.14 + (n / max) * 0.86).toFixed(3) : 0;
      return `<div class="pc-cell" title="${DOW_LABEL[d]} ${String(h).padStart(2, "0")}:00 UTC · ${num(n)} commit${n !== 1 ? "s" : ""}"${n ? ` style="background:rgba(16,185,129,${alpha})"` : ""}></div>`;
    }).join("");
    return `<div class="pc-row"><div class="pc-day">${DOW_LABEL[d]}</div><div class="pc-cells">${cells}</div></div>`;
  }).join("");
  const axis = `<div class="pc-row pc-axis"><div class="pc-day"></div><div class="pc-cells">${
    Array.from({ length: 24 }, (_, h) => `<div class="pc-hour">${h % 6 === 0 ? h : ""}</div>`).join("")}</div></div>`;
  const peak = a.peak ? `${DOW_LABEL[a.peak.dow]} ${String(a.peak.hour).padStart(2, "0")}:00` : "—";
  return `<div class="punchcard">${rows}${axis}</div>
    <div class="mini-stats">
      <span class="ms">peak<b>${esc(peak)} UTC</b></span>
      <span class="ms">after-hours<b>${pct(a.afterHoursPct)}</b></span>
      <span class="ms">weekend<b>${pct(a.weekendPct)}</b></span>
      <span class="ms">commits<b>${num(a.total)}</b></span>
    </div>`;
}

// Segmented bar (used for review outcomes & issue resolution).
function segbarHtml(segments) {
  const total = segments.reduce((a, s) => a + s.n, 0);
  if (!total) return "";
  const bar = segments.filter((s) => s.n).map((s) =>
    `<div class="seg" title="${esc(s.label)}: ${num(s.n)}" style="width:${(s.n / total) * 100}%;background:${s.color}"></div>`).join("");
  const legend = segments.map((s) =>
    `<span class="seg-key"><i style="background:${s.color}"></i>${esc(s.label)} <b>${num(s.n)}</b></span>`).join("");
  return `<div class="segbar">${bar}</div><div class="seg-legend">${legend}</div>`;
}

function reviewHealthHtml(r) {
  if (!r || (!r.total && !r.mergedPRs)) return `<div class="empty">no review data yet</div>`;
  const bar = segbarHtml([
    { label: "approved", n: r.approved, color: GREEN },
    { label: "changes requested", n: r.changesRequested, color: AMBER },
    { label: "commented", n: r.commented, color: ACCENT },
    { label: "dismissed", n: r.dismissed, color: SLATE },
  ]) || `<div class="note">no reviews recorded</div>`;
  return `${bar}
    <div class="mini-stats">
      <span class="ms">review coverage<b>${pct(r.coverage)}</b></span>
      <span class="ms">reviews / merged PR<b>${r.reviewsPerMergedPR != null ? r.reviewsPerMergedPR.toFixed(2) : "—"}</b></span>
      <span class="ms">total reviews<b>${num(r.total)}</b></span>
    </div>
    <div class="note" style="margin-top:8px">Coverage = merged PRs with ≥1 human review. Light review volume here means most PRs merge without a recorded review.</div>`;
}

function issueInsightsHtml(r) {
  if (!r || (!r.open && !r.closed)) return `<div class="empty">no issues tracked</div>`;
  const resolution = segbarHtml([
    { label: "completed", n: r.completed, color: GREEN },
    { label: "not planned", n: r.notPlanned, color: SLATE },
  ]);
  const age = segbarHtml([
    { label: "< 1 week", n: r.aging.lt1w, color: GREEN },
    { label: "1–4 weeks", n: r.aging.w1to4, color: AMBER },
    { label: "> 1 month", n: r.aging.gt1mo, color: RED },
  ]) || `<div class="note">no open issues</div>`;
  return `
    <div class="sub-h">Resolution of closed issues</div>${resolution || `<div class="note">none closed yet</div>`}
    <div class="sub-h" style="margin-top:14px">Open backlog by age (${num(r.open)} open)</div>${age}
    <div class="mini-stats">
      <span class="ms">completion rate<b>${pct(r.completionRate)}</b></span>
      <span class="ms">median time to close<b>${fmtH(r.closeP50h)}</b></span>
      <span class="ms">median comments<b>${r.commentsP50 != null ? num(Math.round(r.commentsP50)) : "—"}</b></span>
    </div>`;
}

function workflowSummaryHtml(s) {
  return `<div class="mini-stats">
    <span class="ms">runs<b>${num(s.runs)}</b></span>
    <span class="ms">workflows<b>${num(s.workflows)}</b></span>
    <span class="ms">pass rate<b>${pct(s.passRate)}</b></span>
    <span class="ms">retried<b>${pct(s.retryRate)}</b></span>
    <span class="ms">median duration<b>${fmtMin(s.durationP50min)}</b></span>
  </div>`;
}

// Build the sortable per-workflow reliability table into `mount`.
function mountWorkflowTable(mount, data) {
  if (!data || !data.workflows.length) { mount.innerHTML = `<div class="empty">no workflow runs recorded</div>`; return; }
  mount.innerHTML = workflowSummaryHtml(data.summary);
  mount.appendChild(dataTable({
    columns: [
      { key: "name", label: "Workflow", type: "text", get: (w) => w.name.toLowerCase(), csv: (w) => w.name,
        render: (w) => `<span class="cell-primary">${esc(w.name)}</span>` },
      { key: "runs", label: "Runs", get: (w) => w.runs, render: (w) => num(w.runs) },
      { key: "pass", label: "Pass rate", get: (w) => w.passRate, csv: (w) => w.passRate ?? "",
        render: (w) => `<span class="${w.passRate != null && w.passRate < 0.8 ? "val-bad" : ""}">${pct(w.passRate)}</span>` },
      { key: "retry", label: "Retried", get: (w) => w.retryRate, csv: (w) => w.retryRate ?? "",
        render: (w) => `<span class="${w.retryRate > 0.05 ? "val-warn" : ""}">${pct(w.retryRate)}</span>` },
      { key: "dur", label: "Median time", get: (w) => w.durationP50min, csv: (w) => w.durationP50min ?? "",
        render: (w) => fmtMin(w.durationP50min) },
      { key: "last", label: "Last run", get: (w) => (w.lastRun ? Date.parse(w.lastRun) : null), csv: (w) => w.lastRun || "",
        render: (w) => relTime(w.lastRun) },
    ],
    rows: data.workflows,
    searchText: (w) => w.name,
    csvName: "workflows-" + new Date().toISOString().slice(0, 10),
    emptyText: "no workflows",
  }));
}

// Bus-factor chip: low bus factor / high concentration = delivery risk.
function busFactorChip(s) {
  if (s.busFactor == null) return `<span class="cell-dim">—</span>`;
  const share = s.topContribShare != null ? Math.round(s.topContribShare * 100) + "%" : "—";
  const cls = s.busFactor <= 1 ? "chip-bad" : s.busFactor <= 2 ? "chip-warn" : "chip-good";
  return `<span class="chip ${cls}" title="${num(s.busFactor)} contributor${s.busFactor !== 1 ? "s" : ""} account for ≥50% of commits · top contributor ${share}">${num(s.busFactor)} · ${share}</span>`;
}

// ==================================================================== router
let currentNavId = "overview";
const ROUTES = [
  { re: /^#?\/?$/,                                       fn: () => { currentNavId = "overview"; return overviewView(); } },
  { re: /^#\/team$/,                                     fn: () => { currentNavId = "team"; return teamView(); } },
  { re: /^#\/repo\/(\d+)$/,                              fn: (m) => { currentNavId = m[1]; return repoView(m[1]); } },
  { re: /^#\/repo\/(\d+)\/team$/,                        fn: (m) => { currentNavId = m[1]; return repoTeamView(m[1]); } },
  { re: /^#\/contributor\/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?:\?(.*))?$/,
    fn: (m) => { return contributorView(decodeURIComponent(m[1]), new URLSearchParams(m[2] || "")); } },
];
function route() {
  closeModal();
  const hash = location.hash || "#/";
  for (const r of ROUTES) {
    const m = hash.match(r.re);
    if (m) {
      r.fn(m).catch((e) => showError(e, route));
      return;
    }
  }
  location.hash = "#/"; // unknown → home
}

// ------------------------------------------------------- prefetch (load once)
// Warm the cache with every dashboard-level dataset up front so the app loads
// once, at the start, instead of fetching per view. The VISIBLE set (current
// range + WBR 6w/12m + team + status) fires immediately — the first paint reuses
// those exact promises, so it isn't slowed down. The remaining ranges warm in
// the background afterwards (one at a time, so background warming never
// competes with a visible view for the server's pool), so switching ranges
// is instant. Repo/contributor detail stays lazy: eagerly
// loading all 71 repos' detail would swamp the pool with no visible benefit.
function prefetchAll() {
  const primary = [
    api.status(),
    api.team(),
    api.overview(state.range),
    api.trends(state.range),
    api.trends("6w"),
    api.trends("12m"),
    api.activity(),       // org punchcard
    api.workflows(),      // org CI reliability
    api.reviews(),        // org review health
    api.issuesInsight(),  // org issue backlog
  ];
  Promise.allSettled(primary).then(async () => {
    for (const r of RANGES) {
      if (r === state.range) continue; // already warmed above
      await Promise.allSettled([api.overview(r), api.trends(r)]);
    }
  });
}

// ------------------------------------------------------------------- boot
function boot() {
  // sidebar toggling (mobile)
  $("#menu-btn").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#sidebar-overlay").hidden = false; });
  $("#sidebar-overlay").addEventListener("click", closeSidebar);
  document.querySelectorAll('#nav > a.nav-item').forEach((a) => a.addEventListener("click", closeSidebar));

  // global range switcher (dropdown: 1 day / 1 week / 6 weeks / 12 months / all)
  const rangeSelect = $("#range-select");
  if (rangeSelect) {
    rangeSelect.value = state.range;
    rangeSelect.addEventListener("change", () => {
      if (!RANGES.includes(rangeSelect.value)) return;
      state.range = rangeSelect.value;
      localStorage.setItem("dm.range", state.range);
      route(); // re-render current view with the new range
    });
  }

  // AI: report modal + ask drawer
  $("#ai-report-btn").addEventListener("click", openReportModal);
  $("#ai-ask-btn").addEventListener("click", () =>
    ($("#ask-drawer").hidden ? openAskDrawer() : closeAskDrawer()));
  $("#ask-close").addEventListener("click", closeAskDrawer);
  $("#ask-clear").addEventListener("click", () => {
    if (ask.busy) return;
    ask.history = [];
    $("#ask-msgs").innerHTML = askIntroHtml();
  });
  $("#ask-msgs").innerHTML = askIntroHtml();
  $("#ask-msgs").addEventListener("click", (e) => {
    const chip = e.target.closest(".ask-chip");
    if (chip && !ask.busy) sendAsk(chip.dataset.q);
  });
  $("#ask-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#ask-input");
    const q = input.value.trim();
    if (!q || ask.busy) return;
    input.value = "";
    sendAsk(q);
  });
  $("#ask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#ask-form").requestSubmit(); }
  });

  window.addEventListener("hashchange", route);
  prefetchAll(); // kick off all dashboard-level fetches at once
  refreshSidebar();
  route();
}
boot();
