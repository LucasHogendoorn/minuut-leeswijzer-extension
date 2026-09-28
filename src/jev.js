// Minuut Leeswijzer: what we send to Jev and how we read its answers.
// Jev writes nothing. Per rechtsoverweging it returns a probability (does this
// touch the question?), a choice (which category is it?) and a score (how
// useful is it?). The question templates live in Minuut's Worker (not in this repo)
// so the free endpoint cannot be used for anything else; the extension only
// changes visibility and order.

var MNT = (globalThis.MNT = globalThis.MNT || {});

const MAX_SEGMENT_CHARS = 20000;
// The gateway answers 429 above roughly 30k characters of state (measured:
// 24k passes, 40k is refused), so the whole-ruling verdict reads the
// beoordeling first and stops at 20k.
const MAX_RULING_CHARS = 20000;
// Jev sheds load when many calls land at once (measured: 5 of 16 parallel
// calls got 503/429 straight from the gateway), so keep five in flight.
const CONCURRENCY = 5;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n[... ingekort]` : text);

MNT.segmentState = (meta, seg) =>
  [
    `Uitspraak: ${meta.ecli}${meta.instantie ? ` (${meta.instantie}${meta.datum ? `, ${meta.datum}` : ""})` : ""}`,
    seg.section ? `Onderdeel: ${seg.section}` : null,
    seg.nr ? `Rechtsoverweging ${seg.nr}:` : "Passage:",
    clip(seg.text, MAX_SEGMENT_CHARS),
  ]
    .filter(Boolean)
    .join("\n");

MNT.rulingState = (meta, text) =>
  [
    `Uitspraak: ${meta.ecli}`,
    meta.instantie && `Instantie: ${meta.instantie}`,
    meta.datum && `Datum: ${meta.datum}`,
    meta.rechtsgebieden && `Rechtsgebieden: ${meta.rechtsgebieden}`,
    meta.inhoudsindicatie && `Inhoudsindicatie: ${meta.inhoudsindicatie}`,
    text && `Tekst:\n${clip(text, MAX_RULING_CHARS)}`,
  ]
    .filter(Boolean)
    .join("\n");

class JevCallError extends Error {
  constructor({ code, message }) {
    super(message);
    this.code = code;
  }
}

// One judgement by the Worker. `kind` is "core" (one r.o., no question: is it a
// kernoverweging?), "segment" (one r.o. against the question), "ruling" (a
// whole ruling or one search hit against the question) or "sentences" (rank
// the sentences of one r.o.). The Worker holds the question templates; we send only the lawyer's
// question and the public text.
MNT.evaluate = async (kind, question, state, sentences, court) => {
  const request = { kind, question, state, ...(sentences ? { sentences } : {}), ...(court ? { court } : {}) };
  const res = await chrome.runtime.sendMessage({ type: "jev:evaluate", request });
  if (!res?.ok) throw new JevCallError(res?.error ?? { code: "unknown", message: "Geen antwoord van de extensie." });
  return res.data;
};

// Read Jev's answers defensively: only known categories, numbers in range.
const unit = (MNT.unit = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0));
MNT.readSegmentAnswers = (answers) => {
  const rol = answers?.rol ?? {};
  const role = Object.hasOwn(MNT.ROLE_LABEL, rol.choice) ? rol.choice : "feiten";
  return {
    relevant: unit(answers?.onderwerp?.probability), // same legal issue
    answer: unit(answers?.antwoord?.probability), // the court itself answers it
    role,
    roleConfidence: unit(rol.confidence ?? rol.probabilities?.[role]),
  };
};

// General mode: the three factors of a kernoverweging (worker: kind "core").
MNT.readCoreAnswers = (answers) => {
  const rol = answers?.rol ?? {};
  return {
    mode: "core",
    own: unit(answers?.eigen?.probability), // the court's own judgement or rule
    bearing: unit(answers?.dragend?.probability), // the outcome rests on it
    substance: unit(answers?.inhoud?.probability), // substance, not procedure
    role: Object.hasOwn(MNT.ROLE_LABEL, rol.choice) ? rol.choice : "feiten",
  };
};

// Who speaks in a ruling, for the core questions (a closed list in the Worker).
MNT.courtOf = (instantie = "") =>
  /Hoge Raad/i.test(instantie) ? "de Hoge Raad"
  : /Gerechtshof/i.test(instantie) ? "het hof"
  : /Centrale Raad van Beroep/i.test(instantie) ? "de Centrale Raad van Beroep"
  : /Raad van State/i.test(instantie) ? "de Raad van State"
  : /College van Beroep/i.test(instantie) ? "het College"
  : "de rechter";

// Run `task` over `items` with a fixed number of calls in flight. Stops early
// when `isCancelled()` turns true (a new question or a new ruling).
MNT.pool = async (items, task, isCancelled, concurrency = CONCURRENCY) => {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !isCancelled()) {
      const item = items[next++];
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
};

// ---- Sentences inside a relevant r.o. ----------------------------------------
// One extra call per relevant r.o., made only when it scrolls into view: the
// r.o.'s sentences become the options of a single `choice` question, and Jev's
// probability per option ranks the sentences. The text travels once (as the
// options), so this adds roughly the r.o.'s own size, never a second full pass.

const MAX_SENTENCES = 40;
const MAX_SENTENCE_CHARS = 1500;
// "art. 7:213 BW", "mr. Jansen", "r.o. 3.4", "vgl. HR" must not end a sentence.
const ABBREV = /(?:^|[\s(])(?:mr|art|artt|jo|vgl|nr|nrs|blz|p|pp|r\.o|rov|bijv|resp|prof|dr|o\.a|e\.a|i\.c|c\.q|t\.a\.v|m\.b\.t|z\.g|n\.v\.t|jl|lid|sub|ca|HR|EHRM|BW|Rv|Sr|Sv|Awb)\.$/i;

MNT.splitSentences = (text) => {
  const out = [];
  for (const para of text.split(/\n+/)) {
    let start = 0;
    const re = /[.!?;](?=["”’)]?\s+["“‘(]?[A-Z\[À-Ý])/g;
    let m;
    while ((m = re.exec(para))) {
      const end = m.index + 1;
      if (ABBREV.test(para.slice(Math.max(0, start), end))) continue;
      out.push(para.slice(start, end).trim());
      start = end;
    }
    out.push(para.slice(start).trim());
  }
  return out.filter((s) => s.length >= 12).slice(0, MAX_SENTENCES).map((s) => s.slice(0, MAX_SENTENCE_CHARS));
};

MNT.sentenceState = (meta, seg, question) =>
  `${question ? `Rechtsvraag van de advocaat: ${question}\n` : ""}De zinnen hieronder komen uit ${seg.nr ? `rechtsoverweging ${seg.nr}` : "een passage"} van ${meta.ecli}.`;

// Keep the sentence Jev picked, plus any that still carry real weight.
MNT.pickSentences = (answers, sentences) => {
  const probs = answers?.zin?.probabilities ?? {};
  return Object.entries(probs)
    .map(([k, p]) => ({ text: /^z\d+$/.test(k) ? sentences[Number(k.slice(1)) - 1] : undefined, p: unit(p) }))
    .filter((x) => x.text)
    .sort((a, b) => b.p - a.p)
    .filter((x, i) => i === 0 || x.p >= 0.12)
    .slice(0, 3);
};
