// Minuut Leeswijzer: find the rechtsoverwegingen in a Rechtspraak.nl ruling.
// Parser first, model second: without stable segments Jev scores a laundry list.
//
// Two shapes occur on uitspraken.rechtspraak.nl:
//  - structured (most rulings since ~2013): `.paragroup > span.nr` carries the
//    r.o. number, nested paragroups carry sub-numbers (5.2.1);
//  - plain (older rulings): numbered paragraphs ("3.4 Het hof ...") inside
//    `.parablock`, recognised by a leading number that fits the numbering so far.

var MNT = (globalThis.MNT = globalThis.MNT || {});

MNT.findRulingRoot = () =>
  document.querySelector(".rnl-detail-uitspraaktekst div.uitspraak, .rnl-detail-uitspraaktekst div.conclusie");

MNT.readMeta = () => {
  const meta = {};
  for (const row of document.querySelectorAll(".rnl-details .rnl-detail")) {
    const value = row.querySelector(".rnl-details-value");
    if (!value) continue;
    const label = MNT.clean(row.textContent.replace(value.textContent, "")).toLowerCase();
    meta[label] = MNT.clean(value.textContent);
  }
  const ecli = new URLSearchParams(location.search).get("id") || "";
  return {
    ecli: ecli.toUpperCase(),
    instantie: meta["instantie"] || "",
    datum: meta["datum uitspraak"] || "",
    rechtsgebieden: meta["rechtsgebieden"] || "",
    inhoudsindicatie: MNT.clean(document.querySelector(".rnl-details .inhoudsindicatie")?.textContent || meta["inhoudsindicatie"] || ""),
  };
};

const LEAF = new Set(["P", "UL", "OL", "TABLE", "BLOCKQUOTE", "PRE", "DL", "H5", "H6"]);
const HEADING = /^H[1-4]$/;
const SKIP = /(^|\s)(uitspraak-info|conclusie-info|footnotes)(\s|$)/;
const ANCHOR = /^(?:r\.?\s?o\.?\s*)?(\d{1,2}(?:\.\d{1,3}){0,4})\.?(?=\s|$)/i;
const MONTH = /^\s*(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\b/i;
const MIN_LOOSE_CHARS = 160;

// Plain rulings: accept "3.4" when its chapter is not behind the current one,
// and a bare "4." only as the next chapter, so enumerations ("1. De verklaring
// van ...") inside an overweging do not split it.
function plainAnchor(text, numbering) {
  const m = ANCHOR.exec(text);
  if (!m || MONTH.test(text.slice(m[0].length))) return null;
  const nr = m[1];
  const top = Number(nr.split(".")[0]);
  const isSub = nr.includes(".");
  const ok = isSub ? top >= numbering.top : top === numbering.top + 1 || numbering.top === 0;
  if (!ok) return null;
  numbering.top = top;
  return nr;
}

MNT.segmentRuling = (root) => {
  const structured = root.querySelectorAll(".paragroup > span.nr").length >= 3;
  const segments = [];
  const numbering = { top: 0 };
  let current = null;
  let section = "";

  const open = (nr, kind) => {
    current = { id: segments.length, nr, kind, section, nodes: [], text: "" };
    segments.push(current);
  };
  const add = (el) => {
    const text = MNT.clean(el.innerText);
    if (!text) return;
    if (!current) open(null, "loose");
    current.nodes.push(el);
    current.text += (current.text ? "\n" : "") + text;
  };

  const walk = (parent) => {
    for (const el of [...parent.children]) {
      if (SKIP.test(el.className)) continue;
      if (el.tagName === "SPAN" && /linebreak/.test(el.className)) continue;
      if (HEADING.test(el.tagName) || el.classList.contains("bridgehead")) {
        section = MNT.clean(el.innerText).replace(/\n+/g, " ");
        current = null;
        continue;
      }
      if (structured) {
        if (el.classList.contains("paragroup") || el.classList.contains("section")) {
          current = null;
          walk(el);
          current = null;
        } else if (el.matches("span.nr") && parent.classList.contains("paragroup")) {
          open(MNT.clean(el.textContent).replace(/\.$/, ""), "ro");
          current.nodes.push(el);
        } else {
          add(el);
        }
        continue;
      }
      if (LEAF.has(el.tagName)) {
        const nr = plainAnchor(MNT.clean(el.innerText), numbering);
        if (nr) open(nr, "ro");
        add(el);
        continue;
      }
      walk(el);
    }
  };
  walk(root);

  return segments
    .filter((s) => (s.kind === "ro" ? s.text.length > 0 : s.text.length >= MIN_LOOSE_CHARS))
    .map((s, i) => ({ ...s, id: i }));
};

// Wrap each segment's nodes, one wrapper per run of adjacent siblings, so a
// whole r.o. can be tinted, folded or hidden. The wrapper is an accordion:
// `.mnt-seg` is a grid track (1fr open, 0fr folded) and `.mnt-seg-inner` clips.
// Rechtspraak hangs the r.o. number 24px into the left gutter, so the inner
// element reaches into that gutter to keep the number visible; the page's own
// layout and type are untouched.
MNT.wrapSegment = (seg) => {
  const runs = [];
  for (const node of seg.nodes) {
    const run = runs[runs.length - 1];
    if (run && run.parent === node.parentElement && followsWithinParent(run.last, node)) {
      run.last = node;
    } else {
      runs.push({ parent: node.parentElement, first: node, last: node });
    }
  }
  seg.wraps = runs.map((run) => {
    const wrap = document.createElement("div");
    wrap.className = "mnt-seg";
    wrap.dataset.mntSeg = String(seg.id);
    const inner = document.createElement("div");
    inner.className = "mnt-seg-inner";
    wrap.append(inner);
    run.parent.insertBefore(wrap, run.first);
    let node = run.first;
    while (node) {
      const next = node.nextSibling;
      inner.appendChild(node);
      if (node === run.last) break;
      node = next;
    }
    return wrap;
  });
  return seg;
};

// True when only whitespace, comments or Rechtspraak's linebreak spans sit
// between `a` and `b`.
function followsWithinParent(a, b) {
  for (let n = a.nextSibling; n; n = n.nextSibling) {
    if (n === b) return true;
    if (n.nodeType === Node.TEXT_NODE && !n.textContent.trim()) continue;
    if (n.nodeType === Node.COMMENT_NODE) continue;
    if (n.nodeType === Node.ELEMENT_NODE && /linebreak/.test(n.className)) continue;
    return false;
  }
  return false;
}
