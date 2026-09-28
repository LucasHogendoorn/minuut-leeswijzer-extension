// Shared cache of Jev's answers about public ruling text, in D1 (SQLite).
//
// What is cached: only calls WITHOUT a question ("core" and "sentences" with
// an empty question). Their input is public ruling text plus the Worker's own
// templates, nothing the user typed. Only answers the Worker itself got from
// Jev are written; no endpoint accepts answers from a client.
//
// Schema (migrations/0001_answers.sql): one table clustered on (tpl, k),
// WITHOUT ROWID, no secondary index.
//   tpl  template fingerprint: 32 bits of SHA-256 over the model and the
//        questions as built for this kind, court and language (for "sentences"
//        with an empty sentence list). Rows of a retired template are one key
//        range, so they can be counted and deleted without a full scan.
//   k    first 16 bytes of SHA-256 over exactly what goes to Jev: model, the
//        built questions (for "sentences" those include the sentences) and the
//        state. Never the ECLI or anything about the reader. 128 bits: finding
//        a second text with the same key as a given one (to plant Jev's answer
//        for it on someone else's text) is a second preimage, ~2^128 work;
//        finding any two texts that collide is a birthday search, ~2^64 work,
//        and gains nothing (both would be texts the attacker chose). Accidental
//        collisions at 10^9 rows have probability ~1e-21.
//   v    one codec byte + deflate-raw of the answers JSON with a fixed preset
//        dictionary (CODEC_V1). Measured on 25 real cached answers: 259 bytes
//        of JSON become 48 bytes; a row takes ~87 bytes on disk instead of
//        ~350, which matters because a Free-plan database holds at most 500 MB.
//   A second table, templates, names each fingerprint (kind, lang, court,
//   model, first day seen) for the operator; it holds a few dozen rows.
//
// Cost, as D1 bills it (rows scanned / rows written, not bytes):
//   - point lookup: 1 row read on a hit, 0 on a miss;
//   - batch lookup: a VALUES list joined on the primary key, 1 row read per
//     hit, 0 per miss (an IN (...) list would also count one row per key for
//     SQLite's temporary lookup table: measured 70 rows for 40 keys, 30 hits);
//   - write: INSERT ... ON CONFLICT DO NOTHING, 1 row written, 0 when the row
//     already exists; no read before the write, safe under races.
//   No hit counters, no timestamps per row: a read never turns into a write,
//   and a row does not say when anyone read the ruling.
//
// Defence in depth: an answer is only written when it has exactly the shape the
// question set asks for (validAnswers) and its JSON is at most MAX_ANSWER_BYTES;
// the same check runs on every read, and a row that fails it reads as a miss
// (and is replaced by the next answer Jev gives for that key). Decompression
// stops at MAX_INFLATED bytes.

import { deflateRawSync, inflateRawSync } from "node:zlib";

// Keys per statement: D1 allows 100 bound parameters per query, one is tpl.
const KEYS_PER_STATEMENT = 99;
// Real answers are 100-800 bytes of JSON (a "sentences" answer with 40 options is
// the largest); anything bigger is not stored.
export const MAX_ANSWER_BYTES = 4_096;
const MAX_INFLATED = 64_000;

// ---- Keys --------------------------------------------------------------------------

const enc = new TextEncoder();
const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));

// The exact request body parts that go to Jev, in the order the Worker sends
// them, serialised once: `questionsJson` is JSON.stringify(questions).
export async function answerKey(model, questionsJson, state) {
  const digest = await sha256(`{"model":${JSON.stringify(model)},"questions":${questionsJson},"state":${JSON.stringify(state)}}`);
  return digest.slice(0, 16);
}

// Fingerprints are the same for every call with the same template: memoised.
const fingerprints = new Map();
export async function templateId(model, questionsJson) {
  let tpl = fingerprints.get(questionsJson);
  if (tpl === undefined) {
    const d = await sha256(`${model}\n${questionsJson}`);
    tpl = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0; // unsigned 32-bit
    fingerprints.set(questionsJson, tpl);
  }
  return tpl;
}

// ---- Values ------------------------------------------------------------------------
// Codec 1: deflate-raw with this dictionary: the recurring parts of Jev's
// answers (field names, choice keys). Changing the dictionary means a new codec
// byte; rows with an unknown codec read as a miss.

const CODEC_V1 = 1;
const DICTIONARY_V1 = enc.encode(
  '"probabilities":{"z1":0,"z2":0,"z3":0,"z4":0,"z5":0,"z6":0,"z7":0,"z8":0,"z9":0,"z10":0,"z11":0,"z12":0},"confidence":0.' +
    '{"zin":{"type":"choice","choice":"z{"onderwerp":{"type":"boolean","probability":0.{"antwoord":{"type":"boolean","probability":0.' +
    '{"eigen":{"type":"boolean","probability":0.},"dragend":{"type":"boolean","probability":0.},"inhoud":{"type":"boolean","probability":0.},' +
    '"rol":{"type":"choice","choice":"toepassing","probabilities":{"beslissing":0,"proces":0,"kader":0,"toepassing":0,"feiten":0,"stellingen":0,"obiter":0},"confidence":0.',
);

