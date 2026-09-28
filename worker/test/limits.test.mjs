import test from "node:test";
import assert from "node:assert/strict";
import { LEASE_MAX, LEASE_MS, Leases, RefusedClients, TokenBuckets, Windows, clientNet, parseIPv6, readLimited } from "../src/limits.js";

test("IPv6 is keyed on its /64, with :: expanded", () => {
  assert.deepEqual(parseIPv6("2001:db8::1"), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  assert.equal(clientNet("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "6:2001:db8:1:2");
  assert.equal(clientNet("2001:db8:1:2::"), "6:2001:db8:1:2");
  assert.equal(clientNet("2001:0DB8:0001:0002:0:0:0:1"), "6:2001:db8:1:2");
  // Every address in one /64 is one client, whatever its notation.
  const same = ["2001:db8:0:0:1::5", "2001:db8::1:0:0:5", "2001:db8:0:0:ffff:ffff:ffff:ffff", "[2001:db8::]", "2001:db8::%eth0"];
  for (const ip of same) assert.equal(clientNet(ip), "6:2001:db8:0:0", ip);
  assert.notEqual(clientNet("2001:db8:0:1::1"), clientNet("2001:db8:0:0::1"));
  assert.equal(clientNet("::1"), "6:0:0:0:0");
  assert.equal(clientNet("::"), "6:0:0:0:0");
  assert.equal(clientNet("fe80::1:2:3:4"), "6:fe80:0:0:0");
});

test("IPv6 /48 for the ping limiter", () => {
  assert.equal(clientNet("2001:db8:abcd:1234::1", 48), "6:2001:db8:abcd");
  assert.equal(clientNet("2001:db8:abcd:ffff:1::", 48), "6:2001:db8:abcd");
});

test("IPv4 and IPv4-mapped IPv6 are one client", () => {
  assert.equal(clientNet("192.0.2.7"), "4:192.0.2.7");
  assert.equal(clientNet("::ffff:192.0.2.7"), "4:192.0.2.7");
  assert.equal(clientNet("::ffff:c000:207"), "4:192.0.2.7");
  assert.equal(clientNet("0:0:0:0:0:ffff:192.0.2.7"), "4:192.0.2.7");
  assert.equal(clientNet("::ffff:192.0.2.7", 48), "4:192.0.2.7");
  // IPv4-compatible/embedded forms that are not ::ffff: stay IPv6.
  assert.equal(clientNet("64:ff9b::192.0.2.7"), "6:64:ff9b:0:0");
});

test("junk never merges with a real client", () => {
  for (const bad of ["", "unknown", "1.2.3", "1.2.3.256", "01.2.3.4", "2001:db8:::1", "1:2:3:4:5:6:7:8:9", "2001:db8::g", "1::2::3"]) {
    assert.match(clientNet(bad), /^x:/, bad);
  }
  assert.equal(parseIPv6("1:2:3:4:5:6:7::8"), null); // "::" must stand for at least one group
});

test("token bucket: capacity, refill, retry-after, bounded size", () => {
  const b = new TokenBuckets({ capacity: 3, perSecond: 1, max: 2 });
  const t = 1_000_000;
  assert.equal(b.take("a", 1, t), 0);
  assert.equal(b.take("a", 1, t), 0);
  assert.equal(b.take("a", 1, t), 0);
  assert.equal(b.take("a", 1, t), 1); // empty: one token per second
  assert.equal(b.take("a", 1, t + 1000), 0); // refilled one
  assert.equal(b.take("a", 5, t + 1000), 3); // more than capacity: never
  b.take("b", 1, t);
  b.take("c", 1, t);
  assert.equal(b.buckets.size, 2); // oldest key evicted
  assert.ok(!b.buckets.has("a"));
});

test("token bucket sized like the extension never trips on a cold 101-punt ruling", () => {
  // Measured: 101 core + 28 sentences judge calls plus 2 lookups within ~10 s.
  const b = new TokenBuckets({ capacity: 300, perSecond: 15 });
  let t = 0;
  for (let i = 0; i < 131; i++, t += 75) assert.equal(b.take("k", 1, t), 0);
});

test("negative cache: refused key waits, expires, bounded", () => {
  const r = new RefusedClients(2);
  const t = 5_000_000;
  assert.equal(r.check("a", t), 0);
  r.refuse("a", 10, t);
  assert.equal(r.check("a", t), 10);
  assert.equal(r.check("a", t + 9_500), 1);
  assert.equal(r.check("a", t + 10_000), 0);
  assert.equal(r.size, 0); // expired entries are dropped
  r.refuse("a", 10, t);
  r.refuse("b", 10, t);
  r.refuse("c", 10, t);
  assert.equal(r.size, 2);
  assert.equal(r.check("a", t), 0);
});

test("leases: none for a lone call, a few for a burst, expire before the 10 s window", () => {
  const l = new Leases();
  const t = 9_000_000;
  assert.equal(l.spend("k", t), false);
  assert.equal(l.want("k", t), 0); // a single call asks for no lease
  for (let i = 1; i < 6; i++) l.spend("k", t + i);
  assert.equal(l.want("k", t + 6), 5);
  l.grant("k", 5, true, t + 6);
  for (let i = 0; i < 5; i++) assert.equal(l.spend("k", t + 7 + i), true);
  assert.equal(l.spend("k", t + 20), false); // used up
  l.grant("k", 3, true, t + 20);
  assert.equal(l.spend("k", t + 20 + LEASE_MS), false); // expired
  assert.ok(LEASE_MS < 10_000);
  for (let i = 0; i < 100; i++) l.spend("z", t + i);
  assert.equal(l.want("z", t + 100), LEASE_MAX);
  // One lease request per key at a time.
  assert.equal(l.want("z", t + 100), 0);
  l.grant("z", 0, false, t + 100); // a call that did not ask does not end it
  assert.equal(l.want("z", t + 100), 0);
  l.grant("z", 4, true, t + 100);
  assert.equal(l.want("z", t + 101), LEASE_MAX);
});

test("exact windows: refuse over the limit, lease only within room, retry-after", () => {
  const w = new Windows();
  const win = [{ limit: 10, ms: 10_000 }, { limit: 15, ms: 60_000 }];
  const t = 100_000_000;
  assert.deepEqual(w.take(win, 1, 4, t), { granted: 5, retryAfter: 0 });
  assert.deepEqual(w.take(win, 3, 10, t), { granted: 5, retryAfter: 0 }); // lease capped by room
  const r = w.take(win, 1, 0, t + 1000);
  assert.equal(r.granted, 0);
  assert.equal(r.retryAfter, 10); // the second-0 bucket leaves the 10 s window at +11 s
  assert.equal(w.take(win, 1, 0, t + 10_000).granted, 0); // still inside
  assert.equal(w.take(win, 1, 0, t + 11_000).granted, 1);
  // 60 s window: 11 used, 4 left.
  assert.equal(w.take(win, 5, 0, t + 12_000).granted, 0);
  assert.equal(w.take(win, 4, 0, t + 12_000).granted, 4);
  assert.equal(w.take(win, 1, 0, t + 13_000).retryAfter, 48);
});

test("exact windows hold in wall-clock time: a burst at x.999 s is counted a full window", () => {
  const w = new Windows();
  const win = [{ limit: 10, ms: 10_000 }];
  const t = 200_000_999; // x.999 s
  assert.equal(w.take(win, 10, 0, t).granted, 10);
  // 9.001 s later (the start of second x+10) the burst still counts.
  assert.equal(w.take(win, 1, 0, t + 9_001).granted, 0);
  assert.equal(w.take(win, 1, 0, t + 10_000).granted, 0);
  // From second x+11 (10.001 s later) there is room again.
  assert.equal(w.take(win, 10, 0, t + 10_001).granted, 10);
  // Never more than the cap in any 10 s of wall-clock time: 20 tokens took 10.001 s.
});

const req = (body, headers = {}) => new Request("https://x/v1/judge", { method: "POST", headers, body, duplex: "half" });
const stream = (chunks) =>
  new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
      c.close();
    },
  });

test("body: 411 without Content-Length, 413 when declared too big, streamed cap", async () => {
  assert.deepEqual(await readLimited(req("{}"), 100), { status: 411 });
  assert.deepEqual(await readLimited(req("{}", { "Content-Length": "abc" }), 100), { status: 411 });
  assert.deepEqual(await readLimited(req("{}", { "Content-Length": "101" }), 100), { status: 413 });
  assert.deepEqual(await readLimited(req('{"a":1}', { "Content-Length": "7" }), 100), { text: '{"a":1}' });
  // Understated length: the stream is cut off at the cap, not buffered.
  let pulled = 0;
  const endless = new ReadableStream({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(64));
    },
  });
  assert.deepEqual(await readLimited(req(endless, { "Content-Length": "10" }), 1_000), { status: 413 });
  assert.ok(pulled < 40, `pulled ${pulled} chunks`);
  assert.deepEqual(await readLimited(req(stream(["{\"x\":", "\"é\"}"]), { "Content-Length": "9" }), 100), { text: '{"x":"é"}' });
});
