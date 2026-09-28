// Minuut Leeswijzer: service worker.
// Every Jev call goes through Minuut's Cloudflare Worker, which holds the key
// and forces zero data retention. The Worker keeps only answers about public
// ruling text asked without a question (a shared cache); the question stays in
// this browser session: answers are cached in chrome.storage.session, which
// the browser wipes when it closes.

// Minuut's production Worker (worker/; see CONTRIBUTING.md to run your own).
// /v1/lookup and /v1/ping are derived from it. The calls rely on CORS (the
// Worker answers only the store extension's origin), not on host permissions.
const PRODUCTION_ENDPOINT = "https://leeswijzer-api.minuut.eu/v1/judge";
const CACHE_PREFIX = "jev:";
const MAX_ATTEMPTS = 4;

// Content scripts may read the session store (the question of this session).
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });

// A gitignored dev-config.json can point an unpacked development install at
// another endpoint. Store installs (they carry an update_url) never read it.
const IS_STORE_BUILD = "update_url" in chrome.runtime.getManifest();
let endpointPromise;
function endpoint() {
  if (IS_STORE_BUILD) return Promise.resolve(PRODUCTION_ENDPOINT);
  endpointPromise ??= fetch(chrome.runtime.getURL("dev-config.json"))
    .then((r) => (r.ok ? r.json() : {}))
    .then((c) => c.endpoint || PRODUCTION_ENDPOINT)
    .catch(() => PRODUCTION_ENDPOINT);
  return endpointPromise;
}

// seenVersion: the last version this profile was told about (the "Nieuw in
// Leeswijzer" card in src/whatsnew.js, which holds the full rule). A fresh
// install records the current version and gets the welcome page; an update
// records the version it came from, unless a card already recorded one.
chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  const version = chrome.runtime.getManifest().version;
  if (reason === "install") {
    // Count a real first install only: its storage is still empty. (In
    // testing, an unpacked copy loaded with --load-extension reported
    // "install" again on every browser start.)
    const fresh = !Object.keys(await chrome.storage.local.get(null)).length;
    await chrome.storage.local.set({ seenVersion: version });
    if (fresh) sendPing("install").catch(() => {});
    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html?welkom") });
  } else if (reason === "update" && previousVersion) {
    const { seenVersion } = await chrome.storage.local.get("seenVersion");
    if (!seenVersion) await chrome.storage.local.set({ seenVersion: previousVersion });
  }
});

// ---- Anonymous usage count --------------------------------------------------------------
// At most once per calendar day (Europe/Amsterdam), on the first ruling or
// search page where the Leeswijzer runs, one ping tells the Worker "an install
// of version X was active today"; a fresh install sends one "install" ping.
// The body is only the version and that one word: no ID, no question, no ECLI,
// no URL. `pingedOn` (the date of the last daily ping) is the only thing kept.
const amsterdamDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());

async function sendPing(event) {
  const url = (await endpoint()).replace(/\/v1\/judge$/, "/v1/ping");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ v: chrome.runtime.getManifest().version, event }),
  });
  return res.ok;
}

let activeToday; // one check at a time: several tabs may report at once
function markActive() {
  activeToday ??= (async () => {
    const day = amsterdamDay();
    const { pingedOn } = await chrome.storage.local.get("pingedOn");
    if (pingedOn === day) return;
    await chrome.storage.local.set({ pingedOn: day });
    try {
      await sendPing("active");
    } catch {
      // Not reached (offline): forget the date, so a later page tries again.
      await (pingedOn ? chrome.storage.local.set({ pingedOn }) : chrome.storage.local.remove("pingedOn"));
    }
  })().finally(() => (activeToday = undefined));
  return activeToday;
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class JevError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callJev(body) {
  const url = await endpoint();
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      lastError = new JevError("network", "Geen verbinding met de Leeswijzer-server.");
      await sleep(400 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    const detail = await res.json().catch(() => ({}));
    if (res.status === 400) throw new JevError("request", detail.message ?? "Het verzoek werd geweigerd.");
    lastError = new JevError(res.status === 429 ? "busy" : "upstream", detail.message ?? `De server antwoordde ${res.status}.`);
    // Short, jittered retries: the gateway's 503/429 under bursts clears fast.
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (200 + Math.random() * 300) * 2 ** attempt);
  }
  throw lastError;
}

const KINDS = new Set(["core", "segment", "ruling", "sentences"]);

// The body of one judge call; its hash is also the session-cache key, so a
// lookup (below) fills the same entries a judge call would.
const judgeBody = ({ kind, question, state, sentences, court, lang }) => ({
  kind,
  question,
  state,
  ...(Array.isArray(sentences) ? { sentences } : {}),
  ...(typeof court === "string" ? { court } : {}),
  ...(lang === "nl" || lang === "en" ? { lang } : {}),
});

async function evaluate(request) {
  const { kind, question, state } = request ?? {};
  if (!KINDS.has(kind) || typeof question !== "string" || typeof state !== "string") {
    throw new JevError("request", "Onverwacht verzoek.");
  }
  const body = judgeBody(request);
  const key = CACHE_PREFIX + (await sha256(JSON.stringify(body)));
  const cached = (await chrome.storage.session.get(key))[key];
  if (cached) return { answers: cached, cached: true };
  const data = await callJev(body);
  const answers = data.answers ?? {};
  // Session storage has a 10 MB quota; answers are a few hundred bytes. If it
  // fills up, skip caching rather than fail the call.
  await chrome.storage.session.set({ [key]: answers }).catch(() => {});
  return { answers, cached: false };
}

