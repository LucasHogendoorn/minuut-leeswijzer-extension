// The Worker's fetch handler end to end, with in-memory stand-ins for the
// Durable Object namespace, D1 and the gateway. Run from worker/:
//   node --import ./test/register.mjs --test test/
import test from "node:test";
import assert from "node:assert/strict";
import worker, { Limiter } from "../src/index.js";
import { encodeAnswers, readAnswers, storable, validAnswers } from "../src/cache.js";
import { versionLabel } from "../src/stats.js";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const HOST = "https://leeswijzer-api.minuut.eu";

// ---- stand-ins -----------------------------------------------------------------------------

function fakeStorage() {
  const map = new Map();
  return {
    kv: {
      get: (k) => map.get(k),
      put: (k, v) => map.set(k, structuredClone(v)),
      delete: (k) => map.delete(k),
      *list({ prefix = "", end } = {}) {
        for (const [k, v] of [...map].sort()) if (k.startsWith(prefix) && (end === undefined || k < end)) yield [k, v];
      },
    },
    alarm: null,
    async setAlarm(t) {
      this.alarm = t;
    },
    async deleteAll() {
      map.clear();
      this.alarm = null;
    },
    get size() {
      return map.size;
    },
  };
}

// Every RPC is recorded in `calls` as "name.method"; `failing` makes them throw.
function namespace() {
  const objects = new Map();
  const ns = {
    objects,
    calls: [],
    args: [],
    failing: false, // true: every RPC throws; a number n: the next n RPCs throw
    failError: () => new Error("Durable Object unavailable"),
    idFromName: (name) => name,
    get(name) {
      return new Proxy(
        {},
        {
          get: (_, method) => async (...args) => {
            ns.calls.push(`${name.split(":")[0]}.${String(method)}`);
            ns.args.push({ name, method: String(method), args });
            if (ns.failing === true || ns.failing > 0) {
              if (typeof ns.failing === "number") ns.failing--;
              throw ns.failError();
            }
            if (!objects.has(name)) objects.set(name, new Limiter({ storage: fakeStorage() }, {}));
            return structuredClone(await objects.get(name)[method](...args));
          },
        },
      );
    },
  };
  return ns;
}

const hex = (k) => [...k].map((b) => b.toString(16).padStart(2, "0")).join("");
function fakeD1() {
  const rows = new Map(); // `${tpl}|${hex(k)}` -> v
  const db = {
    rows,
    writes: [],
    prepare(sql) {
      const st = {
        sql,
        args: [],
        bind(...a) {
          st.args = a;
          return st;
        },
        async all() {
          const [tpl, ...keys] = st.args;
          const results = [];
          keys.forEach((k, i) => {
            const v = rows.get(`${tpl}|${hex(k)}`);
            if (v) results.push({ i, v: [...v] });
          });
          return { results };
        },
        async run() {
          if (sql.startsWith("INSERT INTO answers")) {
            const [tpl, k, v] = st.args;
            const id = `${tpl}|${hex(k)}`;
            db.writes.push(sql.includes("DO UPDATE") ? "replace" : "insert");
            if (!rows.has(id) || sql.includes("DO UPDATE")) rows.set(id, v);
          }
          return {};
        },
      };
      return st;
    },
    async batch(statements) {
      return Promise.all(statements.map((s) => (s.sql.startsWith("SELECT") ? s.all() : s.run())));
    },
  };
  return db;
}

let gatewayAnswer = null; // function(questions) -> answers
let gatewayCalls = 0;
let gatewayMs = 0;
globalThis.fetch = async (url, init) => {
  gatewayCalls++;
  if (gatewayMs) await new Promise((r) => setTimeout(r, gatewayMs * (0.8 + Math.random() * 0.4)));
  const { questions } = JSON.parse(init.body);
  return new Response(JSON.stringify({ answers: gatewayAnswer(questions) }), { status: 200, headers: { "Content-Type": "application/json" } });
};
const goodAnswer = (questions) =>
  Object.fromEntries(
    Object.entries(questions).map(([k, q]) => {
      if (q.type === "boolean") return [k, { type: "boolean", probability: 0.8 }];
      const keys = Object.keys(q.criteria);
      return [k, { type: "choice", choice: keys[0], probabilities: Object.fromEntries(keys.map((c, i) => [c, i === 0 ? 0.9 : 0])), confidence: 0.9 }];
    }),
  );
