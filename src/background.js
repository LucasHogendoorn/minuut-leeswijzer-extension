// Minuut Leeswijzer: service worker.
// Every Jev call goes through Minuut's Cloudflare Worker, which holds the key
// and forces zero data retention. The Worker keeps only answers about public
// ruling text asked without a question (a shared cache); the question stays in
// this browser session: answers are cached in chrome.storage.session, which
// the browser wipes when it closes.

// Minuut's production Worker (worker/; see CONTRIBUTING.md to run your own).
const PRODUCTION_ENDPOINT = "https://minuut-leeswijzer.lucas-hogendoorn.workers.dev/v1/judge";
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
    await chrome.storage.local.set({ seenVersion: version });
    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html?welkom") });
  } else if (reason === "update" && previousVersion) {
    const { seenVersion } = await chrome.storage.local.get("seenVersion");
    if (!seenVersion) await chrome.storage.local.set({ seenVersion: previousVersion });
  }
});

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

async function evaluate(request) {
  const { kind, question, state, sentences, court, lang } = request ?? {};
  if (!KINDS.has(kind) || typeof question !== "string" || typeof state !== "string") {
    throw new JevError("request", "Onverwacht verzoek.");
  }
  const body = {
    kind,
    question,
    state,
    ...(Array.isArray(sentences) ? { sentences } : {}),
    ...(typeof court === "string" ? { court } : {}),
    ...(lang === "nl" || lang === "en" ? { lang } : {}),
  };
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
