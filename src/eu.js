// Minuut Leeswijzer: EU case law on Curia (InfoCuria) and EUR-Lex.
// Both publish the Court's own documents: judgments and orders of the Court of
// Justice and the General Court, and opinions of the advocates general.
//
// The paragraphs of an EU document are numbered 1, 2, 3 ... through the whole
// text, so each numbered paragraph ("punt") is one segment. Three shapes occur:
//  - Curia: flat <p>'s; `a[name=pointN]` opens a numbered paragraph, class
//    names carry the role (C04Titre1 heading, C41DispositifIntroduction,
//    C77Signatures, Cfootnotetext);
//  - EUR-Lex (from about 1990): each numbered paragraph is a table whose first
//    cell holds `p.coj-count#pointN`; headings are `coj-sum-title-1` or
//    `coj-title-grseq-N`, in opinions bold paragraphs ("I. Inleiding");
//  - EUR-Lex, old judgments (Van Gend & Loos): unnumbered paragraphs under
//    fixed parts (Summary, Parties, Grounds, Operative part). Each paragraph of
//    the grounds then becomes a passage of its own.
// Class names and anchors do not depend on the language; the few words we
// look for (the opening of the operative part) are listed for NL, EN, FR, DE.

var MNT = (globalThis.MNT = globalThis.MNT || {});

const EU_LEAF = new Set(["P", "TABLE", "UL", "OL", "BLOCKQUOTE", "PRE", "DL", "H1", "H2", "H3", "H4", "H5", "H6"]);
// Footnotes, the table of contents, the keywords line and "Language of the case".
const EU_SKIP = /footnote|TOC|Indicateur|(^|\s)coj-(note|index)(\s|$)/i;
const EU_SIGNATURE = /signature/i;
// "Om deze redenen verklaart het Hof (...) voor recht:", "On those grounds, the
// Court hereby rules:", "Par ces motifs, la Cour dit pour droit :", "Aus diesen
// Gründen hat der Gerichtshof für Recht erkannt:".
const EU_DICTUM_START = /^(om deze redenen|on those grounds|par ces motifs|aus diesen gründen)\b/i;
const EU_DICTUM_LINE =
  /(verklaart( het (hof|gerecht))?( \([^)]*\))? voor recht|rechtdoende|beschikt|hereby( rules| orders| declares)?|dit pour droit|déclare et arrête|ordonne|für recht erkannt( und entschieden)?|beschlossen)\s*:\s*$/i;
// Old EUR-Lex judgments: the anchors in front of each fixed part.
const EU_OLD_SKIP = new Set(["SM", "I1"]); // summary (editorial), parties
const EU_OLD_DICTUM = "DI";
const EU_MIN_PASSAGE = 160;
const CASE_NR = /\b([CTF])\s*[‑-]\s*(\d{1,4}\/\d{2})(?:\s*([A-Z]{1,3}))?\b/;
const ECLI_EU = /ECLI:EU:[CTF]:\d{4}:\d+/;

// ---- Where the text is ----------------------------------------------------------

// InfoCuria renders the document into `app-document`, in a <body> of its own.
MNT.curiaRoot = () => {
  const root = document.querySelector("app-document #document-inner");
  return root && root.querySelector("p") ? root : null;
};

// EUR-Lex: the "Text" panel of the normal page, or the whole body of the bare
// HTML variant (/TXT/HTML/). Old judgments sit in #TexteOnly.
MNT.eurlexRoot = () => {
  const panel = document.querySelector("#text #document1") ?? document.querySelector("#text");
  const root = panel ? panel.querySelector("#TexteOnly") ?? panel : /\/TXT\/HTML\//i.test(location.pathname) ? document.body : null;
  return root && root.querySelector("p") && MNT.clean(root.innerText).length > 200 ? root : null;
};

// ---- Who speaks -------------------------------------------------------------------

// From a document title in any language: "CONCLUSIE VAN ADVOCAAT-GENERAAL",
// "JUDGMENT OF THE GENERAL COURT", "Arrêt de la Cour", "Urteil des Gerichtshofs".
MNT.euSpeaker = (title = "") =>
  /advoca|avocat|generalanw|abogad/i.test(title) ? "de advocaat-generaal"
  : /\bgerecht\b|general court|\btribunal\b|\bgerichts?\b/i.test(title) ? "het Gerecht"
  : /\bhof\b|court|\bcour\b|gerichtshof/i.test(title) ? "het Hof van Justitie"
  : "de rechter";

// CELEX 62018CJ0311: sector 6, year, then the court (C, T, F) and the kind of
// document (J judgment, O order, C opinion of the advocate general, ...).
MNT.celexSpeaker = (celex = "") => {
  const m = /^6\d{4}([CTF])([A-Z])/i.exec(celex);
  if (!m) return "de rechter";
  if (/[CP]/i.test(m[2])) return "de advocaat-generaal";
  return { C: "het Hof van Justitie", T: "het Gerecht" }[m[1].toUpperCase()] ?? "de rechter";
};

