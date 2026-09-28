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
    setAlarm: async () => {},
  };
}

// Every RPC is recorded in `calls` as "name.method"; `failing` makes them throw.
function namespace() {
  const objects = new Map();
  const ns = {
    calls: [],
    failing: false,
    idFromName: (name) => name,
    get(name) {
      return new Proxy(
        {},
        {
          get: (_, method) => async (...args) => {
            ns.calls.push(`${name.split(":")[0]}.${String(method)}`);
            if (ns.failing) throw new Error("Durable Object unavailable");
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
globalThis.fetch = async (url, init) => {
  gatewayCalls++;
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
  return { LIMITER: namespace(), DB: fakeD1(), RL_SALT: "test", ALLOWED_ORIGINS: "", DEV_GATEWAY_URL: "http://127.0.0.1:9/v1/evaluate", AI_GATEWAY_API_KEY: "x" };
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
    [new Request(`${HOST}/v1/judge`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" }), 411],
    [post("/v1/judge", "{}", { headers: { "Content-Length": "999999" } }), 413],
    [post("/v1/judge", "not json"), 400],
    [post("/v1/judge", { kind: "nope", state: "x" }), 400],
    [new Request(`${HOST}/v1/ping`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" }), 411],
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
  assert.deepEqual(env.LIMITER.calls, []);
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
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = freshIp();
  let refusedAt = -1;
  // Sequential calls: no leases pile up, every call asks the client object until it refuses.
  for (let i = 0; i < 320; i++) {
    const res = await worker.fetch(post("/v1/judge", CORE(1000 + i), { ip }), env, ctx);
    if (res.status === 429) {
      refusedAt = i;
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
      assert.ok(Number(res.headers.get("Retry-After")) >= 1);
      assert.equal((await res.json()).error_type, "rate_limited");
      break;
    }
  }
  assert.equal(refusedAt, 300, "the 301st call in 10 s is refused");
  const before = env.LIMITER.calls.length;
  for (let i = 0; i < 200; i++) assert.equal((await worker.fetch(post("/v1/judge", CORE(5000 + i), { ip }), env, ctx)).status, 429);
  assert.equal(env.LIMITER.calls.length, before, "refused flood: no Durable Object requests");
  assert.ok(!env.LIMITER.calls.slice(0, before).includes("global.take"));
  // At most one global report per 10 s per isolate, whatever the traffic.
  assert.ok(env.LIMITER.calls.filter((c) => c === "global.report").length <= 1);
  await ctx.settle();
});

test("the token bucket stops a flood before the Durable Object", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const ip = freshIp();
  // Parallel flood: leases would let many through without a DO call; the
  // bucket (300 at once) caps what one isolate lets through at all.
  const results = await Promise.all(Array.from({ length: 400 }, (_, i) => worker.fetch(post("/v1/judge", CORE(9000 + i), { ip }), env, ctx)));
  const ok = results.filter((r) => r.status === 200).length;
  assert.ok(ok <= 300, `${ok} allowed`);
  assert.ok(env.LIMITER.calls.filter((c) => c === "c.take").length <= 300);
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
    assert.equal(res.headers.get("Retry-After"), "3600");
    assert.equal((await res.json()).error_type, "unavailable");
  }
});

test("IPv6 clients in one /64 share one limit", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  let status = 200;
  for (let i = 0; i < 301 && status === 200; i++) {
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
  for (const v of ["1.1.0", "1.0.1", "1.12.34", "1.9.9"]) assert.equal(versionLabel(v), v);
  for (const v of ["2.0.0", "1.1", "1.1.0.1", "1.123.0", "01.1.0", "1.1.0-beta", "", null, 1.1, "9999.9999.9999"]) assert.equal(versionLabel(v), "other", String(v));
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
