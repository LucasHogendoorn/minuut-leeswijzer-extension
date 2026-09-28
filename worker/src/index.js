import { DurableObject } from "cloudflare:workers";

// Minuut Leeswijzer: Cloudflare Worker in front of Jev (Vercel AI Gateway).
//
// Free for everyone: the Worker holds Minuut's AI Gateway key as a secret
// (env.AI_GATEWAY_API_KEY), so users need no key and the key never reaches a
// browser. Abuse is contained by design rather than by trust:
//   - the typed questions Jev answers are built HERE, from fixed templates; a
//     client only picks one of four kinds and supplies the legal question
//     (optional for "core") and the public ruling text, so the endpoint cannot be used to ask Jev
//     anything else;
//   - strict size limits on every field and on the raw body;
//   - exact per-client rate limits (burst and per minute) plus a global limit
//     that caps spend if many IPs join in (Durable Objects, memory only);
//   - only browser-extension origins, optionally pinned to the store IDs in
//     env.ALLOWED_ORIGINS.
//
// Privacy: nothing is stored or logged. Every call goes to the gateway with
// zero data retention forced on, restricted to TypeSafe AI. No request body is
// written anywhere; `observability` is disabled in wrangler.toml. Responses carry
// only Jev's answers, never usage, routing, cost or upstream error bodies.

const GATEWAY = "https://ai-gateway.vercel.sh/v1/evaluate";
const MODEL = "typesafe-ai/jev";

const LIMITS = {
  body: 120_000, // bytes of raw JSON
  question: 500, // characters of the lawyer's question
  state: 30_000, // the gateway refuses (429) from roughly 30-40k characters
  sentences: 40,
  sentence: 1_500,
};

// ---- The only questions this Worker will put to Jev -------------------------------
// Kept in sync with the categories the extension shows (src/shared.js).

const ROLES = {
  kader: "juridisch kader: de rechtsregel of maatstaf die de rechter hanteert (wetsartikel, vaste rechtspraak, toetsingsmaatstaf), in algemene termen, los van de feiten van deze zaak",
  toepassing: "toepassing van het juridisch kader: de rechter weegt de feiten van deze zaak aan de hand van de regel of maatstaf en trekt een conclusie",
  obiter: "obiter dictum: een oordeel ten overvloede of terzijde, niet nodig voor de beslissing",
  stellingen: "stellingen van partijen: wat een partij stelt, aanvoert, betwist of vordert, of de grieven, klachten of middelen",
  feiten: "feiten: weergave van vaststaande feiten of de voorgeschiedenis, zonder juridisch oordeel",
  proces: "procesverloop: processtukken, zittingen, bevoegdheid, ontvankelijkheid, termijnen, bewijsopdracht of proceskosten",
  beslissing: "beslissing: het dictum, wat de rechter toewijst, afwijst, vernietigt, veroordeelt of bepaalt",
};

// Who is speaking, as named in the core questions. A closed list, so the field
// cannot carry free text into a question.
const COURTS = new Set([
  "de Hoge Raad", "het hof", "de rechtbank", "de kantonrechter", "de voorzieningenrechter", "de Raad van State", "de Centrale Raad van Beroep", "het College", "de rechter",
  // EU case law (Curia, EUR-Lex).
  "het Hof van Justitie", "het Gerecht", "de advocaat-generaal",
]);
const EU_COURTS = new Set(["het Hof van Justitie", "het Gerecht"]);
// An advocate general advises the Court: his own analysis and the answer he
// proposes take the place of a court's judgement and decision.
const ADVISER = "de advocaat-generaal";

