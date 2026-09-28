// Minuut Leeswijzer: what Jev's verdicts do to the ruling itself.
// The court's text is never rewritten. Each judged r.o. gets a pastel wash for
// its category and a small label; r.o.'s that do not touch the question are
// shown, folded behind a one-line label, or hidden, as the reader chooses.

var MNT = (globalThis.MNT = globalThis.MNT || {});

const STATE_CLASSES = ["mnt-judged", "mnt-kern", "mnt-doubt", "mnt-low", "mnt-folded", "mnt-hidden", "mnt-forced"];
const catClass = (role) => `mnt-cat-${role}`;
const ALL_CATS = () => MNT.ROLES.map((r) => catClass(r.key));

MNT.decorateSegment = (seg, onToggle) => {
  const first = seg.wraps[0];
  seg.tagEl = MNT.h(`<div class="mnt-label" hidden></div>`);
  // The label floats over the wash (hover only), outside the clipping inner.
  first.append(seg.tagEl);
  seg.foldEl = MNT.h(`<div class="mnt-fold" data-open="false"><div class="mnt-fold-inner"><button type="button" class="mnt-fold-btn" tabindex="-1"></button></div></div>`);
  first.before(seg.foldEl);
  seg.foldEl.querySelector("button").addEventListener("click", () => onToggle(seg));
};

// view: { tier, result, mode: "show" | "fold" | "hide", reason, forcedOpen }
MNT.renderSegment = (seg, view) => {
  const { tier, result, mode, reason, forcedOpen } = view;
  const judged = result && !result.error;
  for (const wrap of seg.wraps) {
    wrap.classList.remove(...STATE_CLASSES, ...ALL_CATS());
    if (judged) wrap.classList.add("mnt-judged", catClass(result.role));
    if (tier === "kern") wrap.classList.add("mnt-kern");
    if (tier === "doubt") wrap.classList.add("mnt-doubt");
    if (tier === "low") wrap.classList.add("mnt-low");
    if (mode === "fold") wrap.classList.add("mnt-folded");
    if (mode === "hide") wrap.classList.add("mnt-hidden");
    if (forcedOpen) wrap.classList.add("mnt-forced");
  }

  const cat = judged ? MNT.ROLE_LABEL[result.role] ?? result.role : null;
  const nrLabel = seg.nr ? `r.o. ${seg.nr}` : seg.section || "Passage";

  const skip = view.skip;
  const showFold = mode === "fold" || forcedOpen || Boolean(skip);
  seg.foldEl.dataset.open = String(showFold);
  seg.foldEl.className = skip
    ? `mnt-fold mnt-skip${skip.open ? " mnt-fold-open" : ""}`
    : `mnt-fold${judged ? ` ${catClass(result.role)}` : ""}${forcedOpen ? " mnt-fold-open" : ""}`;
  seg.foldEl.querySelector("button").tabIndex = showFold ? 0 : -1;
  if (skip) {
    const noun = skip.count === 1 ? "overweging" : "overwegingen";
    const range = skip.first ? (skip.count > 1 && skip.last ? `${skip.first}–${skip.last}` : skip.first) : "";
    seg.foldEl.querySelector("button").innerHTML = `
      <span class="mnt-skip-rule" aria-hidden="true"></span>
      <span class="mnt-skip-text">${skip.open ? `Verberg ${skip.count} ${noun}` : `${skip.count} ${noun} overgeslagen`}${range ? `<span class="mnt-skip-nrs">${MNT.esc(range)}</span>` : ""}</span>
      <span class="mnt-skip-rule" aria-hidden="true"></span>`;
    seg.foldEl.querySelector("button").setAttribute("aria-label", `${skip.count} ${noun} ${skip.open ? "verbergen" : "tonen"}${range ? ` (${range})` : ""}`);
  } else if (showFold) {
    const why = reason === "filtered" ? cat ?? "Andere categorie" : `${cat ? `${cat} · ` : ""}niet relevant`;
    seg.foldEl.querySelector("button").innerHTML = `
      <span class="mnt-fold-nr">${MNT.esc(nrLabel)}</span>
      <span class="mnt-fold-why">${MNT.esc(why)}</span>
      <span class="mnt-fold-snip">${MNT.esc(seg.text.slice(0, 140))}</span>
      <span class="mnt-fold-act">${forcedOpen ? "Verberg" : "Toon"}</span>`;
  }

  // The category shows only as the browser's own tooltip: native, delayed,
  // and it takes no room in the ruling.
  seg.tagEl.hidden = true;
  const note = { kern: "kernoverweging", doubt: "twijfel", low: "niet relevant" }[tier];
  const title = tier === "error" ? "Niet gelezen" : judged ? `${cat}${note ? ` · ${note}` : ""}` : "";
  for (const wrap of seg.wraps) {
    if (title) wrap.title = title;
    else wrap.removeAttribute("title");
  }
};

MNT.clearSegment = (seg) => {
  for (const wrap of seg.wraps) {
    wrap.classList.remove(...STATE_CLASSES, ...ALL_CATS());
    wrap.removeAttribute("title");
  }
  seg.tagEl.hidden = true;
  seg.foldEl.dataset.open = "false";
};

