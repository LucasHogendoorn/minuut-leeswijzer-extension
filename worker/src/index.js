import { DurableObject } from "cloudflare:workers";
import { DailyCounters, count, drain, restore, statsResponse, today, versionLabel } from "./stats.js";
import { answerKey, readAnswers, storable, templateId, writeAnswer } from "./cache.js";
import { LEASE_MAX, Leases, RefusedClients, TokenBuckets, Windows, clientNet, hashKey, readLimited } from "./limits.js";

// Minuut Leeswijzer: Cloudflare Worker in front of Jev (Vercel AI Gateway).
//
// Free for everyone: the Worker holds Minuut's AI Gateway key as a secret
// (env.AI_GATEWAY_API_KEY), so users need no key and the key never reaches a
// browser. Abuse is contained by design rather than by trust:
//   - the typed questions Jev answers are built HERE, from fixed templates; a
//     client only picks one of four kinds and supplies the legal question
//     (optional for "core") and the public ruling text, so the endpoint cannot be used to ask Jev
//     anything else; EU case law picks a template set per language ("nl" or
//     "en", a closed field), never free text;
//   - strict size limits on every field and on the raw body;
//   - per-client rate limits (burst and per minute; exact in Durable Objects,
//     with free in-isolate checks in front) plus a global limit on Jev calls per
//     minute and per day that caps spend if many IPs join in (see "Rate
//     limiting" below and src/limits.js);
//   - only browser-extension origins, optionally pinned to the store IDs in
//     env.ALLOWED_ORIGINS.
//
// Privacy: the lawyer's question and the IP are never stored or logged.
// Every call goes to the gateway with zero data retention forced on, restricted
// to TypeSafe AI; `observability` is disabled in wrangler.toml. Responses carry
// only Jev's answers, never usage, routing, cost or upstream error bodies.
// One exception, by design: calls WITHOUT a question are about public ruling
// text only, so Jev's answer to those is kept in D1 (see "Shared cache" and
// src/cache.js) and served to the next reader of the same ruling instead of
// asking Jev again.
// Usage is counted, anonymously: per day, how many installs are active and how
// many judgements, cache hits and refusals there are, as bare numbers without
// any question, text, ECLI, IP or ID (see src/stats.js).

const GATEWAY = "https://ai-gateway.vercel.sh/v1/evaluate";
const MODEL = "typesafe-ai/jev";
// Development only: `wrangler dev` may point at a local mock gateway through
// DEV_GATEWAY_URL in worker/.dev.vars. Only loopback URLs are accepted, so the
// variable can never send production traffic anywhere but GATEWAY.
const gatewayUrl = (env) => (/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(env.DEV_GATEWAY_URL ?? "") ? env.DEV_GATEWAY_URL : GATEWAY);