// "Eigen oordeel" per speaker. The Dutch courts keep their tested wording; the
// EU courts answer a referring court; the advocate general proposes.
function ownQuestion(court) {
  if (court === ADVISER) {
    return {
      instructions: `Geeft ${court} in deze passage zijn eigen analyse of oordeel, of formuleert hij zelf een rechtsregel (maatstaf) die hij het Hof voorstelt?`,
      true: `${court} analyseert, beoordeelt of formuleert in eigen woorden de regel of het antwoord dat hij voorstelt`,
      false: "alleen feiten, standpunten van partijen, lidstaten of instellingen, de prejudiciële vragen, citaten van wetgeving of rechtspraak, of wat de verwijzende rechter of een lagere rechter heeft overwogen (ook als die redenering hier wordt weergegeven)",
    };
  }
  return {
    instructions: `Geeft ${court} in deze passage zelf een oordeel of formuleert ${court} zelf een rechtsregel (maatstaf)?`,
    true: `${court} oordeelt, beslist of formuleert de regel die hij toepast, in eigen woorden`,
    false: EU_COURTS.has(court)
      ? "alleen feiten, standpunten of vorderingen van partijen, lidstaten of instellingen, de prejudiciële vragen, middelen of grieven, citaten, of wat de verwijzende rechter of een lagere rechter heeft overwogen of beslist (ook als die redenering hier wordt weergegeven)"
      : "alleen feiten, standpunten of vorderingen van partijen, klachten of middelen, citaten, of wat een lagere rechter heeft overwogen of beslist (ook als die redenering hier wordt weergegeven)",
  };
}

const QUESTIONS = {
  // One rechtsoverweging: does it touch the question, what kind is it, how useful.
  // One rechtsoverweging. Two sharp yes/no questions instead of one broad
  // "does it touch the question" (tested on 28 r.o.'s: the broad version marked
  // party claims and the lower court's ruling as core).
  segment: (q, _sentences, speaker) => {
    // Named only for EU case law, where the speaker may be an advocate general.
    const court = EU_COURTS.has(speaker) || speaker === ADVISER ? speaker : "de rechter";
    return {
      onderwerp: {
        type: "boolean",
        instructions: `Gaat deze passage over dezelfde juridische kwestie als de rechtsvraag? Rechtsvraag: "${q}"`,
        criteria: {
          true: "de passage behandelt precies deze kwestie: de regel die erop van toepassing is, de feiten die voor deze kwestie beslissend zijn, of wat partijen of de rechter daarover zeggen",
          false: "de passage gaat over een andere kwestie, of alleen over procesverloop, kosten, bevoegdheid of algemene achtergrond, ook als dezelfde partijen of woorden voorkomen",
        },
      },
      antwoord: {
        type: "boolean",
        instructions: `Geeft ${court} in deze passage zelf (een deel van) het antwoord op de rechtsvraag: de maatstaf die hij toepast, of zijn eigen oordeel over precies deze vraag? Rechtsvraag: "${q}"`,
        criteria: {
          true: `een eigen oordeel of maatstaf van ${court} die deze rechtsvraag (gedeeltelijk) beantwoordt`,
          false: "alleen feiten, standpunten van partijen, weergave van een lagere rechter, citaten zonder eigen oordeel, of een oordeel over een andere vraag",
        },
      },
      rol: { type: "choice", instructions: "Wat voor passage is dit binnen de uitspraak?", criteria: ROLES },
    };
  },
  // One rechtsoverweging, no question: is this a core consideration of the
  // judgement? Three factors that must all hold (tested on a hof ruling and a
  // Hoge Raad arrest): the court's own judgement or rule, on the substance, on
  // which the outcome rests. `court` names who is speaking, so the lower court's
  // reasoning quoted in an appeal is not mistaken for the court's own.
  core: (_q, _sentences, court) => {
    const own = ownQuestion(court);
    const adviser = court === ADVISER;
    return {
      eigen: {
        type: "boolean",
        instructions: own.instructions,
        criteria: { true: own.true, false: own.false },
      },
      dragend: {
        type: "boolean",
        instructions: adviser
          ? "Draagt deze passage het antwoord dat de advocaat-generaal voorstelt: formuleert zij de maatstaf waarop dat antwoord berust, of past zij die maatstaf toe op deze zaak?"
          : "Draagt deze passage de beslissing: formuleert zij de maatstaf waarop de uitkomst berust, of past zij die maatstaf toe op deze zaak?",
        criteria: {
          true: adviser ? "het voorgestelde antwoord rust op deze maatstaf of op deze toepassing ervan" : "de uitkomst rust op deze maatstaf of op deze toepassing ervan (ratio decidendi)",
          false: "ten overvloede, terzijde, achtergrond, samenvatting, of alleen de slotsom zonder redenering",
        },
      },
      inhoud: {
        type: "boolean",
        instructions: "Gaat deze passage over de inhoud van het geschil: een rechtsregel of de toepassing daarvan op de feiten?",
        criteria: {
          true: "materieel: wat het recht is en wat dat voor deze zaak betekent",
          false: "procedureel: procesverloop, bevoegdheid, ontvankelijkheid, termijnen, bewijslevering als proceshandeling of proceskosten",
        },
      },
      rol: { type: "choice", instructions: "Wat voor passage is dit binnen de uitspraak?", criteria: ROLES },
    };
  },
  // A whole ruling or one search hit: is this about the question?
  ruling: (q) => ({
    over: {
      type: "boolean",
      instructions: `Behandelt deze uitspraak de volgende rechtsvraag, zodat een advocaat haar moet lezen? Rechtsvraag: "${q}"`,
      criteria: {
        true: "de rechter beoordeelt deze vraag of een wezenlijk onderdeel ervan",
        false: "de uitspraak gaat over iets anders of noemt het onderwerp alleen terloops",
      },
    },
  }),
  // The sentences of one relevant r.o. become the options of one choice.
  sentences: (q, sentences) => ({
    zin: {
      type: "choice",
      instructions: q
        ? "Welke zin uit deze rechtsoverweging beantwoordt de rechtsvraag het meest direct (het oordeel of de maatstaf, niet de feiten)?"
        : "Welke zin uit deze rechtsoverweging bevat het kernoordeel van de rechter (het oordeel of de maatstaf waarop de beslissing rust, niet de feiten)?",
      criteria: Object.fromEntries(sentences.map((s, i) => [`z${i + 1}`, s])),
    },
  }),
};