gatewayAnswer = goodAnswer;

function makeEnv() {
  return { LIMITER: namespace(), DB: fakeD1(), RL_SALT: "test-salt-0123456789", ALLOWED_ORIGINS: "", DEV_GATEWAY_URL: "http://127.0.0.1:9/v1/evaluate", AI_GATEWAY_API_KEY: "x" };
}
function makeCtx() {
  const waits = [];
  return { waitUntil: (p) => waits.push(p), settle: () => Promise.all(waits.splice(0)) };
}

let ipCounter = 1;
const freshIp = () => `198.51.100.${ipCounter++}`;

function post(path, body, { ip = "203.0.113.1", host = HOST, headers = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${host}${path}`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip, "Content-Length": String(new TextEncoder().encode(text).length), ...headers },
    body: text,
  });
}
const CORE = (n = 0) => ({ kind: "core", question: "", state: `Rechtsoverweging ${n}: de rechter oordeelt dat de vordering wordt afgewezen.`, court: "de Hoge Raad" });

// ---- tests -----------------------------------------------------------------------------------

test("junk is refused before any Durable Object call", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const cases = [
    [new Request(`${HOST}/nope`, { method: "POST" }), 404],
    [new Request(`${HOST}/v1/judge`, { method: "GET", headers: { Origin: ORIGIN } }), 405],
    [new Request(`${HOST}/v1/judge`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" }), 403],
    [new Request(`${HOST}/v1/judge`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "text/plain" }, body: "{}" }), 415],
    [new Request(`${HOST}/v1/judge`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" }), 400], // no Content-Length: read, then refused as invalid
    [post("/v1/judge", "{}", { headers: { "Content-Length": "12x" } }), 400],
    [post("/v1/judge", "{}", { headers: { "Content-Length": "999999" } }), 413],
    [post("/v1/judge", "not json"), 400],
    [post("/v1/judge", { kind: "nope", state: "x" }), 400],
    [post("/v1/ping", '{"v":"1.1.0","event":"other"}'), 400],
    [new Request(`${HOST}/v1/ping`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "x".repeat(300) }), 413],
    [post("/v1/lookup", { kind: "core", items: [] }), 400],
    [new Request(`${HOST}/health`), 200],
    [new Request(`${HOST}/v1/stats`), 404], // no STATS_TOKEN
  ];
  for (const [request, status] of cases) {
    const res = await worker.fetch(request, env, ctx);
    assert.equal(res.status, status, `${request.method} ${request.url}`);
  }
  assert.deepEqual(env.LIMITER.calls, []);
});

test("413 when the streamed body exceeds the limit despite a small Content-Length", async () => {
  const env = makeEnv();
  const big = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(16_384).fill(32));
    },
  });
  const request = new Request(`${HOST}/v1/judge`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "Content-Length": "100", "CF-Connecting-IP": freshIp() },
    body: big,
    duplex: "half",
  });
  const res = await worker.fetch(request, env, makeCtx());
  assert.equal(res.status, 413);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  // Without any Content-Length the same cap applies.
  const noLength = new Request(`${HOST}/v1/judge`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": freshIp() },
    body: new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(16_384).fill(32));
      },
    }),
    duplex: "half",
  });
  assert.equal((await worker.fetch(noLength, env, makeCtx())).status, 413);
  assert.deepEqual(env.LIMITER.calls, []);
});

test("a POST without Content-Length (as HTTP/2 may arrive) is served", async () => {
  const env = makeEnv();
  const body = JSON.stringify(CORE(31337));
  const request = new Request(`${HOST}/v1/judge`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": freshIp() }, body });
  assert.equal(request.headers.get("Content-Length"), null);
  const res = await worker.fetch(request, env, makeCtx());
  assert.equal(res.status, 200);
});

test("a judge call costs one client Durable Object request, no global one; a burst leases", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = freshIp();
  const res = await worker.fetch(post("/v1/judge", CORE(1), { ip }), env, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(env.LIMITER.calls.filter((c) => c !== "global.report"), ["c.take"]);
  // A running ruling: calls in parallel, as the extension's pool of five sends them.
  env.LIMITER.calls.length = 0;
  for (let i = 0; i < 20; i += 5) {
    const batch = await Promise.all([0, 1, 2, 3, 4].map((j) => worker.fetch(post("/v1/judge", CORE(100 + i + j), { ip }), env, ctx)));
    assert.ok(batch.every((r) => r.status === 200));
  }
  const takes = env.LIMITER.calls.filter((c) => c === "c.take").length;
  assert.ok(takes < 20, `20 calls took ${takes} client Durable Object requests`);
  await ctx.settle();
});

test("limiter order: a refused client never touches the global object, then waits in memory", async () => {
  // A fresh module instance: a fresh isolate, whose first report is due.
  const worker = (await import("../src/index.js?isolate=order")).default;
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = freshIp();
  let refusedAt = -1;
  // Sequential calls (these also take leases; the Durable Object counts leased
  // tokens, so the cap is exact either way).
  for (let i = 0; i < 520; i++) {
    const res = await worker.fetch(post("/v1/judge", CORE(1000 + i), { ip }), env, ctx);
    if (res.status === 429) {
      refusedAt = i;
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
      assert.ok(Number(res.headers.get("Retry-After")) >= 1);
      assert.equal((await res.json()).error_type, "rate_limited");
      break;
    }
  }
  assert.equal(refusedAt, 500, "the 501st call in 10 s is refused");
  // Every Durable Object request so far went to this client's object or the
  // periodic report: none per call to the global object.
  assert.deepEqual([...new Set(env.LIMITER.calls)].sort(), ["c.take", "global.report"]);
  assert.equal(env.LIMITER.calls.filter((c) => c === "global.report").length, 1, "one report per 10 s per isolate");
  const before = env.LIMITER.calls.length;
  for (let i = 0; i < 200; i++) assert.equal((await worker.fetch(post("/v1/judge", CORE(5000 + i), { ip }), env, ctx)).status, 429);
  assert.equal(env.LIMITER.calls.length, before, "refused flood: no Durable Object requests");
  await ctx.settle();
});

test("the token bucket stops a flood before the Durable Object", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = freshIp();
  // Parallel flood: leases would let many through without a DO call; the
  // bucket (500 at once) caps what one isolate lets through at all.
  const results = await Promise.all(Array.from({ length: 700 }, (_, i) => worker.fetch(post("/v1/judge", CORE(9000 + i), { ip }), env, ctx)));
  const ok = results.filter((r) => r.status === 200).length;
  assert.equal(ok, 500);
  assert.ok(env.LIMITER.calls.filter((c) => c === "c.take").length <= 500);
  await ctx.settle();
});

test("a Durable Object failure is a clean 503 with CORS and Retry-After", async () => {
  const env = makeEnv();
  env.LIMITER.failing = true;
  for (const [path, body] of [
    ["/v1/judge", CORE(1)],
    ["/v1/lookup", { kind: "core", court: "de Hoge Raad", items: [{ state: CORE(1).state }] }],
    ["/v1/ping", { v: "1.1.0", event: "active" }],
  ]) {
    const res = await worker.fetch(post(path, body, { ip: freshIp() }), env, makeCtx());
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.equal(res.headers.get("Retry-After"), "30");
    assert.equal((await res.json()).error_type, "unavailable");
  }
});

test("IPv6 clients in one /64 share one limit", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  let status = 200;
  for (let i = 0; i < 501 && status === 200; i++) {
    status = (await worker.fetch(post("/v1/judge", CORE(20_000 + i), { ip: `2001:db8:77:1:${i.toString(16)}::1` }), env, ctx)).status;
  }
  assert.equal(status, 429);
  assert.equal((await worker.fetch(post("/v1/judge", CORE(1), { ip: "2001:db8:77:2::1" }), env, ctx)).status, 200);
  await ctx.settle();
});

test("sentences: short header state, total characters capped", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = freshIp();
  const call = (body) => worker.fetch(post("/v1/judge", body, { ip }), env, ctx);
  const header = "De zinnen hieronder komen uit rechtsoverweging 3.1 van ECLI:NL:HR:1981:AG4158.";
  const ok = await call({ kind: "sentences", question: "", state: header, sentences: ["Eerste zin van de overweging.", "Tweede zin van de overweging."] });
  assert.equal(ok.status, 200);
  // The whole r.o. smuggled into `state` of a sentences call is refused.
  const long = await call({ kind: "sentences", question: "", state: "x".repeat(1_001), sentences: ["Eerste zin.", "Tweede zin."] });
  assert.equal(long.status, 400);
  // 40 sentences of 1,500 characters (60,000) exceed the 24,000 total.
  const many = await call({ kind: "sentences", question: "", state: header, sentences: Array.from({ length: 40 }, (_, i) => `${i} ${"y".repeat(1_490)}`) });
  assert.equal(many.status, 400);
  // What the extension sends at most (20,000) passes.
  const max = await call({ kind: "sentences", question: "", state: header, sentences: Array.from({ length: 20 }, (_, i) => `${i} ${"z".repeat(990)}`.slice(0, 1_000)) });
  assert.equal(max.status, 200);
  await ctx.settle();
});

test("answers: only the expected shape is stored; invalid rows read as a miss and are replaced", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = freshIp();
  const body = CORE(424242);
  // Jev answers with an extra key: returned to the client, never stored.
  gatewayAnswer = (q) => ({ ...goodAnswer(q), extra: { type: "boolean", probability: 1 } });
  assert.equal((await worker.fetch(post("/v1/judge", body, { ip }), env, ctx)).status, 200);
  await ctx.settle();
  assert.equal(env.DB.rows.size, 0);
  // A good answer is stored once.
  gatewayAnswer = goodAnswer;
  await worker.fetch(post("/v1/judge", body, { ip }), env, ctx);
  await ctx.settle();
  assert.equal(env.DB.rows.size, 1);
  const calls = gatewayCalls;
  const hit = await worker.fetch(post("/v1/judge", body, { ip }), env, ctx);
  assert.equal(hit.status, 200);
  assert.equal(gatewayCalls, calls, "served from the cache");
  // Corrupt the row (a probability out of range): a miss, and the next answer replaces it.
  const [id] = env.DB.rows.keys();
  const bad = goodAnswer({ eigen: { type: "boolean" }, dragend: { type: "boolean" }, inhoud: { type: "boolean" }, rol: { type: "choice", criteria: { toepassing: 1 } } });
  bad.eigen.probability = 7;
  env.DB.rows.set(id, encodeAnswers(bad));
  await worker.fetch(post("/v1/judge", body, { ip }), env, ctx);
  await ctx.settle();
  assert.equal(gatewayCalls, calls + 1, "invalid row: asked Jev again");
  assert.equal(env.DB.writes.at(-1), "replace");
  // Lookup reads validate too.
  env.DB.rows.set(id, encodeAnswers(bad));
  const lk = await worker.fetch(post("/v1/lookup", { kind: "core", court: "de Hoge Raad", items: [{ state: body.state }] }, { ip }), env, ctx);
  assert.deepEqual((await lk.json()).answers, [null]);
  await ctx.settle();
});

test("answer shape validation", () => {
  const q = {
    eigen: { type: "boolean", criteria: {} },
    rol: { type: "choice", criteria: { kader: "", toepassing: "" } },
  };
  const good = { eigen: { type: "boolean", probability: 0.4 }, rol: { type: "choice", choice: "kader", probabilities: { kader: 0.7, toepassing: 0.3 }, confidence: 0.6 } };
  assert.ok(validAnswers(good, q));
  assert.ok(validAnswers({ eigen: { probability: 0 }, rol: { choice: "toepassing", probabilities: { toepassing: 1 } } }, q));
  const bad = [
    {},
    { eigen: good.eigen },
    { ...good, more: good.eigen },
    { ...good, eigen: { probability: 1.01 } },
    { ...good, eigen: { probability: "0.5" } },
    { ...good, eigen: { probability: 0.5, note: "x" } },
    { ...good, eigen: { type: "choice", probability: 0.5 } },
    { ...good, rol: { choice: "feiten", probabilities: { kader: 1 } } },
    { ...good, rol: { choice: "kader" } },
    { ...good, rol: { choice: "kader", probabilities: { feiten: 0.5 } } },
    { ...good, rol: { choice: "kader", probabilities: { kader: 0.5 }, confidence: 2 } },
    { ...good, rol: { choice: "__proto__", probabilities: {} } },
    [good],
  ];
  for (const b of bad) assert.equal(validAnswers(b, q), false, JSON.stringify(b));
  // Size: a valid answer over 4 KB is not stored.
  const criteria = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`z${i + 1}`, "s"]));
  const bigQ = { zin: { type: "choice", criteria } };
  const bigA = { zin: { choice: "z1", probabilities: Object.fromEntries(Object.keys(criteria).map((k) => [k, 0.001])) } };
  assert.ok(validAnswers(bigA, bigQ));
  assert.equal(storable(bigA, bigQ), false);
});

test("readAnswers: undecodable, oversized or wrong-shape rows are misses", async () => {
  const db = fakeD1();
  const q = { eigen: { type: "boolean" } };
  const k1 = new Uint8Array(16).fill(1);
  const k2 = new Uint8Array(16).fill(2);
  const k3 = new Uint8Array(16).fill(3);
  db.rows.set(`7|${hex(k1)}`, encodeAnswers({ eigen: { probability: 0.5 } }));
  db.rows.set(`7|${hex(k2)}`, encodeAnswers({ eigen: { probability: 0.5 }, x: 1 }));
  db.rows.set(`7|${hex(k3)}`, Uint8Array.from([1, 0xff, 0xff, 0x00]));
  const invalid = new Set();
  const out = await readAnswers(db, 7, [k1, k2, k3], [q, q, q], invalid);
  assert.deepEqual(out, [{ eigen: { probability: 0.5 } }, null, null]);
  assert.deepEqual([...invalid].sort(), [1, 2]);
});

test("version allowlist", () => {
  for (const v of ["1.0.0", "1.0.1", "1.1.0"]) assert.equal(versionLabel(v), v);
  for (const v of ["1.1.1", "1.12.34", "2.0.0", "1.1", "1.1.0.1", "01.1.0", "1.1.0-beta", "", null, 1.1, "__proto__"]) assert.equal(versionLabel(v), "other", String(v));
});

test("ping: one active and three installs per /48 per day, counted only when allowed", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await worker.fetch(post("/v1/ping", { v: "1.1.0" }, { ip: `2001:db8:99:${i}::1` }), env, ctx)).status);
  for (let i = 0; i < 5; i++) statuses.push((await worker.fetch(post("/v1/ping", { v: "1.1.0", event: "install" }, { ip: `2001:db8:99:${i}::1` }), env, ctx)).status);
  assert.ok(statuses.every((s) => s === 204));
  // What reached the counters: read them back through the global object.
  await ctx.settle();
  const token = "t".repeat(40);
  const stats = await worker.fetch(new Request(`${HOST}/v1/stats?days=1`, { headers: { Authorization: `Bearer ${token}` } }), { ...env, STATS_TOKEN: token }, ctx);
  const counters = (await stats.json()).days[0].counters;
  assert.equal(counters["ping:1.1.0"], 1);
  assert.equal(counters["install:1.1.0"], 3);
  // Already counted today: answered from memory, no further Durable Object requests.
  const before = env.LIMITER.calls.filter((c) => c === "p.ping").length;
  await worker.fetch(post("/v1/ping", { v: "1.1.0" }, { ip: "2001:db8:99:5::1" }), env, ctx);
  assert.equal(env.LIMITER.calls.filter((c) => c === "p.ping").length, before);
  // A short STATS_TOKEN switches the endpoint off.
  const short = await worker.fetch(new Request(`${HOST}/v1/stats`, { headers: { Authorization: "Bearer short" } }), { ...env, STATS_TOKEN: "short" }, ctx);
  assert.equal(short.status, 404);
});

test("lookup hits have their own counter; judge counters stay judge calls", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = freshIp();
  await worker.fetch(post("/v1/judge", CORE(77), { ip }), env, ctx);
  await ctx.settle();
  const res = await worker.fetch(post("/v1/lookup", { kind: "core", court: "de Hoge Raad", items: [{ state: CORE(77).state }, { state: CORE(78).state }] }, { ip }), env, ctx);
  const { answers } = await res.json();
  assert.ok(answers[0] && answers[1] === null);
  const token = "t".repeat(40);
  const stats = await worker.fetch(new Request(`${HOST}/v1/stats?days=1`, { headers: { Authorization: `Bearer ${token}` } }), { ...env, STATS_TOKEN: token }, ctx);
  const c = (await stats.json()).days[0].counters;
  assert.ok(c["lookup:hit"] >= 1);
  assert.ok(c["lookup:core"] >= 1);
});

test("workers.dev host: only /v1/judge, Rechtspraak only, own limits", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const host = "https://minuut-leeswijzer.lucas-hogendoorn.workers.dev";
  const ip = freshIp();
  assert.equal((await worker.fetch(post("/v1/judge", CORE(1), { ip, host }), env, ctx)).status, 200);
  assert.ok(env.LIMITER.calls.includes("l.take"));
  assert.equal((await worker.fetch(post("/v1/lookup", { kind: "core", items: [{ state: "x" }] }, { ip, host }), env, ctx)).status, 404);
  assert.equal((await worker.fetch(post("/v1/ping", { v: "1.1.0" }, { ip, host }), env, ctx)).status, 404);
  assert.equal((await worker.fetch(new Request(`${host}/v1/stats`), { ...env, STATS_TOKEN: "t".repeat(40) }, ctx)).status, 404);
  assert.equal((await worker.fetch(post("/v1/judge", { ...CORE(2), lang: "en", court: "het Hof van Justitie" }, { ip, host }), env, ctx)).status, 400);
  await ctx.settle();
});

// ---- round 2 -------------------------------------------------------------------------------

const fresh = (tag) => import(`../src/index.js?isolate=${tag}`).then((m) => m.default);

test("global pause: over the minute cap, Jev calls get 503 while cache hits are still served", async () => {
  const worker = await fresh("shed");
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = freshIp();
  // Other isolates already reported 3,001 Jev calls this minute.
  await env.LIMITER.get("global").report(undefined, 3_001);
  const body = CORE(777_001);
  assert.equal((await worker.fetch(post("/v1/judge", body, { ip }), env, ctx)).status, 200); // first call; its report learns "pause"
  await ctx.settle();
  assert.equal((await worker.fetch(post("/v1/judge", body, { ip }), env, ctx)).status, 200, "cache hit still served");
  const calls = gatewayCalls;
  const res = await worker.fetch(post("/v1/judge", { kind: "segment", question: "Is dit een test?", state: "Rechtsoverweging 9: iets." }, { ip }), env, ctx);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal((await res.json()).error_type, "unavailable");
  assert.equal(gatewayCalls, calls, "no Jev call while paused");
});

test("global daily cap and day rollover", async () => {
  const storage = fakeStorage();
  const g = new Limiter({ storage }, {});
  const { today } = await import("../src/stats.js");
  storage.kv.put(`jev:${today()}`, 79_999);
  assert.equal(g.report(undefined, 0).shed, false);
  assert.equal(g.report(undefined, 1).shed, true, "80,000 Jev calls today: pause");
  assert.equal(storage.kv.get(`jev:${today()}`), 80_000, "the day's total has its own key");
  // The next day starts from that day's own key (0).
  g.day = { day: "2000-01-01", calls: 80_000 };
  g.minute.clear();
  storage.kv.put(`jev:${today()}`, 0);
  assert.equal(g.report(undefined, 1).shed, false);
});

test("junk versions cannot push the daily Jev total or operational counters out of the row", async () => {
  const storage = fakeStorage();
  const g = new Limiter({ storage }, {});
  const { today } = await import("../src/stats.js");
  const day = today();
  // 250 distinct per-version keys (the allowlist stops these at the Worker; this
  // is the Durable Object's own defence) and then the operational ones.
  const junk = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`ping:9.${i}.0`, 1]));
  g.stats(1, { [day]: junk });
  g.counters.flush();
  g.report({ [day]: { "jev:calls": 5, "judge:core": 5, "refused:rate_limit": 2 } }, 5);
  g.counters.flush();
  const row = g.stats(1)[0].counters;
  assert.equal(row["judge:core"], 5);
  assert.equal(row["jev:calls"], 5);
  assert.equal(row["refused:rate_limit"], 2);
  assert.ok(row["other:overflow"] > 0, "per-version keys beyond the cap are merged");
  assert.equal(storage.kv.get(`jev:${day}`), 5);
});

test("ping: the object is named per day and forgets everything when the day is over", async () => {
  const worker = await fresh("pingday");
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = "2001:db8:4242:1::1";
  assert.equal((await worker.fetch(post("/v1/ping", { v: "1.1.0" }, { ip }), env, ctx)).status, 204);
  const [name] = [...env.LIMITER.objects.keys()].filter((n) => n.startsWith("p:"));
  const obj = env.LIMITER.objects.get(name);
  assert.deepEqual(obj.ctx.storage.kv.get("ping"), { active: 1, install: 0 });
  const until = obj.ctx.storage.alarm;
  assert.ok(until > Date.now() && until <= Date.now() + 86_400_000, "alarm at the end of the Amsterdam day");
  await obj.alarm();
  assert.equal(obj.ctx.storage.size, 0, "storage deleted at day end");
  // The next day: another object name for the same network.
  const RealDate = Date;
  const offset = 86_400_000;
  globalThis.Date = class extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [RealDate.now() + offset]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  };
  try {
    const worker2 = await fresh("pingday2");
    assert.equal((await worker2.fetch(post("/v1/ping", { v: "1.1.0" }, { ip }), env, ctx)).status, 204);
  } finally {
    globalThis.Date = RealDate;
  }
  const names = [...env.LIMITER.objects.keys()].filter((n) => n.startsWith("p:"));
  assert.equal(names.length, 2);
  assert.ok(!names[1].includes(name.slice(2)), "unlinkable across days");
});

test("DO errors: a retryable non-overload error is retried once; afterwards leases still work", async () => {
  const worker = await fresh("doerr");
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = freshIp();
  env.LIMITER.failError = () => Object.assign(new Error("Network connection lost."), { retryable: true });
  env.LIMITER.failing = 1;
  assert.equal((await worker.fetch(post("/v1/judge", CORE(880_001), { ip }), env, ctx)).status, 200, "retried once");
  env.LIMITER.failError = () => Object.assign(new Error("overloaded"), { retryable: true, overloaded: true });
  env.LIMITER.failing = 1;
  // Build up a burst so the next Durable Object call asks for a lease, then fail it.
  for (let i = 0; i < 3; i++) await worker.fetch(post("/v1/judge", CORE(880_010 + i), { ip }), env, ctx);
  assert.ok(env.LIMITER.args.some((a) => a.method === "take" && a.args[2] > 0), "a burst asks for a lease");
  env.LIMITER.failing = 1;
  // Spend any lease left, so the next call must ask the Durable Object.
  let status = 200;
  for (let i = 0; i < 40 && status === 200; i++) status = (await worker.fetch(post("/v1/judge", CORE(880_100 + i), { ip }), env, ctx)).status;
  assert.equal(status, 503, "an overloaded Durable Object is not retried");
  const n = env.LIMITER.args.length;
  assert.equal((await worker.fetch(post("/v1/judge", CORE(880_200), { ip }), env, ctx)).status, 200);
  const next = env.LIMITER.args.slice(n).find((a) => a.method === "take");
  assert.ok(next.args[2] > 0, "the failed lease request did not leave the key stuck");
  await ctx.settle();
});

test("RL_SALT missing or short: fail closed with 503, no unsalted hash", async () => {
  for (const RL_SALT of [undefined, "", "short"]) {
    const env = { ...makeEnv(), RL_SALT };
    for (const path of ["/v1/judge", "/v1/ping"]) {
      const res = await worker.fetch(post(path, path === "/v1/ping" ? { v: "1.1.0" } : CORE(1)), env, makeCtx());
      assert.equal(res.status, 503, `${path} ${RL_SALT}`);
    }
    assert.deepEqual(env.LIMITER.calls, []);
  }
});

test("the workers.dev host gets a short Retry-After on 503", async () => {
  const env = makeEnv();
  env.LIMITER.failing = true;
  const res = await worker.fetch(post("/v1/judge", CORE(1), { ip: freshIp(), host: "https://minuut-leeswijzer.lucas-hogendoorn.workers.dev" }), env, makeCtx());
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "5");
});

test("lookup items have their own budget: refused past 600 in 10 s, judge calls unaffected", async () => {
  const worker = await fresh("items");
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = freshIp();
  const items = Array.from({ length: 100 }, (_, i) => ({ state: `Rechtsoverweging ${i}: tekst van de overweging.` }));
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await worker.fetch(post("/v1/lookup", { kind: "core", court: "de Hoge Raad", items }, { ip }), env, ctx)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
  assert.equal((await worker.fetch(post("/v1/judge", CORE(990_001), { ip }), env, ctx)).status, 200);
});

// N module instances of index.js = N isolates, sharing one Durable Object
// namespace (after a reviewer's scratchpad/rv/sim.mjs).
async function readers({ isolates, readers: n, calls = 129, ip, env }) {
  const workers = await Promise.all(Array.from({ length: isolates }, (_, i) => fresh(`sim-${ip}-${i}`)));
  const ctx = makeCtx();
  const statuses = {};
  let rr = 0;
  const note = (path, res) => {
    const k = `${path} ${res.status}`;
    statuses[k] = (statuses[k] ?? 0) + 1;
  };
  const next = () => workers[rr++ % workers.length];
  const reader = async (r) => {
    // The extension: one lookup of 100 + 1 items, then five judge calls in flight.
    for (const size of [100, 1]) {
      const items = Array.from({ length: size }, (_, i) => ({ state: `lezer ${r} punt ${size}-${i}` }));
      note("lookup", await next().fetch(post("/v1/lookup", { kind: "core", court: "de Hoge Raad", items }, { ip }), env, ctx));
    }
    let i = 0;
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        while (i < calls) note("judge", await next().fetch(post("/v1/judge", CORE(`${ip}-${r}-${i++}`), { ip }), env, ctx));
      }),
    );
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: n }, (_, r) => reader(r)));
  await ctx.settle();
  return { statuses, ms: Date.now() - t0 };
}

test("office NAT: three readers of a cold 101-punt ruling behind one address within 10 s get no 429", async () => {
  gatewayMs = 20;
  try {
    const env = makeEnv();
    const { statuses, ms } = await readers({ isolates: 2, readers: 3, ip: "203.0.113.200", env });
    assert.ok(ms < 10_000, `took ${ms} ms`);
    assert.deepEqual(statuses, { "lookup 200": 6, "judge 200": 3 * 129 });
  } finally {
    gatewayMs = 0;
  }
});

test("several isolates: the per-client cap still holds across them", async () => {
  const env = makeEnv();
  const { statuses } = await readers({ isolates: 4, readers: 6, ip: "203.0.113.201", env });
  // 6 x 129 judge calls within about a second, spread over 4 isolates: the
  // client Durable Object allows exactly 500 in 10 s across all of them.
  assert.equal(statuses["judge 200"], 500, JSON.stringify(statuses));
  assert.equal(statuses["judge 429"], 6 * 129 - 500, JSON.stringify(statuses));
});