const lines = (el) => MNT.clean(el?.innerText).split("\n").filter(Boolean);

// The language of the document: Curia's doclang=NL, EUR-Lex's /legal-content/NL/
// or ?locale=, else the page's html lang. Lower-case ISO code ("nl", "en", "fr").
MNT.euPageLang = () => {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("doclang") ?? /\/legal-content\/([A-Za-z]{2})\//.exec(location.pathname)?.[1] ?? params.get("locale");
  return (fromUrl || document.documentElement.lang || "").slice(0, 2).toLowerCase();
};

MNT.readCuriaMeta = (root) => {
  // "ARREST VAN HET HOF (Achtste kamer)" / "25 april 2024 (*)", or for an
  // opinion "CONCLUSIE VAN ADVOCAAT-GENERAAL" / "A. RANTOS" / "van 25 april 2024 (1)".
  const top = [...root.querySelectorAll(":scope > p")].slice(0, 6).map((p) => MNT.clean(p.innerText).replace(/\n/g, " "));
  const at = top.findIndex((line) => /\b\d{1,2}\.?\s+[^\s\d]+\s+\d{4}\b/.test(line));
  const title = (at > 0 ? top.slice(0, at) : top.slice(0, 1)).join(" ");
  const date = at >= 0 ? top[at].replace(/\(\s*[*\d]+\s*\)/g, "").replace(/^(van|delivered on|présentées le|vom)\s+/i, "").trim() : "";
  const text = MNT.clean(root.innerText.slice(0, 4000));
  const nr = CASE_NR.exec(text);
  const caseNr = nr ? `${nr[1]}-${nr[2]}${nr[3] ? ` ${nr[3]}` : ""}` : "";
  const ecli = ECLI_EU.exec(text)?.[0] ?? "";
  return {
    ecli: ecli || (caseNr ? `zaak ${caseNr}` : "Curia"),
    instantie: title,
    datum: date,
    rechtsgebieden: "",
    inhoudsindicatie: MNT.clean(root.querySelector(".C71Indicateur")?.innerText ?? ""),
    court: MNT.euSpeaker(title),
    lang: MNT.euPageLang(),
  };
};

MNT.eurlexCelex = () => {
  const uri = new URLSearchParams(location.search).get("uri") ?? "";
  return (/^celex:(\S+)/i.exec(uri)?.[1] ?? document.querySelector('meta[name="WT.z_docID"]')?.content ?? "").toUpperCase();
};

MNT.readEurlexMeta = (root) => {
  const celex = MNT.eurlexCelex();
  // The normal page names the document above the text ("Arrest van het Hof
  // (Grote kamer) van 16 juli 2020."); the bare variant only in the text.
  const head = lines(document.querySelector("#PP1Contents"));
  const title = (head[0] ?? lines(root.querySelector("p"))[0] ?? "").replace(/\.$/, "");
  let ecli = "";
  for (const p of document.querySelectorAll("#MainContent p, #PP1Contents p")) {
    if (root.contains(p)) continue;
    ecli = ECLI_EU.exec(p.textContent)?.[0] ?? "";
    if (ecli) break;
  }
  const index = root.querySelector(".coj-index") ?? (head.length > 3 ? { innerText: head[3] } : null);
  return {
    ecli: ecli || (celex ? `CELEX ${celex}` : "EUR-Lex"),
    instantie: title,
    datum: "",
    rechtsgebieden: "",
    inhoudsindicatie: MNT.clean(index?.innerText ?? ""),
    court: celex ? MNT.celexSpeaker(celex) : MNT.euSpeaker(title),
    lang: MNT.euPageLang(),
  };
};

// ---- Segments ----------------------------------------------------------------------

// The paragraph number of a numbered paragraph, or null.
function pointOf(el) {
  const anchor = el.querySelector('a[name^="point"], [id^="point"]');
  if (!anchor) return null;
  const nr = MNT.clean(anchor.textContent).replace(/\.$/, "");
  return /^\d{1,4}$/.test(nr) && MNT.clean(el.innerText).startsWith(nr) ? nr : null;
}

// Heading level, or 0 when `el` is not a heading. Curia: C04Titre1 (1),
// C05Titre2 (2), C21Titrenumerote1 (1) ...; EUR-Lex: coj-sum-title-1 (1),
// coj-title-grseq-2 (2), or a short paragraph set entirely in bold.
function headingLevel(el, text) {
  // Old EUR-Lex: <h1> is the CELEX number, <h2> the fixed parts.
  if (/^H[1-6]$/.test(el.tagName)) return Math.max(1, Number(el.tagName[1]) - 1);
  const cls = el.className || "";
  const titre = /Titre(?:numerote)?(\d)/i.exec(cls);
  if (titre) return Number(titre[1]);
  if (/sum-title-1|Debutdesmotifs/.test(cls)) return 1;
  const grseq = /title-grseq-(\d)/.exec(cls);
  if (grseq) return Number(grseq[1]);
  if (el.tagName !== "P" || !text || text.length > 300 || /[:;]$/.test(text)) return 0;
  const bold = [...el.querySelectorAll("b, strong, .coj-bold")].map((b) => b.textContent).join("");
  if (bold && MNT.clean(bold).replace(/\s/g, "").length >= text.replace(/\s/g, "").length - 2) return numberedLevel(text) || 3;
  return 0;
}

