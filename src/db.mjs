import "dotenv/config"
import pg from "pg"

// Read-only-ish connection to the SAME Postgres the collector writes to.
// The dashboard only needs DATABASE_URL — never the GitHub App key.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required (copy it from the collector's .env)")
}

export const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

db.on("error", (e) => console.error("pg pool error:", e.message))

export async function rows(sql, params = []) {
  return (await db.query(sql, params)).rows
}
export async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0]
}
