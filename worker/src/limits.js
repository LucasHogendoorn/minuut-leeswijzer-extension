// Rate limiting and request hygiene that runs inside the Worker isolate, before
// any Durable Object is asked. Pure functions and small classes without
// Cloudflare imports, so worker/test/ can test them with plain Node.
//
// Why this exists: on the Workers Free plan Durable Objects get 100,000
// requests a day (every RPC call on a stub is one), and a DO failure took the
// whole API down (security review 1, finding 1). So a request only reaches a
// Durable Object after the cheap checks here have passed, and a client the
// Durable Object has just refused is answered from memory until its
// Retry-After is over.

// ---- Client keys -------------------------------------------------------------------------
// A client is an IPv4 address or an IPv6 network: one household or office gets a
// whole /64 (often a /56 or /48), so keying on the full IPv6 address would give
// one machine 2^64 identities (review 1, finding 3). The key is hashed with a
// secret salt (RL_SALT) before it names a Durable Object; the address itself is
// never stored.

// The 8 hextets of an IPv6 address as numbers, or null when it is not one.
// Handles "::" and an embedded dotted IPv4 tail ("::ffff:192.0.2.1").
export function parseIPv6(text) {
  let s = String(text).trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":") || !/^[0-9a-f:.]+$/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h) => (h === "" ? [] : h.split(":"));
  const toWords = (groups, allowTail) => {
    const out = [];
    for (const [i, g] of groups.entries()) {
      if (allowTail && i === groups.length - 1 && g.includes(".")) {
        const v4 = parseIPv4(g);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(g)) out.push(parseInt(g, 16));
      else return null;
    }
    return out;
  };
  if (halves.length === 1) {
    const words = toWords(part(halves[0]), true);
    return words && words.length === 8 ? words : null;
  }
  const head = toWords(part(halves[0]), false);
  const tail = toWords(part(halves[1]), true);
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
}

export function parseIPv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text).trim());
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((n) => n <= 255) && m.slice(1).every((p) => p === "0" || !p.startsWith("0")) ? b : null;
}

// The network a request comes from, as a canonical string: "4:a.b.c.d" for
// IPv4 (also when written as an IPv4-mapped IPv6 address, ::ffff:a.b.c.d), or
// "6:" plus the first `prefix` bits (a multiple of 16) of an IPv6 address.
// Anything unparseable is its own key, so it can never merge unrelated clients.
export function clientNet(ip, prefix = 64) {
  const v4 = parseIPv4(ip ?? "");
  if (v4) return `4:${v4.join(".")}`;
  const w = parseIPv6(ip ?? "");
  if (!w) return `x:${String(ip ?? "").slice(0, 64)}`;
  // ::ffff:0:0/96 is IPv4-mapped: the client is that IPv4 address.
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return `4:${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
  return `6:${w.slice(0, prefix / 16).map((x) => x.toString(16)).join(":")}`;
}

export async function hashKey(text, salt) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${text}`));
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Bounded maps ------------------------------------------------------------------------
// Isolate memory is 128 MB; a flood of fresh keys must not grow a map without
// bound. Oldest-first eviction (a Map iterates in insertion order).

function bound(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

// ---- Negative cache ------------------------------------------------------------------------
// Client keys the Durable Object refused, with the moment they may try again.
// While a key is in here it gets a 429 straight from memory: a refused flood
// costs no Durable Object requests at all.
export class RefusedClients {
  constructor(max = 10_000) {
    this.max = max;
    this.until = new Map(); // key -> ms timestamp
  }
  // Seconds left for `key`, or 0 when it may go on.
  check(key, now = Date.now()) {
    const until = this.until.get(key);
    if (until === undefined) return 0;
    if (until <= now) {
      this.until.delete(key);
      return 0;
    }
    return Math.ceil((until - now) / 1000);
  }
  refuse(key, seconds, now = Date.now()) {
    this.until.delete(key);
    this.until.set(key, now + seconds * 1000);
    bound(this.until, this.max);
  }
  get size() {
    return this.until.size;
  }
}

// ---- Token bucket per client key, per isolate ----------------------------------------------
// Approximate (each isolate has its own), so it only ever refuses what the exact
// Durable Object limit would refuse too: capacity and refill equal the Durable
// Object's per-client limits for judge calls. Its job is to stop a flood inside
// one isolate before it reaches a Durable Object.
export class TokenBuckets {
  constructor({ capacity, perSecond, max = 10_000 }) {
    Object.assign(this, { capacity, perSecond, max });
    this.buckets = new Map(); // key -> { tokens, at }
  }
  // 0 when `weight` tokens were taken, otherwise the seconds until they would be there.
  take(key, weight = 1, now = Date.now()) {
    let b = this.buckets.get(key);
    if (b) {
      this.buckets.delete(key); // re-insert: most recently used last
      b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.perSecond);
      b.at = now;
    } else b = { tokens: this.capacity, at: now };
    this.buckets.set(key, b);
    bound(this.buckets, this.max);
    if (weight > this.capacity) return Math.ceil(this.capacity / this.perSecond);
    if (b.tokens >= weight) {
      b.tokens -= weight;
      return 0;
    }
    return Math.max(1, Math.ceil((weight - b.tokens) / this.perSecond));
  }
}

