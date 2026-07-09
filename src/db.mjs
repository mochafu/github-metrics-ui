import "dotenv/config"
import pg from "pg"

// Read-only-ish connection to the SAME Postgres the collector writes to.
// The dashboard only needs DATABASE_URL — never the GitHub App key.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required (copy it from the collector's .env)")
}

// max 10 — NOT more. DATABASE_URL points at Supabase's SESSION-mode pooler
// (port 5432), where every client connection pins a pooler slot for its whole
// lifetime and the slot budget is shared with the collector. At max 20 +
// 12 warmed + 2-min idle hold, a page-load burst asked for more slots than
// the pooler had free: the extra connection opens were rejected fast, pg
// surfaced them as query errors, and endpoints 500'd ("internal server
// error") while a refresh mid-burst hung the sidebar. Excess queries queueing
// on 10 connections costs only ~1s on a cold burst; rejected opens cost 500s.
// (The clean fix is the transaction-mode pooler on port 6543 — see README.)
export const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000, // release shared session slots quickly; the collector needs them too
  connectionTimeoutMillis: 10_000, // burst queries queue behind 10 conns; give them headroom
})

db.on("error", (e) => console.error("pg pool error:", e.message))

// Open a few connections BEFORE the first request needs them (~300ms each on
// the pooler). Kept small on purpose: warming must stay well under both `max`
// and the shared session-pooler slot budget, or warmup itself steals slots.
export function warmPool(n = 4) {
  return Promise.allSettled(
    Array.from({ length: n }, () => db.query("select 1"))
  )
}

export async function rows(sql, params = []) {
  return (await db.query(sql, params)).rows
}
export async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0]
}
