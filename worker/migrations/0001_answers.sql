-- Shared cache of Jev's answers about public ruling text (calls without a
-- question only). Written and read by worker/src/cache.js, which explains the
-- choices and their cost in D1 rows.

-- One row per answer, clustered on (template, key). WITHOUT ROWID: the primary
-- key is the table's own B-tree, so a lookup is one search and a write is one
-- row. No secondary index: D1 bills every index entry as an extra row written.
CREATE TABLE answers (
  tpl INTEGER NOT NULL, -- template fingerprint: 32 bits of SHA-256 over the model and the question set
  k   BLOB    NOT NULL, -- 16 bytes of SHA-256 over model + built questions + state (exactly what Jev gets)
  v   BLOB    NOT NULL, -- codec byte + deflate-raw(answers JSON) with a preset dictionary
  PRIMARY KEY (tpl, k)
) STRICT, WITHOUT ROWID;

-- What each fingerprint stands for, for the operator (a few dozen rows):
-- counting or removing the rows of a retired template is a range on answers.
CREATE TABLE templates (
  tpl   INTEGER PRIMARY KEY,
  kind  TEXT NOT NULL, -- core | sentences
  lang  TEXT NOT NULL, -- '' (Dutch courts) | nl | en (EU case law)
  court TEXT NOT NULL, -- the speaker named in the questions ('' when not named)
  model TEXT NOT NULL,
  since TEXT NOT NULL  -- first day (Europe/Amsterdam) a row of this template was written
) STRICT;
