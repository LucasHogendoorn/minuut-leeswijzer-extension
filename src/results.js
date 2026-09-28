// Minuut Leeswijzer: "Gaat dit over mijn rechtsvraag?" on the search results.
// Jev reads each hit's inhoudsindicatie and the hit gets a ja / deels / nee
// badge; hits about something else are dimmed, never removed.

var MNT = (globalThis.MNT = globalThis.MNT || {});

MNT.readHits = () =>
  [...document.querySelectorAll(".rnl-listresults-item-container")]
    .map((el) => {
      const link = el.querySelector(".rnl-listresults-item-title a");
      const title = MNT.clean(link?.textContent);
      const ecli = /ECLI:[A-Z]{2}:[A-Z0-9]+:\d{4}:[A-Z0-9]+/i.exec(title)?.[0]?.toUpperCase();
      if (!ecli) return null;
      const fields = {};
      for (const d of el.querySelectorAll(".rnl-listresults-item-description")) {
        const label = MNT.clean(d.querySelector("label")?.textContent).replace(/:$/, "").toLowerCase();
        if (label) fields[label] = MNT.clean(d.textContent.replace(d.querySelector("label").textContent, ""));
      }
      const [court = "", date = ""] = title.replace(ecli, "").trim().split(/,\s*/);
      return {
        el,
        ecli,
        title,
        court,
        date,
        href: link.href,
        rechtsgebieden: fields["rechtsgebieden"] || "",
        inhoudsindicatie: MNT.clean(el.querySelector(".tekst")?.textContent) || fields["inhoudsindicatie"] || "",
      };
    })
    .filter(Boolean);

MNT.hitState = (hit) =>
  [
    `Uitspraak: ${hit.title}`,
    hit.rechtsgebieden && `Rechtsgebieden: ${hit.rechtsgebieden}`,
    `Inhoudsindicatie: ${hit.inhoudsindicatie || "(geen inhoudsindicatie)"}`,
  ]
    .filter(Boolean)
    .join("\n");

MNT.hitVerdict = (p) => (p >= MNT.RELEVANT ? "ja" : p >= MNT.DOUBT ? "deels" : "nee");

MNT.renderHit = (hit, entry, lowMode, filter = new Set()) => {
  let badge = hit.el.querySelector(":scope > .mnt-hit");
  hit.el.classList.remove("mnt-hit-low", "mnt-hit-gone");
  if (!entry) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("div");
    const title = hit.el.querySelector(".rnl-listresults-item-title");
    (title ?? hit.el.firstChild).after(badge);
  }
  // A verdict filter (ja / deels / nee) shows only those; unjudged hits wait.
  if (filter.size && (entry.pending || entry.error || !filter.has(MNT.hitVerdict(entry.p)))) {
    hit.el.classList.add("mnt-hit-gone");
  }
  if (entry.pending) {
    badge.className = "mnt-hit mnt-hit-pending";
    badge.innerHTML = `<span class="mnt-hit-dot"></span>Wordt beoordeeld`;
    return;
  }
  if (entry.error) {
    badge.className = "mnt-hit";
    badge.innerHTML = `<span class="mnt-hit-dot"></span>Niet gekeurd`;
    return;
  }
  const v = MNT.hitVerdict(entry.p);
  const text = { ja: "<b>Ja</b>, gaat over uw vraag", deels: "<b>Deels</b>, raakt uw vraag", nee: "<b>Nee</b>, gaat over iets anders" }[v];
  badge.className = `mnt-hit mnt-hit-${v}`;
  badge.innerHTML = `<span class="mnt-hit-dot"></span><span>${text}</span>`;
  if (!filter.size && v === "nee" && lowMode === "fold") hit.el.classList.add("mnt-hit-low");
  if (!filter.size && v === "nee" && lowMode === "hide") hit.el.classList.add("mnt-hit-gone");
};

// Ask Rechtspraak.nl for more hits by pressing its own "Laad meer resultaten"
// button until `target` hits are listed or the list ends. Resolves with the
// number of hits on the page.
MNT.loadHitsUntil = async (target, isCancelled) => {
  const count = () => document.querySelectorAll(".rnl-listresults-item-container").length;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The single-page app renders the list (and its button) after the URL changes.
  for (let i = 0; i < 60 && !isCancelled(); i++) {
    if (count() > 0 && (document.querySelector("button.uitspraken-resultaten--btn-load-more") || i > 10)) break;
    await sleep(150);
  }
  // Each click re-renders the whole list (it briefly empties), so wait until
  // it is longer than before, and give the button a moment to come back.
  const button = async () => {
    for (let i = 0; i < 20 && !isCancelled(); i++) {
      const b = document.querySelector("button.uitspraken-resultaten--btn-load-more");
      if (b && !b.disabled && count() > 0) return b;
      await sleep(150);
    }
    return null;
  };
  while (count() < target && !isCancelled()) {
    const b = await button();
    if (!b) break;
    const before = count();
    b.click();
    for (let i = 0; i < 60 && count() <= before; i++) await sleep(150);
    if (count() <= before) break;
  }
  return count();
};