// ---- Shape ---------------------------------------------------------------------------
// `questions` is the question set as built for this call ({ name: { type,
// criteria } }). An answer is valid when it has exactly those names, and per
// name: boolean -> { probability: 0..1 }; choice -> { choice: one of the
// criteria, probabilities: { criterion: 0..1 } }. "type" (when present) must
// match, "confidence" (when present) must be 0..1; nothing else is allowed.
const isUnit = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function validAnswers(answers, questions) {
  if (!isPlain(answers) || !isPlain(questions)) return false;
  const names = Object.keys(questions);
  const keys = Object.keys(answers);
  if (keys.length !== names.length || !names.every((n) => Object.hasOwn(answers, n))) return false;
  for (const name of names) {
    const q = questions[name];
    const a = answers[name];
    if (!isPlain(a)) return false;
    if (a.type !== undefined && a.type !== q.type) return false;
    if (a.confidence !== undefined && !isUnit(a.confidence)) return false;
    if (q.type === "boolean") {
      if (!isUnit(a.probability) || Object.keys(a).some((k) => !["type", "probability", "confidence"].includes(k))) return false;
    } else if (q.type === "choice") {
      const allowed = q.criteria ?? {};
      if (typeof a.choice !== "string" || !Object.hasOwn(allowed, a.choice)) return false;
      if (!isPlain(a.probabilities) || !Object.entries(a.probabilities).every(([k, p]) => Object.hasOwn(allowed, k) && isUnit(p))) return false;
      if (Object.keys(a).some((k) => !["type", "choice", "probabilities", "confidence"].includes(k))) return false;
    } else return false;
  }
  return true;
}

// Valid and small enough to keep.
export const storable = (answers, questions) => validAnswers(answers, questions) && enc.encode(JSON.stringify(answers)).length <= MAX_ANSWER_BYTES;

export function encodeAnswers(answers) {
  const packed = deflateRawSync(enc.encode(JSON.stringify(answers)), { level: 9, dictionary: DICTIONARY_V1 });
  const out = new Uint8Array(packed.length + 1);
  out[0] = CODEC_V1;
  out.set(packed, 1);
  return out;
}

// D1 returns a BLOB as an array of byte values. Undecodable rows are misses.
export function decodeAnswers(value) {
  try {
    const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value);
    if (bytes[0] !== CODEC_V1) return null;
    const answers = JSON.parse(new TextDecoder().decode(inflateRawSync(bytes.subarray(1), { dictionary: DICTIONARY_V1, maxOutputLength: MAX_INFLATED })));
    return answers && typeof answers === "object" && !Array.isArray(answers) && Object.keys(answers).length ? answers : null;
  } catch {
    return null;
  }
}

// ---- Reads -------------------------------------------------------------------------

// Answers for `keys` (all of template `tpl`), in order, null where not cached.
// `questions[i]` is the question set of key i: a row whose answer does not fit
// it (or is too big) reads as null, and its index goes into `invalid`.
// One round trip: at most 99 keys per statement, statements sent as one batch.
export async function readAnswers(db, tpl, keys, questions, invalid = new Set()) {
  const statements = [];
  for (let start = 0; start < keys.length; start += KEYS_PER_STATEMENT) {
    const chunk = keys.slice(start, start + KEYS_PER_STATEMENT);
    const values = chunk.map((_, i) => `(${start + i}, ?${i + 2})`).join(", ");
    statements.push(
      db.prepare(`SELECT q.column1 AS i, a.v FROM (VALUES ${values}) AS q CROSS JOIN answers AS a WHERE a.tpl = ?1 AND a.k = q.column2`).bind(tpl, ...chunk),
    );
  }
  const results = statements.length === 1 ? [await statements[0].all()] : await db.batch(statements);
  const out = new Array(keys.length).fill(null);
  for (const r of results) {
    for (const row of r.results) {
      const answers = decodeAnswers(row.v);
      if (answers && storable(answers, questions[row.i])) out[row.i] = answers;
      else invalid.add(row.i);
    }
  }
  return out;
}

// ---- Writes ------------------------------------------------------------------------

// Templates this isolate has already registered (a few dozen at most).
const registered = new Set();

// Stores one answer. `template` names the fingerprint for the operator; it is
// written once per template per isolate, in the same batch. The caller checks
// storable() first. `replace`: the row for this key failed validation on read,
// so this answer overwrites it (otherwise the first answer written stays).
export async function writeAnswer(db, tpl, key, answers, template, day, replace = false) {
  const sql = replace
    ? "INSERT INTO answers (tpl, k, v) VALUES (?1, ?2, ?3) ON CONFLICT (tpl, k) DO UPDATE SET v = excluded.v"
    : "INSERT INTO answers (tpl, k, v) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING";
  const insert = db.prepare(sql).bind(tpl, key, encodeAnswers(answers));
  if (registered.has(tpl)) return insert.run();
  await db.batch([
    db
      .prepare("INSERT INTO templates (tpl, kind, lang, court, model, since) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING")
      .bind(tpl, template.kind, template.lang, template.court, template.model, day),
    insert,
  ]);
  registered.add(tpl);
}

