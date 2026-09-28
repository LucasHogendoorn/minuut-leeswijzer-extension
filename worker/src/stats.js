// Anonymous daily counters: how many installs are active, how many rulings are
// judged, how often the cache helps, how often Jev or the rate limits refuse.
//
// What a counter is: a fixed name ("judge:core", "lookup:hit", "ping:1.1.0")
// and a number per calendar day (Europe/Amsterdam). Nothing else is kept: no
// question, no ruling text, no ECLI, no URL, no IP or hash of one, no install
// or random ID. A counter cannot say who did something or what they read.
// (To count "active" once per network per day, a separate ping object keeps
// two numbers until the end of that day under a salted hash of the day and
// the network; see PING in src/index.js. The counters here never see it.)
//
// Cost on the Workers Free plan (checked 2026-09 against
// https://developers.cloudflare.com/durable-objects/platform/pricing/):
// Durable Objects get 100,000 requests/day ("HTTP requests, RPC sessions,
// WebSocket messages, and alarm invocations"; every RPC method call on a stub
// is one request) and, for SQLite storage, 100,000 rows written and 5 million
// rows read per day, 5 GB stored; each setAlarm() is billed as one row written.
// Workers KV allows only 1,000 writes/day, so counters stay out of KV.
//   - No Durable Object request per judge call: a Worker isolate collects
//     counts in memory (`count`) and hands them over to the global Limiter at
//     most once per 10 s (REPORT_MS in src/index.js, Limiter.report), together
//     with its number of Jev calls for the global limit. So what happens in an
//     isolate reaches the counters within ~10 s, on its next request.
//   - The global Limiter writes them to its storage, batched: when counts
//     arrive and the last write is FLUSH_MS or longer ago it writes at once,
//     otherwise an alarm writes them FLUSH_MS after the last write. One write
//     is one row per day touched. The window is short on purpose: counts wait
//     in memory, and an idle Durable Object is evicted after 70-140 s in
//     production (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
//     but after about 10 s in local `wrangler dev` (measured). With one busy
//     isolate reports come 10 s apart and are written at once, without an
//     alarm. Worst case, many isolates reporting nonstop: 8,640 writes + 8,640
//     setAlarm rows = ~17,000 rows written/day (of 100,000) and 8,640 alarm
//     invocations/day (of 100,000 requests).
//   - One row per day, kept for 90 days.
// Known undercount, accepted for basic observability: counts still held by a
// Worker isolate that is then shut down without another request are lost.