// Height of whatever Rechtspraak.nl pins to the top of the viewport (its
// "Gevonden zoektermen" bar), so a jump never lands underneath it.
function pinnedTop() {
  let bottom = 0;
  for (const el of document.elementsFromPoint(window.innerWidth / 3, 4)) {
    const pos = getComputedStyle(el).position;
    if (pos === "fixed" || pos === "sticky") bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
  }
  return bottom;
}

MNT.flashSegment = (seg) => {
  const target = seg.wraps[0];
  const top = target.getBoundingClientRect().top + window.scrollY - pinnedTop() - 24;
  window.scrollTo({ top, behavior: "smooth" });
  for (const el of document.querySelectorAll(".mnt-flash")) el.classList.remove("mnt-flash");
  for (const wrap of seg.wraps) {
    void wrap.offsetWidth;
    wrap.classList.add("mnt-flash");
    setTimeout(() => wrap.classList.remove("mnt-flash"), 1700);
  }
};

// ---- Sentence marks ------------------------------------------------------------
// Wrap the sentences Jev picked in <mark>, which sweeps in like a highlighter.
// The court's words are untouched; only a background is added behind them.

// Text nodes of a segment in reading order, skipping our own label and the
// hanging r.o. number.
function textNodes(seg) {
  const nodes = [];
  for (const wrap of seg.wraps) {
    const walker = document.createTreeWalker(wrap.querySelector(".mnt-seg-inner"), NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement.closest(".mnt-label, .mnt-fold") || n.parentElement.matches(".paragroup > span.nr, .mnt-seg-inner > span.nr")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
  }
  return nodes;
}

// Map the segment's text, whitespace collapsed, back to (node, offset) pairs.
function textIndex(seg) {
  let flat = "";
  const at = [];
  for (const node of textNodes(seg)) {
    const t = node.textContent;
    for (let i = 0; i < t.length; i++) {
      const ch = /\s/.test(t[i]) ? " " : t[i];
      if (ch === " " && flat.endsWith(" ")) continue;
      flat += ch;
      at.push([node, i]);
    }
    if (!flat.endsWith(" ")) {
      flat += " ";
      at.push([node, t.length]);
    }
  }
  return { flat, at };
}

const squash = (t) => t.replace(/\s+/g, " ").trim();

MNT.markSentences = (seg, picks) => {
  if (seg.marked) return;
  seg.marked = true;
  const { flat, at } = textIndex(seg);
  picks.forEach((pick, rank) => {
    const needle = squash(pick.text);
    const i = flat.indexOf(needle);
    if (i < 0 || !needle) return;
    const [startNode, startOff] = at[i];
    const [endNode, endOff] = at[i + needle.length - 1];
    // Collect the text nodes the sentence spans and wrap each slice.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    walker.currentNode = startNode;
    const slices = [];
    let node = startNode;
    while (node) {
      const from = node === startNode ? startOff : 0;
      const to = node === endNode ? endOff + 1 : node.textContent.length;
      if (to > from) slices.push([node, from, to]);
      if (node === endNode) break;
      node = walker.nextNode();
    }
    slices.forEach(([n, from, to], k) => {
      const range = document.createRange();
      range.setStart(n, from);
      range.setEnd(n, to);
      const mark = document.createElement("mark");
      mark.className = `mnt-mark ${rank === 0 ? "mnt-mark-top" : "mnt-mark-also"}`;
      mark.style.setProperty("--mnt-mark-delay", `${rank * 260 + k * 60}ms`);
      try {
        range.surroundContents(mark);
      } catch {
        // A slice that crosses element boundaries: leave it unmarked.
      }
    });
  });
};

// Remove earlier marks (a new question on the same ruling).
MNT.unmarkSentences = (seg) => {
  seg.marked = false;
  for (const wrap of seg.wraps) {
    for (const mark of wrap.querySelectorAll("mark.mnt-mark")) {
      const parent = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parent.normalize();
    }
  }
};

// Hiding an r.o. empties its paragroup, parablock and the line breaks around
// it, which still take room on Rechtspraak.nl. Mark such empty containers so
// they collapse too; the run's marker line is what remains visible.
MNT.collapseEmpty = (root) => {
  if (!root) return;
  for (const el of root.querySelectorAll(".mnt-void")) el.classList.remove("mnt-void");
  const empty = (el) =>
    [...el.childNodes].every((n) => {
      if (n.nodeType === Node.TEXT_NODE) return !n.textContent.trim();
      if (n.nodeType !== Node.ELEMENT_NODE) return true;
      if (n.classList.contains("mnt-void")) return true;
      if (n.classList.contains("mnt-seg")) return n.classList.contains("mnt-hidden") && !n.querySelector('.mnt-fold[data-open="true"]');
      if (n.classList.contains("mnt-fold")) return n.dataset.open !== "true";
      if (/linebreak/.test(n.className)) return true;
      return false;
    });
  // Deepest first, so a parent sees its children already collapsed.
  const containers = [...root.querySelectorAll(".paragroup, .parablock")].reverse();
  for (const el of containers) if (el.querySelector(".mnt-seg") && empty(el)) el.classList.add("mnt-void");
  // A line break after something that collapsed is a gap of its own.
  for (const br of root.querySelectorAll('span[class*="linebreak"]')) {
    const prev = br.previousElementSibling;
    if (prev && (prev.classList.contains("mnt-void") || prev.classList.contains("mnt-hidden"))) br.classList.add("mnt-void");
  }
};
