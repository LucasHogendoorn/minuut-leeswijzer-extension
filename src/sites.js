// Minuut Leeswijzer: the sites Leeswijzer reads, one adapter each.
// The controller (content.js) asks the adapter where the ruling is, what it is
// called and how its paragraphs are named; everything after that is shared.

var MNT = (globalThis.MNT = globalThis.MNT || {});

// How a site names its numbered paragraphs: Dutch rulings have
// rechtsoverwegingen (r.o. 3.4), EU documents numbered punten (punt 42).
const RO_TERMS = { short: "r.o.", many: "r.o.'s", noun: "Rechtsoverweging", plural: "rechtsoverwegingen" };
const PUNT_TERMS = { short: "punt", many: "punten", noun: "Punt", plural: "punten" };
// Sections read first for the whole-ruling verdict, in NL, EN, FR and DE.
const EU_PRIORITY = /beantwoording|prejudici|analyse|beoordeling|dictum|answer|questions referred|consideration|findings|assessment|grounds|réponse|appréciation|motifs|würdigung|beantwortung/i;

// EUR-Lex holds all EU law; only case law (CELEX sector 6) is read.
const isEurlexCaseLaw = () => {
  const sector = document.querySelector('meta[name="WT.z_docSector"]')?.content;
  if (sector) return sector === "6";
  const uri = new URLSearchParams(location.search).get("uri") ?? "";
  return /^(celex:6|ecli:ECLI:EU:)/i.test(uri);
};

const SITES = {
  rechtspraak: {
    id: "rechtspraak",
    name: "Rechtspraak.nl",
    terms: RO_TERMS,
    copy: {
      idleLead: "Zoek of open een uitspraak op Rechtspraak.nl.",
      idleText: "In elke uitspraak ziet u meteen de kernoverwegingen. Met een rechtsvraag ziet u ook in de zoekresultaten welke uitspraken erover gaan.",
      empty: "Rechtspraak.nl toont hier alleen de gegevens van de uitspraak.",
    },
    active: () => true,
    isRuling: () => location.pathname.startsWith("/details"),
    isResults: () => location.pathname.startsWith("/resultaat"),
    findRoot: () => MNT.findRulingRoot(),
    // Metadata without text: an unpublished ruling.
    isTextless: () => Boolean(document.querySelector(".rnl-details .rnl-detail")),
    readMeta: () => MNT.readMeta(),
    segment: (root) => MNT.segmentRuling(root),
    prioritySection: /beoordel|overweg|motiver|beslis|conclusie|middel|grief/i,
    // The core questions name the court; the question mode keeps "de rechter".
    speakerInQuestion: false,
  },
  curia: {
    id: "curia",
    name: "Curia",
    terms: PUNT_TERMS,
    copy: {
      idleLead: "Open een arrest, beschikking of conclusie op Curia.",
      idleText: "U ziet dan meteen de kernoverwegingen. Met een rechtsvraag ziet u wat daarover gaat.",
      empty: "Curia toont hier geen tekst van deze uitspraak.",
    },
    active: () => true,
    isRuling: () => location.pathname.startsWith("/tabs/document"),
    isResults: () => false,
    findRoot: () => MNT.curiaRoot(),
    isTextless: () => false,
    readMeta: (root) => MNT.readCuriaMeta(root),
    segment: (root) => MNT.segmentEU(root),
    prioritySection: EU_PRIORITY,
    // An advocate general is not a court: every question names who speaks.
    speakerInQuestion: true,
  },
  eurlex: {
    id: "eurlex",
    name: "EUR-Lex",
    terms: PUNT_TERMS,
    copy: {
      idleLead: "Open een arrest, beschikking of conclusie op EUR-Lex.",
      idleText: "U ziet dan meteen de kernoverwegingen. Met een rechtsvraag ziet u wat daarover gaat.",
      empty: "EUR-Lex toont hier geen tekst van deze uitspraak in deze taal.",
    },
    active: isEurlexCaseLaw,
    isRuling: () => true,
    isResults: () => false,
    findRoot: () => MNT.eurlexRoot(),
    // The page has loaded but has no text in this language.
    isTextless: () => document.readyState === "complete",
    readMeta: (root) => MNT.readEurlexMeta(root),
    segment: (root) => MNT.segmentEU(root),
    prioritySection: EU_PRIORITY,
    speakerInQuestion: true,
  },
};

MNT.site =
  location.hostname === "infocuria.curia.europa.eu" ? SITES.curia
  : location.hostname === "eur-lex.europa.eu" ? SITES.eurlex
  : SITES.rechtspraak;
