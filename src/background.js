// Minuut Leeswijzer: service worker.
// Every Jev call goes through Minuut's Cloudflare Worker, which holds the key
// and forces zero data retention. Nothing is stored beyond this browser
// session: answers are cached in chrome.storage.session, which the browser
// wipes when it closes.

// Minuut's Worker (not in this repo; see README.md for its request format).
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

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html?welkom") });
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
  const { kind, question, state, sentences, court } = request ?? {};
  if (!KINDS.has(kind) || typeof question !== "string" || typeof state !== "string") {
    throw new JevError("request", "Onverwacht verzoek.");
  }
  const body = {
    kind,
    question,
    state,
    ...(Array.isArray(sentences) ? { sentences } : {}),
    ...(typeof court === "string" ? { court } : {}),
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

// Toolbar button: toggle the panel on Rechtspraak.nl, otherwise open Rechtspraak.nl.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id && tab.url?.startsWith("https://uitspraken.rechtspraak.nl/")) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" });
      return;
    } catch {
      // Content script not yet injected (tab opened before install): fall through.
    }
  }
  chrome.tabs.create({ url: "https://uitspraken.rechtspraak.nl/" });
});