// ---- Leases: fewer Durable Object calls for a burst of judge calls -------------------------
// When the Durable Object allows a judge call it may grant a few extra tokens
// (a lease) that this isolate spends on the same client's next calls without
// asking again. The Durable Object counts leased tokens as used the moment it
// grants them, so the per-client limit stays a hard cap: a client can never make
// more calls than the Durable Object counted. A lease lasts LEASE_MS, shorter
// than the shortest window (10 s), so a leased token is always spent inside the
// window that counted it. The lease asked for is the number of calls this client
// made in this isolate in the last LEASE_MS (at most LEASE_MAX): a single call
// asks for none, a running ruling (5 calls in flight) for a handful; what is
// left unused when the ruling ends is at most that handful. Only one lease
// request per client key is in flight at a time (`asking`): parallel calls
// that each asked for a lease would be charged for all of them.
export const LEASE_MS = 5_000;
export const LEASE_MAX = 16;

export class Leases {
  constructor(max = 10_000) {
    this.max = max;
    this.leases = new Map(); // key -> { tokens, until }
    this.recent = new Map(); // key -> ms timestamps of recent calls
    this.asking = new Set(); // keys with a lease request in flight
  }
  // Records a call and returns true when a leased token paid for it.
  spend(key, now = Date.now()) {
    const times = (this.recent.get(key) ?? []).filter((t) => t > now - LEASE_MS);
    times.push(now);
    this.recent.delete(key);
    this.recent.set(key, times.slice(-(LEASE_MAX + 1)));
    bound(this.recent, this.max);
    const lease = this.leases.get(key);
    if (!lease || lease.until <= now || lease.tokens < 1) {
      this.leases.delete(key);
      return false;
    }
    lease.tokens--;
    return true;
  }
  // How many extra tokens to ask the Durable Object for with this call; 0 while
  // another call for this key is already asking. A non-zero answer must be
  // followed by grant() (also with 0) to end the request.
  want(key, now = Date.now()) {
    if (this.asking.has(key)) return 0;
    const times = this.recent.get(key) ?? [];
    const n = Math.min(LEASE_MAX, Math.max(0, times.filter((t) => t > now - LEASE_MS).length - 1));
    if (n) {
      this.asking.add(key);
      bound(this.asking, this.max);
    }
    return n;
  }
  grant(key, tokens, asked = true, now = Date.now()) {
    if (asked) this.asking.delete(key);
    if (tokens < 1) return;
    this.leases.delete(key);
    this.leases.set(key, { tokens, until: now + LEASE_MS });
    bound(this.leases, this.max);
  }
  drop(key) {
    this.asking.delete(key);
    this.leases.delete(key);
  }
}

// ---- Exact sliding windows (inside the per-client Durable Object) --------------------------
// Buckets per second; `windows` is [{ limit, ms }]. A window of `span` seconds
// counts the buckets of the current second and the `span` seconds before it
// (span + 1 buckets), so a token taken at x.999 s is still counted a full
// `span` seconds later: the caps hold in wall-clock time, never ~2x within
// span - 1 s. Buckets are pruned only once they are outside every window.
// Returns how many tokens were
// granted (0 = refused) and, when refused, the seconds until `weight` would fit.
// `extra` tokens (a lease) are granted only as far as every window has room.
export class Windows {
  buckets = new Map(); // second -> count

  take(windows, weight = 1, extra = 0, nowMs = Date.now()) {
    const now = Math.floor(nowMs / 1000);
    const horizon = Math.max(...windows.map((w) => w.ms)) / 1000;
    for (const sec of this.buckets.keys()) if (sec < now - horizon) this.buckets.delete(sec);
    let room = Infinity;
    let retryAfter = 0;
    for (const w of windows) {
      const span = w.ms / 1000;
      let n = 0;
      for (const [sec, c] of this.buckets) if (sec >= now - span) n += c;
      room = Math.min(room, w.limit - n);
      if (n + weight > w.limit) {
        // Oldest buckets first: when has enough of this window expired?
        let freed = 0;
        let at = span + 1;
        for (const sec of [...this.buckets.keys()].filter((s) => s >= now - span).sort((a, b) => a - b)) {
          freed += this.buckets.get(sec);
          if (n - freed + weight <= w.limit) {
            at = sec + span + 1 - now; // the second in which `sec` leaves the window
            break;
          }
        }
        retryAfter = Math.max(retryAfter, Math.max(1, at));
      }
    }
    if (retryAfter) return { granted: 0, retryAfter };
    const granted = weight + Math.max(0, Math.min(extra, room - weight));
    this.buckets.set(now, (this.buckets.get(now) ?? 0) + granted);
    return { granted, retryAfter: 0 };
  }
}

// ---- Request bodies ------------------------------------------------------------------------
// A declared Content-Length above `max` is refused at once (413). The body is
// then read as a stream with a byte counter that stops at `max`, so a missing
// or understated Content-Length cannot make the Worker buffer more than that
// (review 1, finding 5). A missing Content-Length is accepted: the stream cap
// already bounds memory, and whether Cloudflare's edge always passes the
// header on for HTTP/2 and HTTP/3 requests is not verified. A malformed one is
// refused (400).
// Returns { text } or { status } (400 or 413).
export async function readLimited(request, max) {
  const header = request.headers.get("Content-Length");
  if (header !== null) {
    if (!/^\d{1,12}$/.test(header.trim())) return { status: 400 };
    if (Number(header) > max) return { status: 413 };
  }
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return { status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { text: new TextDecoder().decode(bytes) };
}