// ---- HTTP helpers ------------------------------------------------------------------------

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

function corsHeaders(origin) {
  return origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      }
    : {};
}

const json = (status, body, origin, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...corsHeaders(origin), ...extra },
  });

const fail = (status, message, type, origin, extra) => json(status, { message, error_type: type }, origin, extra);

// Only browser extensions may call; when ALLOWED_ORIGINS is set (the store
// extension IDs), only those. Origins can be forged outside a browser, so this
// is a first filter; the fixed templates and rate limits do the real work.
function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") ?? "";
  if (!origin.startsWith("chrome-extension://")) return null;
  const pinned = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return pinned.length === 0 || pinned.includes(origin) ? origin : null;
}

const isText = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

// Returns [questions, state] or an error message.
function build(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Body moet een JSON-object zijn.";
  const extra = Object.keys(body).filter((k) => !["kind", "question", "state", "sentences", "court"].includes(k));
  if (extra.length) return `Onbekende velden: ${extra.slice(0, 3).join(", ")}.`;
  const { kind, question = "", state, sentences, court } = body;
  if (!Object.hasOwn(QUESTIONS, kind)) return "Onbekende soort beoordeling.";
  const needsQuestion = kind === "segment" || kind === "ruling";
  if (needsQuestion ? !isText(question, LIMITS.question) : typeof question !== "string" || question.length > LIMITS.question) {
    return `Rechtsvraag ontbreekt of is langer dan ${LIMITS.question} tekens.`;
  }
  if (court !== undefined && !(typeof court === "string" && COURTS.has(court))) return "Onbekende rechter.";
  if (!isText(state, LIMITS.state)) return `Tekst ontbreekt of is langer dan ${LIMITS.state} tekens.`;
  if (kind === "sentences") {
    if (!Array.isArray(sentences) || sentences.length < 2 || sentences.length > LIMITS.sentences) return "Onverwacht aantal zinnen.";
    if (!sentences.every((s) => isText(s, LIMITS.sentence))) return "Een zin ontbreekt of is te lang.";
  } else if (sentences !== undefined) {
    return "Zinnen horen alleen bij soort 'sentences'.";
  }
  const q = question.replace(/["\n\r]+/g, " ").trim();
  return [QUESTIONS[kind](q, sentences, court ?? "de rechter"), state];
}

async function readBody(request) {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > LIMITS.body) return null;
  const text = await request.text();
  if (text.length > LIMITS.body) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---- Rate limiting: exact counters in Durable Objects --------------------------------
// Cloudflare's rate-limit binding counts per location and approximately (tested:
// 400 rapid calls, none refused), so the hard caps live in Durable Objects: one
// per client (keyed by a salted hash of the IP, never the IP itself) and one
// global. Counters are in memory only, bucketed per second; nothing is stored.

const PER_CLIENT = [
  { limit: 300, ms: 10_000 },
  { limit: 1_200, ms: 60_000 },
];
const GLOBAL = [{ limit: 12_000, ms: 60_000 }];

export class Limiter extends DurableObject {
  buckets = new Map(); // second -> count

  take(windows) {
    const now = Math.floor(Date.now() / 1000);
    const horizon = Math.max(...windows.map((w) => w.ms)) / 1000;
    for (const sec of this.buckets.keys()) if (sec <= now - horizon) this.buckets.delete(sec);
    for (const w of windows) {
      let n = 0;
      for (const [sec, count] of this.buckets) if (sec > now - w.ms / 1000) n += count;
      if (n >= w.limit) return false;
    }
    this.buckets.set(now, (this.buckets.get(now) ?? 0) + 1);
    return true;
  }
}

async function clientKey(ip, salt) {
  const bytes = new TextEncoder().encode(`${salt}|${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rateLimited(env, ip) {
  const client = env.LIMITER.get(env.LIMITER.idFromName(`c:${await clientKey(ip, env.RL_SALT ?? "")}`));
  const global = env.LIMITER.get(env.LIMITER.idFromName("global"));
  const [okClient, okGlobal] = await Promise.all([client.take(PER_CLIENT), global.take(GLOBAL)]);
  return !(okClient && okGlobal);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (url.pathname === "/health" && request.method === "GET") return json(200, { ok: true }, origin);
    if (url.pathname !== "/v1/judge") return fail(404, "Niet gevonden.", "not_found", origin);
    if (request.method === "OPTIONS") {
      return origin ? new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...corsHeaders(origin) } }) : fail(403, "Niet toegestaan.", "forbidden", null);
    }
    if (request.method !== "POST") return fail(405, "Alleen POST.", "method", origin);
    if (!origin) return fail(403, "Alleen voor de Leeswijzer-extensie.", "forbidden", null);
    if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) return fail(415, "Verwacht JSON.", "invalid_request", origin);

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (await rateLimited(env, ip)) {
      return fail(429, "Even rustig aan: te veel verzoeken. Probeer het zo opnieuw.", "rate_limited", origin, { "Retry-After": "10" });
    }

    const body = await readBody(request);
    if (body === null) return fail(413, "Verzoek is te groot.", "too_large", origin);
    const built = body === undefined ? "Body moet JSON zijn." : build(body);
    if (typeof built === "string") return fail(400, built, "invalid_request", origin);
    const [questions, state] = built;

    let upstream;
    try {
      upstream = await fetch(GATEWAY, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.AI_GATEWAY_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          state,
          questions,
          providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
        }),
      });
    } catch {
      return fail(502, "Jev is even niet bereikbaar.", "upstream", origin);
    }
    if (!upstream.ok) {
      // 429/503 are the gateway shedding a burst: tell the client to retry.
      const busy = upstream.status === 429 || upstream.status === 503;
      return fail(busy ? 429 : 502, "Jev is even niet bereikbaar.", busy ? "busy" : "upstream", origin, busy ? { "Retry-After": "1" } : {});
    }
    const data = await upstream.json().catch(() => ({}));
    return json(200, { answers: data.answers ?? {} }, origin);
  },
};
