// Minuut Leeswijzer: shared vocabulary for the content scripts.
// Content scripts share one isolated world, so modules hang off one namespace.

var MNT = (globalThis.MNT = globalThis.MNT || {});

// The categories Jev chooses between, in reading order of a typical ruling
// section. Order = order of the filter pills. The definitions Jev chooses by
// live in the Worker (ROLES in worker/src/index.js).
MNT.ROLES = [
  { key: "kader", label: "Juridisch kader", short: "Kader" },
  { key: "toepassing", label: "Toepassing juridisch kader", short: "Toepassing" },
  { key: "obiter", label: "Obiter dictum", short: "Obiter" },
  { key: "stellingen", label: "Stellingen partijen", short: "Stellingen" },
  { key: "feiten", label: "Feiten", short: "Feiten" },
  { key: "proces", label: "Procesverloop", short: "Proces" },
  { key: "beslissing", label: "Beslissing", short: "Beslissing" },
];
MNT.ROLE_LABEL = Object.fromEntries(MNT.ROLES.map((r) => [r.key, r.label]));

// Tiers. Kernoverweging = the court itself answers the question (antwoord >= 0.6)
// on the same issue; "raakt" = same legal issue (onderwerp >= 0.7); 0.4-0.7 is
// doubt (visible, dimmed); below 0.4 not relevant. A summary up front ("De zaak
// in het kort") is never kern: the model rates those as answers (tested: 0.90)
// although they only announce the outcome.
MNT.RELEVANT = 0.7;
MNT.DOUBT = 0.4;
MNT.ANSWER = 0.6;
MNT.SUMMARY_SECTION = /in het kort|samenvatting|inleiding|waar gaat (de zaak|het) over/i;

MNT.tierOf = (r) => {
  if (!r) return "pending";
  if (r.error) return "error";
  if (r.mode === "core") {
    // Kernoverweging = all three factors (tested on a hof ruling and a Hoge Raad
    // arrest); "rel" here means the court's own judgement on the substance.
    if (r.eu) {
      // EU case law (tuned on 12 labelled judgments and opinions): the operative
      // part is always kern, and a party's argument or a recounted finding
      // never is, however firmly the model rates it as the court's own.
      if (r.role === "beslissing") return "kern";
      if (r.own >= 0.6 && r.substance >= 0.5 && r.bearing >= 0.5 && (r.role === "kader" || r.role === "toepassing") && !r.summary) return "kern";
      if (r.own >= 0.6 && r.substance >= 0.5) return "rel";
      return "low";
    }
    if (r.own >= 0.6 && r.substance >= 0.6 && r.bearing >= 0.5 && !r.summary) return "kern";
    if ((r.own >= 0.6 && r.substance >= 0.5) || r.role === "beslissing") return "rel";
    return "low";
  }
  if (r.answer >= MNT.ANSWER && r.relevant >= 0.5 && !r.summary) return "kern";
  if (r.relevant >= MNT.RELEVANT || (r.answer >= MNT.ANSWER && r.relevant >= 0.5)) return "rel";
  if (r.relevant >= MNT.DOUBT) return "doubt";
  return "low";
};

MNT.TIER_LABEL = {
  kern: "Kernoverweging",
  rel: "Raakt uw vraag",
  doubt: "Twijfel",
  low: "Niet relevant",
  pending: "Wordt gekeurd",
  error: "Niet gekeurd",
};

// Ranking: the court's own answer first, then how closely it touches the issue.
MNT.rankOf = (r) => {
  if (!r || r.error) return -1;
  if (r.mode === "core") return 0.3 * r.own + 0.4 * r.bearing + 0.3 * r.substance - (r.summary ? 0.3 : 0);
  return 0.6 * r.answer + 0.4 * r.relevant - (r.summary ? 0.3 : 0);
};

// What happens to r.o.'s (or search hits) that do not touch the question.
MNT.LOW_MODES = [
  { key: "show", label: "Tonen" },
  { key: "fold", label: "Inklappen" },
  { key: "hide", label: "Verbergen" },
];

MNT.clean = (s) => (s || "").replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

MNT.esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

MNT.pct = (p) => `${Math.round((p ?? 0) * 100)}%`;

// Preferences (fold mode, sort, panel open) persist; anything the lawyer types
// lives only in the session store, which the browser wipes on close.
MNT.storage = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
};
MNT.session = {
  get: (keys) => chrome.storage.session.get(keys),
  set: (obj) => chrome.storage.session.set(obj),
};

MNT.h = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