const TIME_ZONE = "Europe/Amsterdam";
const FLUSH_MS = 10_000; // at most one storage write per 10 s
const KEEP_DAYS = 90;
const MAX_KEYS_PER_DAY = 200; // bounds a day row if someone sends junk versions
const KEY = /^[a-z_]{1,16}:[a-z0-9_.]{1,24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROW = "day:"; // storage key prefix: "day:2026-09-28"

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
export const today = (date = new Date()) => dayFormat.format(date); // "2026-09-28"
// The calendar day `n` days before `day`, by date arithmetic (DST-proof).
const daysBefore = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

// ---- In the Worker isolate ------------------------------------------------------------

let pending = {}; // day -> { counter -> n }

export function count(key, n = 1) {
  if (!KEY.test(key)) return;
  const day = (pending[today()] ??= {});
  day[key] = (day[key] ?? 0) + n;
}

// Hands over what this isolate counted so far (or undefined when nothing).
export function drain() {
  if (!Object.keys(pending).length) return undefined;
  const out = pending;
  pending = {};
  return out;
}

// Puts back counts that could not be handed over (the report failed).
export function restore(deltas) {
  for (const [day, counts] of Object.entries(deltas ?? {})) {
    const row = (pending[day] ??= {});
    for (const [key, n] of Object.entries(counts)) row[key] = (row[key] ?? 0) + n;
  }
}

// Only a real release version is kept ("1.1.0", "1.12.3"); anything else,
// including development builds and junk, counts as "other" (review 1, finding 8).
export const versionLabel = (v) => (typeof v === "string" && /^1\.\d{1,2}\.\d{1,2}$/.test(v) ? v : "other");

// ---- In the global Limiter Durable Object -----------------------------------------------

export class DailyCounters {
  constructor(ctx) {
    this.ctx = ctx;
    this.mem = {}; // day -> { counter -> n }, not yet written
    this.lastWrite = 0;
    this.alarmSet = false;
    this.prunedOn = "";
  }

  // Adds counts handed over by a Worker. Malformed input is ignored.
  add(deltas) {
    if (!deltas || typeof deltas !== "object") return;
    let added = false;
    for (const [day, counts] of Object.entries(deltas)) {
      if (!DAY.test(day) || !counts || typeof counts !== "object") continue;
      for (const [key, n] of Object.entries(counts)) {
        if (!KEY.test(key) || !Number.isInteger(n) || n < 1 || n > 1_000_000) continue;
        const row = (this.mem[day] ??= {});
        row[key] = (row[key] ?? 0) + n;
        added = true;
      }
    }
    if (!added) return;
    // Quiet: write now. Busy: batch until FLUSH_MS after the last write.
    if (Date.now() - this.lastWrite >= FLUSH_MS) this.flush();
    else if (!this.alarmSet) {
      this.alarmSet = true;
      this.ctx.storage.setAlarm(this.lastWrite + FLUSH_MS).catch(() => (this.alarmSet = false));
    }
  }

  // Writes the counts in memory to storage: one row per day.
  flush() {
    this.alarmSet = false;
    if (!Object.keys(this.mem).length) return;
    const kv = this.ctx.storage.kv;
    for (const [day, counts] of Object.entries(this.mem)) {
      const row = kv.get(ROW + day) ?? {};
      for (const [key, n] of Object.entries(counts)) {
        const k = Object.hasOwn(row, key) || Object.keys(row).length < MAX_KEYS_PER_DAY ? key : "other:overflow";
        row[k] = (row[k] ?? 0) + n;
      }
      kv.put(ROW + day, row);
    }
    this.mem = {};
    this.lastWrite = Date.now();
    // Drop rows older than KEEP_DAYS, once a day per instance.
    const now = today();
    if (this.prunedOn !== now) {
      this.prunedOn = now;
      const old = [...kv.list({ prefix: ROW, end: ROW + daysBefore(now, KEEP_DAYS) })].map(([key]) => key);
      for (const key of old) kv.delete(key);
    }
  }

  // The last `days` days, newest first, including counts not yet written.
  read(days) {
    const kv = this.ctx.storage.kv;
    const now = today();
    const out = [];
    for (let i = 0; i < days; i++) {
      const day = daysBefore(now, i);
      const row = { ...(kv.get(ROW + day) ?? {}) };
      for (const [key, n] of Object.entries(this.mem[day] ?? {})) row[key] = (row[key] ?? 0) + n;
      out.push({ date: day, counters: row });
    }
    return out;
  }
}

// ---- Reading: GET /v1/stats?days=N with the secret token ---------------------------------

async function sameToken(given, expected) {
  // Constant time: compare fixed-length digests, never the strings themselves.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// Returns a Response, or null when the endpoint is switched off (no secret, or
// a secret shorter than 32 characters: use e.g. `openssl rand -hex 32`).
export async function statsResponse(request, env, url, stub) {
  if (!env.STATS_TOKEN || env.STATS_TOKEN.length < 32) return null;
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (request.method !== "GET") return new Response(JSON.stringify({ message: "Alleen GET." }), { status: 405, headers });
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !(await sameToken(token, env.STATS_TOKEN))) {
    return new Response(JSON.stringify({ message: "Niet toegestaan." }), { status: 401, headers: { ...headers, "WWW-Authenticate": "Bearer" } });
  }
  const days = Math.min(KEEP_DAYS, Math.max(1, Number.parseInt(url.searchParams.get("days") ?? "30", 10) || 30));
  const rows = await stub.stats(days, drain());
  return new Response(JSON.stringify({ timeZone: TIME_ZONE, days: rows }), { status: 200, headers });
}