const LIMITS = {
  body: 120_000, // bytes of raw JSON
  question: 500, // characters of the lawyer's question
  state: 30_000, // the gateway refuses (429) from roughly 30-40k characters
  sentences: 40,
  sentence: 1_500,
  // A "sentences" call: the r.o.'s sentences are the options of one choice and
  // `state` is only a header naming the r.o. and the ruling (src/jev.js,
  // MNT.sentenceState: at most ~700 characters with a 500-character question).
  // Its text therefore cannot be checked against `state`; instead the header is
  // kept short and the sentences together may not exceed what one r.o. sends
  // as `state` in a core or segment call, so a sentences call never carries
  // more text to Jev than any other call (security review 1, finding 4).
  sentenceState: 1_000,
  sentencesTotal: 24_000, // the extension stops adding sentences at 20,000
  // Everything a call carries to Jev: question + state + sentences.
  total: 31_000,
  // POST /v1/lookup: cached answers for up to 100 r.o.'s of one ruling at once.
  lookupBody: 512_000, // bytes; hashing and parsing this much stays well under 10 ms CPU
  lookupItems: 100,
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

// "Eigen oordeel" for the Dutch courts: their tested wording. EU case law has
// its own template sets below.
function ownQuestion(court) {
  return {
    instructions: `Geeft ${court} in deze passage zelf een oordeel of formuleert ${court} zelf een rechtsregel (maatstaf)?`,
    true: `${court} oordeelt, beslist of formuleert de regel die hij toepast, in eigen woorden`,
    false: "alleen feiten, standpunten of vorderingen van partijen, klachten of middelen, citaten, of wat een lagere rechter heeft overwogen of beslist (ook als die redenering hier wordt weergegeven)",
  };
}

const QUESTIONS = {
  // One rechtsoverweging: does it touch the question, what kind is it, how useful.
  // One rechtsoverweging. Two sharp yes/no questions instead of one broad
  // "does it touch the question" (tested on 28 r.o.'s: the broad version marked
  // party claims and the lower court's ruling as core).
  segment: (q) => {
    const court = "de rechter";
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
    return {
      eigen: {
        type: "boolean",
        instructions: own.instructions,
        criteria: { true: own.true, false: own.false },
      },
      dragend: {
        type: "boolean",
        instructions: "Draagt deze passage de beslissing: formuleert zij de maatstaf waarop de uitkomst berust, of past zij die maatstaf toe op deze zaak?",
        criteria: {
          true: "de uitkomst rust op deze maatstaf of op deze toepassing ervan (ratio decidendi)",
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

// ---- EU case law: one template set per language --------------------------------------
// Judgments of the Court of Justice and the General Court and opinions of the
// advocates general (Curia, EUR-Lex) are built differently from a Dutch ruling:
// the question referred and its reformulation, the observations of governments
// and the Commission, quoted EU and national law, settled case law restated as
// the rule, the answer paragraph ("must be interpreted as ..."), the operative
// part. Each set describes those parts in the language of the page; the
// speaker is still the closed `court` value, named here in that language.
// Tuned on a hand-labelled set of 12 documents (6 NL, 6 EN).

const EU_SPEAKER = {
  nl: { "het Hof van Justitie": "het Hof", "het Gerecht": "het Gerecht", "de advocaat-generaal": "de advocaat-generaal", "de rechter": "de rechter" },
  en: { "het Hof van Justitie": "the Court", "het Gerecht": "the General Court", "de advocaat-generaal": "the Advocate General", "de rechter": "the court" },
};

const EU_ROLES = {
  nl: {
    kader: "juridisch kader: de regel in algemene termen: aangehaalde of weergegeven bepalingen van Unierecht, overwegingen van een richtlijn of verordening, nationaal recht, of vaste rechtspraak van het Hof die in algemene bewoordingen wordt herhaald, los van de feiten van deze zaak",
    toepassing: "toepassing: het Hof, het Gerecht of de advocaat-generaal past de regel toe op de verwezen situatie, de nationale regeling, de tekens, de documenten of het bestreden besluit en trekt daaruit een conclusie; ook de alinea die het antwoord op een prejudiciële vraag geeft („moet aldus worden uitgelegd dat ...”) of over een middel oordeelt („het middel moet worden aanvaard”, „het besluit moet nietig worden verklaard”)",
    obiter: "ten overvloede of terzijde: een bevestiging („hoe dan ook”, „bovendien geldt”), een kanttekening voor andere gevallen, een opmerking over iets waar de verwijzende rechter niet om heeft gevraagd; niet nodig voor het antwoord",
    stellingen: "standpunten: wat verzoeker, verweerder, de regeringen, de Commissie, het EUIPO of een interveniënt aanvoert, betoogt of vordert; de conclusies van partijen, de middelen en argumenten; ook wanneer de advocaat-generaal ze samenvat",
    feiten: "feiten: het hoofdgeding, de gebeurtenissen, de overeenkomst, het besluit van de instantie, en wat de kamer van beroep of de instelling heeft vastgesteld of overwogen (weergegeven, niet beoordeeld)",
    proces: "procedure: het voorwerp van het verzoek (punt 1), het verloop van de nationale procedure en van de procedure voor het Hof of het Gerecht, de twijfels van de verwijzende rechter, de prejudiciële vragen zoals gesteld en de herformulering ervan („met zijn eerste vraag wenst de verwijzende rechter in wezen te vernemen ...”), bevoegdheid, ontvankelijkheid, de volgorde van behandeling, kosten, en de inleiding van een conclusie",
    beslissing: "dictum: het Hof „verklaart voor recht”, het Gerecht „verklaart en beslist” (vernietigt, verwerpt, verwijst in de kosten), of de slotconclusie van de advocaat-generaal met de antwoorden die hij het Hof in overweging geeft",
  },
  en: {
    kader: "legal framework: the rule in general terms: quoted or restated provisions of EU law, recitals of a directive or regulation, national law, or settled case-law of the Court restated in general words, apart from the facts of this case",
    toepassing: "application: the Court, the General Court or the Advocate General applies the rule to the situation referred, the national legislation, the signs, the documents or the contested decision and draws a conclusion from it; also the paragraph that gives the answer to a question referred ('must be interpreted as meaning that ...') or rules on a plea ('the plea must be upheld', 'the decision must be annulled')",
    obiter: "obiter: a corroborating aside ('in any event', 'moreover'), a caveat for other cases, a remark on something the referring court did not ask about; not needed for the answer",
    stellingen: "submissions: what the applicant, the defendant, the governments, the Commission, EUIPO or an intervener submits, argues or claims; the forms of order sought, the pleas in law and arguments; also as summarised by the Advocate General",
    feiten: "facts: the dispute in the main proceedings, the events, the contract, the decision of the authority, and what the Board of Appeal or the institution found or considered (recounted, not assessed)",
    proces: "procedure: the subject of the request (paragraph 1), the course of the national proceedings and of the procedure before the Court or the General Court, the referring court's doubts, the questions referred as worded and their reformulation ('by its first question, the referring court asks, in essence, ...'), jurisdiction, admissibility, the order of examination, costs, and the introduction of an opinion",
    beslissing: "operative part: the Court 'hereby rules', the General Court 'hereby' annuls, dismisses or orders costs, or the final conclusion of the Advocate General proposing the answers to the Court",
  },
};

const EU_TEXT = {
  nl: {
    own: (c, ag) => ({
      instructions: `Bevat deze passage een eigen overweging van ${c}: een oordeel, een uitlegging, een beoordeling of een regel die ${c} zelf formuleert of toepast?`,
      true: `${c} overweegt, oordeelt, legt uit, beoordeelt of concludeert zelf, ook wanneer ${ag ? "hij" : "het"} daarbij vaste rechtspraak herhaalt en toepast`,
      false: "alleen aangehaalde of weergegeven bepalingen, de feiten van het hoofdgeding, het verloop van de procedure, de prejudiciële vragen en hun herformulering, standpunten van partijen, regeringen, de Commissie of een instelling, wat de verwijzende rechter, de kamer van beroep of een lagere rechter heeft overwogen, of de aankondiging van wat hierna wordt onderzocht",
    }),
    bearing: (c, ag) => ({
      instructions: `Is deze passage een schakel in de redenering die tot ${ag ? "het antwoord dat de advocaat-generaal voorstelt" : `het antwoord of de beslissing van ${c}`} leidt: de regel of maatstaf waarop het antwoord berust, de toepassing daarvan op de verwezen situatie of het bestreden besluit, of de conclusie die daaruit wordt getrokken?`,
      true: "het antwoord op een vraag of het oordeel over een middel berust hierop: de maatstaf, de toepassing ervan, de gevolgtrekking („daaruit volgt”, „bijgevolg”, „moet aldus worden uitgelegd”, „het middel moet worden aanvaard”, „het besluit moet nietig worden verklaard”) of het dictum",
      false: "achtergrond die het antwoord niet gebruikt, een bevestiging ten overvloede („hoe dan ook”), een opmerking over een niet gestelde vraag, ontvankelijkheid, kosten, de aankondiging van de volgorde van behandeling, of alleen een samenvatting",
    }),
    substance: {
      instructions: "Gaat deze passage over de inhoud van de zaak: de uitlegging van het Unierecht, de toetsing van de nationale regeling of van het bestreden besluit, of de beoordeling van een middel?",
      true: "materieel: wat het Unierecht inhoudt en wat dat betekent voor de verwezen situatie, de nationale regeling, het bestreden besluit of het gevorderde (ook de vernietiging, herziening of afwijzing zelf)",
      false: "procedureel: bevoegdheid, ontvankelijkheid, het verloop van de procedure, de volgorde van behandeling, proceskosten, of een aankondiging van wat volgt",
    },
    role: "Wat voor passage is dit binnen het arrest of de conclusie?",
    topic: (q, c) => ({
      instructions: `Gaat deze passage over dezelfde juridische kwestie als de rechtsvraag? Rechtsvraag: "${q}"`,
      true: `de passage gaat precies over deze kwestie: de Unierechtelijke regel die erop ziet, de feiten of de nationale regeling die voor deze kwestie beslissend zijn, of wat partijen, regeringen, de Commissie, de verwijzende rechter of ${c} daarover zeggen`,
      false: "een andere prejudiciële vraag, een ander middel, of alleen procedure, ontvankelijkheid, kosten of algemene achtergrond, ook als dezelfde partijen of woorden voorkomen",
    }),
    answer: (q, c) => ({
      instructions: `Geeft ${c} in deze passage zelf (een deel van) het antwoord op de rechtsvraag: de maatstaf die ${c} daarvoor hanteert, de toepassing ervan, of het antwoord zelf? Rechtsvraag: "${q}"`,
      true: `een eigen overweging van ${c} die deze rechtsvraag geheel of ten dele beantwoordt: de regel, de toepassing of het antwoord („moet aldus worden uitgelegd dat ...”)`,
      false: "aangehaalde bepalingen, feiten, de vraag zoals gesteld of geherformuleerd, standpunten van partijen, regeringen of de Commissie, wat de verwijzende rechter of de kamer van beroep meent, of een overweging over een andere vraag",
    }),
    ruling: (q) => ({
      instructions: `Behandelt dit arrest of deze conclusie de volgende rechtsvraag, zodat een advocaat het stuk moet lezen? Rechtsvraag: "${q}"`,
      true: "het Hof, het Gerecht of de advocaat-generaal beoordeelt deze vraag of een wezenlijk onderdeel ervan, ook als het antwoord de vraag maar voor een deel dekt",
      false: "het stuk gaat over iets anders of noemt het onderwerp alleen terloops",
    }),
    sentence: (q) =>
      q
        ? "Welke zin uit dit punt beantwoordt de rechtsvraag het meest direct (de overweging of de maatstaf, niet de feiten of een aangehaalde bepaling)?"
        : "Welke zin uit dit punt bevat de kern van de overweging (het oordeel, de uitlegging of de maatstaf waarop het antwoord berust, niet de feiten of een aangehaalde bepaling)?",
  },
  en: {
    own: (c, ag) => ({
      instructions: `Does this passage contain ${c}'s own reasoning: a finding, an interpretation, an assessment or a rule that ${c} itself states or applies?`,
      true: `${c} itself reasons, finds, interprets, assesses or concludes, including where ${ag ? "he or she" : "it"} restates and applies settled case-law`,
      false: "only quoted or restated provisions, the facts of the main proceedings, the course of the procedure, the questions referred and their reformulation, submissions of the parties, governments, the Commission or an institution, what the referring court, the Board of Appeal or a lower court considered, or an announcement of what will be examined next",
    }),
    bearing: (c, ag) => ({
      instructions: `Is this passage a step in the reasoning that leads to ${ag ? "the answer the Advocate General proposes" : `${c}'s answer or ruling`}: the rule or test on which the answer rests, its application to the situation referred or the contested decision, or the conclusion drawn from it?`,
      true: "the answer to a question or the ruling on a plea rests on this: the test, its application, the inference ('it follows', 'consequently', 'must be interpreted as meaning', 'the plea must be upheld', 'the decision must be annulled') or the operative part",
      false: "background the answer does not use, a corroborating aside ('in any event'), a remark on a question not referred, admissibility, costs, an announcement of the order of examination, or a mere summary",
    }),
    substance: {
      instructions: "Is this passage about the substance of the case: the interpretation of EU law, the review of the national legislation or of the contested decision, or the assessment of a plea?",
      true: "substantive: what EU law means and what that entails for the situation referred, the national legislation, the contested decision or the form of order sought (including the annulment, alteration or dismissal itself)",
      false: "procedural: jurisdiction, admissibility, the course of the procedure, the order of examination, costs, or an announcement of what follows",
    },
    role: "What kind of passage is this within the judgment or opinion?",
    topic: (q, c) => ({
      instructions: `Is this passage about the same legal issue as the question? Question: "${q}"`,
      true: `the passage deals with precisely this issue: the rule of EU law that governs it, the facts or national legislation decisive for it, or what the parties, governments, the Commission, the referring court or ${c} say about it`,
      false: "another question referred, another plea, or only procedure, admissibility, costs or general background, even where the same parties or words appear",
    }),
    answer: (q, c) => ({
      instructions: `Does ${c} itself give (part of) the answer to the question in this passage: the test ${c} applies for it, its application, or the answer itself? Question: "${q}"`,
      true: `${c}'s own reasoning that answers this question in whole or in part: the rule, its application or the answer ('must be interpreted as meaning that ...')`,
      false: "quoted provisions, facts, the question as referred or reformulated, submissions of the parties, governments or the Commission, the view of the referring court or the Board of Appeal, or reasoning on another question",
    }),
    ruling: (q) => ({
      instructions: `Does this judgment or opinion deal with the following question, so that a lawyer should read it? Question: "${q}"`,
      true: "the Court, the General Court or the Advocate General rules on this question or on an essential part of it, even where the answer covers the question only in part",
      false: "the document is about something else or mentions the subject only in passing",
    }),
    sentence: (q) =>
      q
        ? "Which sentence of this paragraph answers the question most directly (the reasoning or the test, not the facts or a quoted provision)?"
        : "Which sentence of this paragraph carries the core of the reasoning (the finding, the interpretation or the test on which the answer rests, not the facts or a quoted provision)?",
  },
};

function euQuestions(lang) {
  const T = EU_TEXT[lang];
  const roles = EU_ROLES[lang];
  const name = (court) => EU_SPEAKER[lang][court] ?? EU_SPEAKER[lang]["de rechter"];
  const rol = { type: "choice", instructions: T.role, criteria: roles };
  return {
    core: (_q, _sentences, court) => {
      const c = name(court);
      const ag = court === ADVISER;
      const own = T.own(c, ag);
      const bearing = T.bearing(c, ag);
      return {
        eigen: { type: "boolean", instructions: own.instructions, criteria: { true: own.true, false: own.false } },
        dragend: { type: "boolean", instructions: bearing.instructions, criteria: { true: bearing.true, false: bearing.false } },
        inhoud: { type: "boolean", instructions: T.substance.instructions, criteria: { true: T.substance.true, false: T.substance.false } },
        rol,
      };
    },
    segment: (q, _sentences, court) => {
      const c = name(court);
      const topic = T.topic(q, c);
      const answer = T.answer(q, c);
      return {
        onderwerp: { type: "boolean", instructions: topic.instructions, criteria: { true: topic.true, false: topic.false } },
        antwoord: { type: "boolean", instructions: answer.instructions, criteria: { true: answer.true, false: answer.false } },
        rol,
      };
    },
    ruling: (q) => {
      const r = T.ruling(q);
      return { over: { type: "boolean", instructions: r.instructions, criteria: { true: r.true, false: r.false } } };
    },
    sentences: (q, sentences) => ({
      zin: { type: "choice", instructions: T.sentence(q), criteria: Object.fromEntries(sentences.map((s, i) => [`z${i + 1}`, s])) },
    }),
  };
}

// The closed `lang` field picks one of these; anything else is refused.
const EU_QUESTIONS = { nl: euQuestions("nl"), en: euQuestions("en") };

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

// Returns { questions, state, template } or an error message. `template`
// names the question set without the text-dependent parts, for the cache.
function build(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Body moet een JSON-object zijn.";
  const extra = Object.keys(body).filter((k) => !["kind", "question", "state", "sentences", "court", "lang"].includes(k));
  if (extra.length) return `Onbekende velden: ${extra.slice(0, 3).join(", ")}.`;
  const { kind, question = "", state, sentences, court, lang } = body;
  if (!Object.hasOwn(QUESTIONS, kind)) return "Onbekende soort beoordeling.";
  if (lang !== undefined && !Object.hasOwn(EU_QUESTIONS, lang)) return "Onbekende taal.";
  if (lang !== undefined && court !== undefined && !(EU_COURTS.has(court) || court === ADVISER)) return "Taal hoort alleen bij Europese rechtspraak.";
  const needsQuestion = kind === "segment" || kind === "ruling";
  if (needsQuestion ? !isText(question, LIMITS.question) : typeof question !== "string" || question.length > LIMITS.question) {
    return `Rechtsvraag ontbreekt of is langer dan ${LIMITS.question} tekens.`;
  }
  if (court !== undefined && !(typeof court === "string" && COURTS.has(court))) return "Onbekende rechter.";
  if (!isText(state, kind === "sentences" ? LIMITS.sentenceState : LIMITS.state)) return `Tekst ontbreekt of is te lang.`;
  if (kind === "sentences") {
    if (!Array.isArray(sentences) || sentences.length < 2 || sentences.length > LIMITS.sentences) return "Onverwacht aantal zinnen.";
    if (!sentences.every((s) => isText(s, LIMITS.sentence))) return "Een zin ontbreekt of is te lang.";
    if (sentences.reduce((n, s) => n + s.length, 0) > LIMITS.sentencesTotal) return "De zinnen zijn samen te lang.";
  } else if (sentences !== undefined) {
    return "Zinnen horen alleen bij soort 'sentences'.";
  }
  if (question.length + state.length + (sentences ?? []).reduce((n, s) => n + s.length, 0) > LIMITS.total) return "Verzoek is te lang.";
  const q = question.replace(/["\n\r]+/g, " ").trim();
  // EU case law (a `lang`, or an EU speaker from a client that predates `lang`)
  // gets the EU templates in the page's language; the Dutch courts keep theirs.
  const eu = lang !== undefined || EU_COURTS.has(court) || court === ADVISER;
  const set = eu ? EU_QUESTIONS[lang ?? "nl"] : QUESTIONS;
  const speaker = court ?? "de rechter";
  return {
    questions: set[kind](q, sentences, speaker),
    state,
    // Only "core" names the court in its questions among the cached kinds.
    template: { kind, lang: eu ? (lang ?? "nl") : "", court: kind === "core" ? speaker : "", blank: () => set[kind]("", [], speaker) },
  };
}


// Parses a request body read with readLimited: the JSON value, or undefined.
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const tooLarge = (origin) => fail(413, "Verzoek is te groot.", "too_large", origin);
const lengthRequired = (origin) => fail(411, "Content-Length ontbreekt.", "length_required", origin);
const bodyError = (status, origin) => (status === 411 ? lengthRequired(origin) : tooLarge(origin));

// ---- Shared cache: answers about public text only ------------------------------------
// Only calls without a question are cached: their input is the public ruling text
// and the Worker's own template, nothing the user typed. The key hashes exactly
// what goes to Jev (model, built questions, state), so any template change starts
// a fresh cache by itself. Only answers the Worker got from Jev are written, so a
// client cannot plant answers for text it did not send, and only when they have
// exactly the shape the questions ask for (src/cache.js, storable). Storage,
// keys, codec and costs: src/cache.js. A D1 error (for instance the daily quota)
// is a miss and never fails a call; it is counted as cache:error.

const isCacheable = (env, body) => Boolean(env.DB) && !(body.question ?? "").trim() && (body.kind === "core" || body.kind === "sentences");

// The template fingerprint per question set; a handful per isolate.
const templates = new Map();
function templateOf(template) {
  const name = `${template.kind}|${template.lang}|${template.court}`;
  if (!templates.has(name)) templates.set(name, templateId(MODEL, JSON.stringify(template.blank())));
  return templates.get(name);
}

async function cacheSlot(built) {
  const [tpl, key] = await Promise.all([templateOf(built.template), answerKey(MODEL, JSON.stringify(built.questions), built.state)]);
  return { tpl, key, template: { kind: built.template.kind, lang: built.template.lang, court: built.template.court, model: MODEL } };
}

function storeAnswer(env, ctx, slot, answers, replace) {
  ctx.waitUntil(writeAnswer(env.DB, slot.tpl, slot.key, answers, slot.template, today(), replace).catch(() => count("cache:error")));
}

// ---- Rate limiting ---------------------------------------------------------------------
// Layers, cheapest first; a request only reaches a Durable Object after all the
// free checks passed (path, method, Origin, Content-Type, Content-Length, body
// size, JSON and fields):
//   1. negative cache (src/limits.js, RefusedClients): a client key the
//      Durable Object refused gets its 429 from isolate memory until its
//      Retry-After is over. No Durable Object request.
//   2. token bucket per client key per isolate (TokenBuckets): the same budget
//      as the Durable Object's judge limit, approximate. Stops a flood inside one
//      isolate. No Durable Object request.
//   3. the exact per-client limit in a Durable Object (Limiter.take), one
//      object per client key. A judge call may get a small lease of extra
//      tokens (Leases) for the same client's next calls in this isolate.
//   4. the global limit: no longer a Durable Object call per request. Each
//      isolate reports its anonymous counts and its number of Jev calls to the
//      global object at most once per REPORT_MS (Limiter.report); the answer
//      says whether Jev calls must pause (over GLOBAL). Approximate by up to
//      REPORT_MS per isolate, which is fine for a spend cap.
// Cloudflare's rate-limit binding is not used: its docs do not say it exists on
// the Free plan, it counts per location and "eventually consistent, and
// intentionally designed to not be used as an accurate accounting system"
// (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
// an earlier test here refused none of 400 rapid calls, and the zone's WAF
// rate-limiting rule on leeswijzer-api.minuut.eu (CONTRIBUTING.md) already
// drops per-IP floods before the Worker runs.
//
// Clients: one IPv4 address, or one IPv6 /64 (/48 for the daily ping), hashed
// with RL_SALT (src/limits.js, clientNet). An office behind one NAT address is
// one client, so the limits leave room for several heavy readers at once.
//
// Sizing, measured 2026-09-28 with the 1.1 extension in Chrome for Testing
// against `wrangler dev` and a mock Jev answering in 300-500 ms (real Jev read
// 101 punten in 8.4 s, the mock in ~9.5 s), through a logging proxy:
//   EUR-Lex CELEX:62012CJ0131, 101 punten, cold, scrolled to the end:
//     lookups of 100 + 1 items, then 101 core + 28 sentences judge calls;
//     judge calls: at most 122 in any 10 s, 129 in any 60 s.
//   The same ruling warm (all in the shared cache): lookups of 100 + 1 + 28
//     items within a second, no judge call.
//   Haviltex (14 r.o.'s) cold: 14 items and 17 judge calls; with a question: 20.
//   "Open de beste 25" from 50 search results with a question, first five
//     tabs viewed: 50 ruling calls for the list, then 18 ruling + 359 segment +
//     91 sentences calls: at most 151 judge calls in any 10 s and 518 in any
//     60 s. This is an upper bound: the test browser (Playwright) reports every
//     tab as visible, so all 25 tabs read at once; in Chrome, background tabs
//     wait until they are viewed.
// CALLS allows about twice the worst 10 s and 1.7 times the worst minute of
// that upper bound for one reader, so two or three lawyers behind one office
// address can each open a cold 101-punt ruling in the same minute without a
// 429. Lower than before (1,200/min), and lookups have their own budget
// (ITEMS), so reading from the cache no longer eats into the Jev budget.
// What one client can still do: 900 Jev calls/min, so a single address at the
// cap could use up the Free plan's 100,000 Workers requests in about 111
// minutes; the zone WAF rule and the global daily cap are the backstops, and
// only Workers Paid removes the class (review 1, "Structural").
//
// Durable Object requests (Free plan: 100,000/day; every RPC call is one),
// counted in `wrangler dev` for the cold EUR-Lex ruling above (131 API calls):
//   before: 269 (2 per judge or lookup call: client take + global take, also
//     when refused; 2 per ping; stats alarms up to 17,280/day). Warm: 11.
//   now: 18 (14 client takes, thanks to leases; 2 global reports; 2 pings).
//     Warm: 6. A refused flood: 3,000 calls from one address cost 35 (before:
//     6,000). Per call at most 1 (client take), 0 when refused from memory;
//     plus 1 report per isolate per 10 s while there is something to report,
//     plus at most 8,640 stats alarms/day (FLUSH_MS in src/stats.js).
// So on the Free plan the Workers requests (100,000/day, ~140 per cold
// 101-punt ruling including preflights) bind before Durable Objects do.
const CALLS = [
  { limit: 300, ms: 10_000 },
  { limit: 900, ms: 60_000 },
];
// Lookup items (D1 reads, never Jev): a warm 101-punt ruling looks up 101 core
// items and then up to one sentences item per relevant punt, ~200 at once.
const ITEMS = [
  { limit: 600, ms: 10_000 },
  { limit: 1_800, ms: 60_000 },
];
// Extension 1.0.x calls the workers.dev host with /v1/judge only (no lookup,
// no ping, Rechtspraak.nl only; a cold 101-r.o. ruling is ~115 calls in 10 s).
// Tighter, and gone when workers_dev is switched off (CONTRIBUTING.md).
const LEGACY_CALLS = [
  { limit: 200, ms: 10_000 },
  { limit: 600, ms: 60_000 },
];
// The isolate's token bucket for API requests of one client key: the same
// budget as CALLS (300 at once, 900/min), so it never refuses what the
// Durable Object would allow.
const buckets = new TokenBuckets({ capacity: 300, perSecond: 15 });
const refused = new RefusedClients();
const leases = new Leases();

// Jev calls for everyone together, the spend cap. On the Free plan the daily
// cap sits just below the 100,000 Workers requests a day (each Jev call is one
// request, plus lookups, preflights and pings); on Workers Paid it is the
// ceiling that stops a runaway bill.
// 3,000/min is ~23 cold 101-punt rulings starting in the same minute (129 calls
// each); 80,000/day is ~600 of them, or ~4,000 Rechtspraak rulings read with a
// question at ~20 calls each. Before: 12,000/min and no daily cap.
const GLOBAL = { perMinute: 3_000, perDay: 80_000 };
const REPORT_MS = 10_000;

// The daily ping per /48 (or IPv4 address) per Amsterdam day: one "active"
// and three "install". The day is kept in the ping Limiter's storage, so an
// evicted object does not forget it. An office behind one address is therefore
// counted as one active network per day, not per install.
const PING = { active: 1, install: 3 };

export class Limiter extends DurableObject {
  windows = new Windows();
  minute = new Map(); // global object: second -> Jev calls
  day = null; // global object: { day, calls }

  constructor(ctx, env) {
    super(ctx, env);
    this.counters = new DailyCounters(ctx);
  }

  // Per client. `weight`: how many tokens this request needs; `extra`: a lease
  // for the client's next judge calls, granted as far as there is room.
  // Returns { granted, retryAfter }.
  take(windows, weight = 1, extra = 0) {
    return this.windows.take(windows, weight, Math.min(extra, LEASE_MAX));
  }

  // Global object only: the anonymous daily counts and the number of Jev calls
  // an isolate made since its last report. Returns { shed } (pause Jev calls).
  report(counts, calls = 0) {
    if (counts) this.counters.add(counts);
    const now = Math.floor(Date.now() / 1000);
    const day = today();
    if (this.day?.day !== day) this.day = { day, calls: this.counters.read(1)[0]?.counters["jev:calls"] ?? 0 };
    else if (counts?.[day]?.["jev:calls"]) this.day.calls += counts[day]["jev:calls"];
    const n = Number.isInteger(calls) && calls > 0 ? Math.min(calls, 1_000_000) : 0;
    if (n) this.minute.set(now, (this.minute.get(now) ?? 0) + n);
    let perMinute = 0;
    for (const [sec, c] of this.minute) {
      if (sec < now - 60) this.minute.delete(sec); // inclusive, as in Windows
      else perMinute += c;
    }
    return { shed: perMinute > GLOBAL.perMinute || this.day.calls >= GLOBAL.perDay };
  }

  // Ping object only (one per /48): may this ping be counted today?
  ping(event, day) {
    const kv = this.ctx.storage.kv;
    const seen = kv.get("ping");
    const row = seen?.day === day ? seen : { day, active: 0, install: 0 };
    if (!Object.hasOwn(PING, event) || row[event] >= PING[event]) return false;
    row[event]++;
    kv.put("ping", row);
    return true;
  }

  alarm() {
    this.counters.flush();
  }

  stats(days, counts) {
    if (counts) this.counters.add(counts);
    return this.counters.read(days);
  }
}

const globalLimiter = (env) => env.LIMITER.get(env.LIMITER.idFromName("global"));
const clientKey = (request, env, prefix = 64) => hashKey(clientNet(request.headers.get("CF-Connecting-IP") ?? "unknown", prefix), env.RL_SALT ?? "");

// Any Durable Object failure (the daily quota, an overloaded object) becomes a
// clean 503 with CORS and a long Retry-After, never an uncaught error page.
class Unavailable extends Error {}
async function durable(call) {
  try {
    return await call();
  } catch {
    count("refused:unavailable");
    throw new Unavailable();
  }
}
const unavailable = (origin) => fail(503, "Leeswijzer is even niet beschikbaar.", "unavailable", origin, { "Retry-After": "3600" });
const tooMany = (origin, seconds) =>
  fail(429, "Even rustig aan: te veel verzoeken. Probeer het zo opnieuw.", "rate_limited", origin, { "Retry-After": String(Math.max(1, seconds)) });

// Checks one client against layers 1-3. `budget` names the Durable Object
// (and its windows): "c" judge calls, "i" lookup items, "l" legacy judge calls.
// Returns 0 when allowed, otherwise the seconds to send in Retry-After.
const BUDGETS = { c: CALLS, i: ITEMS, l: LEGACY_CALLS };
async function limit(env, key, budget, weight = 1) {
  const name = `${budget}:${key}`;
  const wait = refused.check(name) || buckets.take(key);
  if (wait) {
    count("refused:rate_limit");
    return wait;
  }
  const leased = budget !== "i";
  if (leased && leases.spend(name)) return 0;
  const stub = env.LIMITER.get(env.LIMITER.idFromName(name));
  const extra = leased ? leases.want(name) : 0;
  let result;
  try {
    result = await durable(() => stub.take(BUDGETS[budget], weight, extra));
  } catch (err) {
    if (extra) leases.drop(name);
    throw err;
  }
  const { granted, retryAfter } = result;
  if (granted >= weight) {
    if (leased) leases.grant(name, granted - weight, extra > 0);
    return 0;
  }
  leases.drop(name);
  refused.refuse(name, retryAfter);
  count("refused:rate_limit");
  return retryAfter;
}

// ---- Global report -----------------------------------------------------------------------
let jevCalls = 0; // Jev calls since the last report
let lastReport = 0;
let shedUntil = 0; // while Date.now() < shedUntil, Jev calls pause

function report(env, ctx) {
  const now = Date.now();
  if (now - lastReport < REPORT_MS) return;
  const counts = drain();
  const calls = jevCalls;
  if (!counts && !calls) return;
  lastReport = now;
  jevCalls = 0;
  ctx.waitUntil(
    globalLimiter(env)
      .report(counts, calls)
      .then((r) => (shedUntil = r?.shed ? Date.now() + REPORT_MS : 0))
      .catch(() => {
        // Not delivered: keep the counts for the next report.
        restore(counts);
        jevCalls += calls;
      }),
  );
}

// ---- Ping ----------------------------------------------------------------------------------

const amsterdamDay = today;
function secondsToMidnight() {
  // Amsterdam is UTC+1 or +2; the next day starts within 24 h. Close enough to
  // stop asking the Durable Object again today, never longer than a day.
  const now = Date.now();
  for (let s = 3_600; s <= 86_400; s += 3_600) if (today(new Date(now + s * 1000)) !== today(new Date(now))) return s;
  return 86_400;
}

// POST /v1/ping {v, event}: one anonymous count per client network per day
// ("active", sent on the first ruling or search page of the day) or at install.
// The body is a version number and one of two words; nothing else is accepted or
// kept. A ping that is not counted (already counted today) still gets a 204:
// the extension never retries a ping.
async function ping(request, env, ctx, origin) {
  const read = await readLimited(request, 200);
  if (read.status) return bodyError(read.status, origin);
  const body = parseJson(read.text);
  const { v, event = "active" } = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const known = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((k) => k === "v" || k === "event");
  if (!known || !["active", "install"].includes(event)) return fail(400, "Onverwacht verzoek.", "invalid_request", origin);
  const noContent = () => new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...corsHeaders(origin) } });
  const key = await clientKey(request, env, 48);
  const name = `p:${event}:${key}`;
  if (refused.check(name) || buckets.take(`p:${key}`)) return noContent();
  const ok = await durable(() => env.LIMITER.get(env.LIMITER.idFromName(`p:${key}`)).ping(event, amsterdamDay()));
  if (!ok) {
    refused.refuse(name, secondsToMidnight());
    return noContent();
  }
  // Counted only now, after both checks allowed it.
  count(`${event === "install" ? "install" : "ping"}:${versionLabel(v)}`);
  report(env, ctx);
  return noContent();
}

// ---- Lookup --------------------------------------------------------------------------------

// POST /v1/lookup {kind, court?, lang?, items: [{state, sentences?}]}: the
// cached answers for many r.o.'s of one ruling in one request, null where
// nothing is cached. Cache only: it never calls Jev and never writes. Only the
// kinds asked without a question exist here, so no question field is accepted;
// each item is validated exactly like a judge call, and the answers returned are
// the ones a judge call with that item would return from the cache. A client
// only gets answers for text it sends itself. The cheap checks and the rate
// limit come before the items are built.
async function lookup(request, env, ctx, origin, key) {
  const read = await readLimited(request, LIMITS.lookupBody);
  if (read.status) return bodyError(read.status, origin);
  const body = parseJson(read.text);
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "Body moet een JSON-object zijn.", "invalid_request", origin);
  const { kind, court, lang, items } = body;
  if (Object.keys(body).some((k) => !["kind", "court", "lang", "items"].includes(k))) return fail(400, "Onbekende velden.", "invalid_request", origin);
  if (kind !== "core" && kind !== "sentences") return fail(400, "Onbekende soort beoordeling.", "invalid_request", origin);
  if (!Array.isArray(items) || items.length < 1 || items.length > LIMITS.lookupItems) return fail(400, "Onverwacht aantal passages.", "invalid_request", origin);

  const wait = await limit(env, key, "i", items.length);
  if (wait) return tooMany(origin, wait);

  const built = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((k) => k !== "state" && k !== "sentences")) {
      return fail(400, "Onverwachte passage.", "invalid_request", origin);
    }
    const b = build({ kind, state: item.state, sentences: item.sentences, court, lang });
    if (typeof b === "string") return fail(400, b, "invalid_request", origin);
    built.push(b);
  }
  count(`lookup:${kind}`);
  if (!env.DB) return json(200, { answers: items.map(() => null) }, origin);

  // One lookup has one kind, court and language, so one template.
  const slots = await Promise.all(built.map(cacheSlot));
  const answers = await readAnswers(
    env.DB,
    slots[0].tpl,
    slots.map((s) => s.key),
    built.map((b) => b.questions),
  ).catch(() => (count("cache:error"), items.map(() => null)));
  // Hits get their own counter; the judge counters count judge calls only.
  // Misses are counted by the judge call the client makes next.
  const hits = answers.filter(Boolean).length;
  if (hits) count("lookup:hit", hits);
  return json(200, { answers }, origin);
}

// Which template set a judgement used: Dutch courts, or EU case law per language.
const source = (body) => (body.lang ? `eu_${body.lang}` : EU_COURTS.has(body.court) || body.court === ADVISER ? "eu_nl" : "nl");

// ---- Judge ---------------------------------------------------------------------------------

async function judge(request, env, ctx, origin, key, legacy) {
  const read = await readLimited(request, LIMITS.body);
  if (read.status) return bodyError(read.status, origin);
  const body = parseJson(read.text);
  const built = body === undefined ? "Body moet JSON zijn." : build(body);
  if (typeof built === "string") return fail(400, built, "invalid_request", origin);
  // Extension 1.0.x reads Rechtspraak.nl only: no EU case law on the old host.
  if (legacy && source(body) !== "nl") return fail(400, "Onbekende rechter.", "invalid_request", origin);
  const { questions, state } = built;

  const wait = await limit(env, key, legacy ? "l" : "c");
  if (wait) return tooMany(origin, wait);
  // How much extension 1.0.x still calls the old host: when this stays at 0,
  // workers_dev can be switched off (CONTRIBUTING.md).
  if (legacy) count("legacy:judge");

  // A cache miss or a D1 hiccup just means asking Jev; it never fails the call.
  const slot = isCacheable(env, body) ? await cacheSlot(built) : null;
  let replace = false;
  if (slot) {
    const invalid = new Set();
    const [hit] = await readAnswers(env.DB, slot.tpl, [slot.key], [questions], invalid).catch(() => (count("cache:error"), [null]));
    if (hit) {
      count("cache:hit");
      count(`judge:${body.kind}`);
      count(`src:${source(body)}`);
      return json(200, { answers: hit }, origin);
    }
    replace = invalid.size > 0;
    count(replace ? "cache:invalid" : "cache:miss");
  }

  // Over the global limit: Jev calls pause; the extension does not retry a 503.
  if (Date.now() < shedUntil) {
    count("refused:global");
    return fail(503, "Leeswijzer is even erg druk. Probeer het over een minuut opnieuw.", "unavailable", origin, { "Retry-After": "60" });
  }

  let upstream;
  jevCalls++;
  count("jev:calls");
  try {
    upstream = await fetch(gatewayUrl(env), {
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
    count("upstream:error");
    return fail(502, "Jev is even niet bereikbaar.", "upstream", origin);
  }
  if (!upstream.ok) {
    // 429/503 are the gateway shedding a burst: tell the client to retry.
    const busy = upstream.status === 429 || upstream.status === 503;
    count(busy ? "upstream:busy" : "upstream:error");
    return fail(busy ? 429 : 502, "Jev is even niet bereikbaar.", busy ? "busy" : "upstream", origin, busy ? { "Retry-After": "1" } : {});
  }
  const data = await upstream.json().catch(() => ({}));
  const answers = data.answers ?? {};
  count(`judge:${body.kind}`);
  count(`src:${source(body)}`);
  if (slot && storable(answers, questions)) storeAnswer(env, ctx, slot, answers, replace);
  return json(200, { answers }, origin);
}

// ---- Routing -------------------------------------------------------------------------------
// Everything that can be refused without a Durable Object is refused first:
// unknown path or method, a missing or foreign Origin, a wrong Content-Type.
// /health never touches a Durable Object.
//
// Two hosts serve this Worker: leeswijzer-api.minuut.eu (extension 1.1 and
// later, behind the zone's WAF rate-limiting rule) and the workers.dev host
// that extension 1.0.x has built in. The workers.dev host only serves
// /v1/judge, Rechtspraak.nl only, with the tighter LEGACY_CALLS limits; it goes
// away when workers_dev is switched off (CONTRIBUTING.md).

const PATHS = new Set(["/v1/judge", "/v1/lookup", "/v1/ping"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const legacy = url.hostname.endsWith(".workers.dev");
    const origin = allowedOrigin(request, env);

    if (url.pathname === "/health" && request.method === "GET") return json(200, { ok: true }, origin);
    if (url.pathname === "/v1/stats" && !legacy) {
      try {
        return (await statsResponse(request, env, url, globalLimiter(env))) ?? fail(404, "Niet gevonden.", "not_found", null);
      } catch {
        return fail(503, "Even niet beschikbaar.", "unavailable", null, { "Retry-After": "60" });
      }
    }
    if (legacy ? url.pathname !== "/v1/judge" : !PATHS.has(url.pathname)) return fail(404, "Niet gevonden.", "not_found", origin);
    if (request.method === "OPTIONS") {
      return origin ? new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...corsHeaders(origin) } }) : fail(403, "Niet toegestaan.", "forbidden", null);
    }
    if (request.method !== "POST") return fail(405, "Alleen POST.", "method", origin);
    if (!origin) return fail(403, "Alleen voor de Leeswijzer-extensie.", "forbidden", null);
    if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) return fail(415, "Verwacht JSON.", "invalid_request", origin);

    try {
      if (url.pathname === "/v1/ping") return await ping(request, env, ctx, origin);
      const key = await clientKey(request, env);
      const response = url.pathname === "/v1/lookup" ? await lookup(request, env, ctx, origin, key) : await judge(request, env, ctx, origin, key, legacy);
      report(env, ctx);
      return response;
    } catch (err) {
      if (err instanceof Unavailable) return unavailable(origin);
      throw err;
    }
  },
};