// ---- Lookup: many cached answers at once ------------------------------------------------
// Before judging a ruling without a question, one request asks the Worker's
// shared cache for all its r.o.'s (POST /v1/lookup); only the misses are then
// judged one by one. The Worker's lookup never calls Jev. Answers come back in
// order, null where nothing is cached; hits also go into the session cache.
// `session` says per item whether it came from this session's own cache (as
// `cached` does for a judge call).
// Any failure (offline, 429, an older Worker without /v1/lookup) just means
// "nothing cached": the r.o.'s are judged as before.
const LOOKUP_ITEMS = 100; // the Worker's limit per request
const LOOKUP_BYTES = 400_000; // below the Worker's 512 KB body limit

async function lookupChunk(kind, court, lang, items) {
  const url = (await endpoint()).replace(/\/v1\/judge$/, "/v1/lookup");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, ...(court ? { court } : {}), ...(lang ? { lang } : {}), items }),
  });
  if (!res.ok) throw new JevError("lookup", `De server antwoordde ${res.status}.`);
  const answers = (await res.json())?.answers;
  return Array.isArray(answers) && answers.length === items.length ? answers : items.map(() => null);
}

async function lookup(request) {
  const { kind, court, lang, items } = request ?? {};
  if ((kind !== "core" && kind !== "sentences") || !Array.isArray(items)) throw new JevError("request", "Onverwacht verzoek.");
  const bodies = items.map((item) => judgeBody({ kind, question: "", state: item?.state, sentences: item?.sentences, court, lang }));
  const keys = await Promise.all(bodies.map((b) => sha256(JSON.stringify(b)).then((h) => CACHE_PREFIX + h)));
  const session = await chrome.storage.session.get(keys);
  const out = keys.map((k) => session[k] ?? null);
  const fromSession = out.map(Boolean);
  // What this session does not have yet goes to the Worker, in chunks.
  const chunks = [];
  let chunk = [];
  let bytes = 0;
  for (const [i, b] of bodies.entries()) {
    if (out[i] || typeof b.state !== "string") continue;
    const item = { state: b.state, ...(b.sentences ? { sentences: b.sentences } : {}) };
    const size = JSON.stringify(item).length;
    if (chunk.length && (chunk.length >= LOOKUP_ITEMS || bytes + size > LOOKUP_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push({ i, item });
    bytes += size;
  }
  if (chunk.length) chunks.push(chunk);
  await Promise.all(
    chunks.map(async (c) => {
      const answers = await lookupChunk(kind, court, lang, c.map((x) => x.item)).catch(() => []);
      const fresh = {};
      c.forEach((x, j) => {
        const a = answers[j];
        if (a && typeof a === "object" && !Array.isArray(a)) {
          out[x.i] = a;
          fresh[keys[x.i]] = a;
        }
      });
      if (Object.keys(fresh).length) await chrome.storage.session.set(fresh).catch(() => {});
    }),
  );
  return { answers: out, session: fromSession };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only this extension's own content scripts and pages may ask anything.
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === "jev:evaluate") {
    evaluate(msg.request).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: { code: err.code ?? "unknown", message: err.message } }),
    );
    return true;
  }
  if (msg?.type === "jev:lookup") {
    lookup(msg.request).then(
      (data) => sendResponse({ ok: true, ...data }),
      (err) => sendResponse({ ok: false, error: { code: err.code ?? "unknown", message: err.message } }),
    );
    return true;
  }
  if (msg?.type === "open-tabs") {
    // Open in rank order, right after the tab that asked, in the background.
    // Only ruling pages on Rechtspraak.nl, at most 25.
    (async () => {
      const base = sender.tab?.index ?? 0;
      const urls = (Array.isArray(msg.urls) ? msg.urls : []).slice(0, 25);
      for (const [i, url] of urls.entries()) {
        if (typeof url !== "string" || !url.startsWith("https://uitspraken.rechtspraak.nl/details?id=")) continue;
        await chrome.tabs.create({ url, index: base + 1 + i, active: Boolean(msg.active) && i === 0, openerTabId: sender.tab?.id });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === "active") {
    markActive().catch(() => {});
    return false;
  }
  if (msg?.type === "open-options") {
    chrome.runtime.openOptionsPage();
    return false;
  }
  return false;
});

// The pages the content script runs on (manifest.json).
const READ_PAGES = ["https://uitspraken.rechtspraak.nl/", "https://infocuria.curia.europa.eu/", "https://eur-lex.europa.eu/legal-content/"];

// Toolbar button: toggle the panel where Leeswijzer reads, otherwise open Rechtspraak.nl.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id && READ_PAGES.some((page) => tab.url?.startsWith(page))) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" });
      return;
    } catch {
      // Content script not yet injected (tab opened before install), or an
      // EUR-Lex page that is not case law: fall through.
    }
  }
  chrome.tabs.create({ url: "https://uitspraken.rechtspraak.nl/" });
});