// "I." 1, "A." 2, "1." 3, "a)" 4, "1)" 5; 0 when not numbered like a heading.
// "C." and "D." are letters here, not Roman numerals.
function numberedLevel(text) {
  if (/^[IVX]{1,5}\s*[.\-–]\s/.test(text)) return 1;
  if (/^[A-Z]\s*[.\-–]\s/.test(text)) return 2;
  if (/^\d+\s*[.\-–]\s/.test(text)) return 3;
  if (/^[a-z]\s*\)\s/.test(text)) return 4;
  if (/^\d+\s*\)\s/.test(text)) return 5;
  return 0;
}

MNT.segmentEU = (root) => {
  const anchored = Boolean(root.querySelector('a[name^="point"], [id^="point"]'));
  const segments = [];
  const heads = []; // heading text per level
  let section = "";
  let current = null;
  let started = !anchored; // before the first numbered paragraph: title, parties, composition
  let dictum = false;
  let done = false;
  let oldPart = null; // old EUR-Lex judgments: the anchor of the current fixed part

  const setHeading = (level, text) => {
    heads.length = level - 1;
    heads[level - 1] = text;
    section = heads.filter(Boolean).join(" – ");
    current = null;
  };
  const open = (nr, kind) => {
    current = { id: segments.length, nr, kind, section, nodes: [], text: "" };
    segments.push(current);
  };
  const add = (el, text) => {
    if (!current) open(null, "loose");
    current.nodes.push(el);
    current.text += (current.text ? "\n" : "") + text;
  };

  const visit = (el) => {
    const text = MNT.clean(el.innerText);
    const cls = typeof el.className === "string" ? el.className : "";
    if (EU_SIGNATURE.test(cls) || el.querySelector?.('[class*="Signature" i]')) {
      if (started) done = true; // signatures, then only footnotes follow
      return;
    }
    if (EU_SKIP.test(cls) || el.querySelector?.('[class*="TOC"]')) return;
    if (!text) return;

    if (dictum) return /^H[1-6]$/.test(el.tagName) ? undefined : add(el, text);
    const nr = anchored ? pointOf(el) : null;
    if (nr) {
      started = true;
      open(nr, "ro");
      return add(el, text);
    }
    const opensDictum = /Dispositif/i.test(cls) || (text.length < 250 && (EU_DICTUM_START.test(text) || EU_DICTUM_LINE.test(text)));
    if (started && opensDictum) {
      dictum = true;
      open(null, "dictum");
      current.section = "Dictum";
      return add(el, text);
    }
    const level = headingLevel(el, text);
    if (level) return setHeading(level, text);
    if (!started) {
      // Title, parties and composition: headings above them are not sections.
      heads.length = 0;
      section = "";
      return;
    }
    if (oldPart && EU_OLD_SKIP.has(oldPart)) return;
    if (anchored) {
      // Quotations, indents and lists inside a numbered paragraph.
      if (current) add(el, text);
      return;
    }
    // Unnumbered text (old EUR-Lex): each paragraph is a passage; a short
    // numbered line ("II - THE FIRST QUESTION") is a heading, any other short
    // line joins the passage before it.
    if (text.length < EU_MIN_PASSAGE) {
      const sub = numberedLevel(text);
      if (sub && !/[.;]$/.test(text)) return setHeading(1 + sub, text);
      if (current) return add(el, text);
    }
    open(null, "loose");
    add(el, text);
  };

  const walk = (parent) => {
    for (const el of [...parent.children]) {
      if (done) return;
      // Old EUR-Lex: <p><a name="MO"></a></p> in front of each fixed part.
      const part = el.tagName === "P" && !MNT.clean(el.textContent) ? el.querySelector("a[name]")?.getAttribute("name") : null;
      if (part && /^(SM|I\d|MO|CO|DI)$/.test(part)) {
        oldPart = part;
        started = true;
        if (part === EU_OLD_DICTUM) {
          dictum = true;
          current = null;
          open(null, "dictum");
          current.section = "Dictum";
        } else {
          dictum = false;
          current = null;
        }
        continue;
      }
      if (el.tagName === "HR" || el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
      if (EU_LEAF.has(el.tagName)) visit(el);
      else walk(el);
    }
  };
  // Old EUR-Lex texts open with keywords before any part anchor: skip them.
  if (!anchored && root.querySelector('a[name="MO"]')) started = false;
  walk(root);

  return segments
    .filter((s) => (s.kind === "loose" ? s.text.length >= EU_MIN_PASSAGE : s.text.length > 0))
    .map((s, i) => ({ ...s, id: i }));
};
