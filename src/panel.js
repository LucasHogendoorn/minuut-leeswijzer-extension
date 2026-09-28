// Minuut Leeswijzer: the side panel. Lives in a shadow root so Rechtspraak.nl's
// styles and ours never meet. The controller (content.js) owns all state and
// calls render(state). The panel keeps its DOM and patches it in place, so the
// transitions.dev motion (panel reveal, sliding tabs, accordion, text swap,
// number pop-in, shimmer) can run instead of being replaced mid-flight.

var MNT = (globalThis.MNT = globalThis.MNT || {});

const ICON = {
  gear: `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  minus: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  up: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 12 4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  down: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  chevron: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  copy: `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M13 4.5H6A1.5 1.5 0 0 0 4.5 6v7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  enter: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15 5v4.5a2 2 0 0 1-2 2H5.5m0 0L8.5 8.5m-3 3 3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  arrow: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9m-3.5-3.5L12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  lock: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`,
};

const snippetOf = (seg) => seg.text.replace(/^(?:r\.?\s?o\.?\s*)?\d{1,2}(?:\.\d{1,3}){0,4}\.?\s+/i, "").slice(0, 170);
const cssMs = (el, name, fallback) => parseFloat(getComputedStyle(el).getPropertyValue(name)) || fallback;
const TOP_N = [3, 10, 25];
const VERDICT = [
  { min: MNT.RELEVANT, word: "Ja", line: "gaat over uw rechtsvraag", cls: "ja" },
  { min: MNT.DOUBT, word: "Deels", line: "raakt uw vraag, beslist haar niet", cls: "deels" },
  { min: -1, word: "Nee", line: "gaat over iets anders", cls: "nee" },
];
// Group names follow the mode: with a question they speak about the question,
// without one about the ruling's own core.
const GROUP_TITLES_QUESTION = { kern: "Kernoverwegingen", rel: "Raakt uw vraag", doubt: "Twijfel", low: "Raakt uw vraag niet" };
const GROUP_TITLES_CORE = { kern: "Kernoverwegingen", rel: "Eigen oordeel van de rechter", doubt: "Twijfel", low: "Overige overwegingen" };

const GROUPS = [
  { key: "kern", title: "Kernoverwegingen", open: true },
  { key: "rel", title: "Raakt uw vraag", open: true },
  { key: "doubt", title: "Twijfel", open: false },
  { key: "low", title: "Raakt uw vraag niet", open: false },
];

// ---- Small motion helpers (transitions.dev recipes) ------------------------

// Text states swap: old text exits up with blur, new text rises in.
function swapText(el, next) {
  if (el.textContent === next) return;
  if (!el.isConnected || !el.textContent) {
    el.textContent = next;
    return;
  }
  const dur = cssMs(el, "--mnt-duration-quick", 150);
  el.classList.add("is-exit");
  clearTimeout(el._swap);
  el._swap = setTimeout(() => {
    el.textContent = next;
    el.classList.remove("is-exit");
    el.classList.add("is-enter-start");
    void el.offsetHeight;
    el.classList.remove("is-enter-start");
  }, dur);
}

// Number pop-in: re-enter the digits with a blurred slide when a count changes.
function setNumber(el, n) {
  const str = String(n);
  if (el.dataset.v === str) return;
  const first = el.dataset.v == null;
  el.dataset.v = str;
  el.classList.remove("is-animating");
  el.replaceChildren(
    ...str.split("").map((ch, i, all) => {
      const d = document.createElement("span");
      d.className = "digit";
      d.textContent = ch;
      if (i === all.length - 2) d.dataset.stagger = "1";
      if (i === all.length - 1) d.dataset.stagger = "2";
      return d;
    }),
  );
  if (first) return;
  void el.offsetHeight;
  el.classList.add("is-animating");
}

// Tabs sliding: a pill slides under the selected option.
function tabsHtml(act, options, label) {
  return `<div class="tabs" role="tablist" aria-label="${MNT.esc(label)}" data-tabs="${act}">
    <span class="tabs-pill" aria-hidden="true"></span>
    ${options.map((o) => `<button type="button" role="tab" class="tab" data-act="${act}" data-v="${o.key}" aria-selected="false">${MNT.esc(o.label)}</button>`).join("")}
  </div>`;
}
function setTabs(bar, value) {
  if (!bar) return;
  const tabs = [...bar.querySelectorAll(".tab")];
  const active = tabs.find((t) => t.dataset.v === value) ?? tabs[0];
  for (const t of tabs) t.setAttribute("aria-selected", String(t === active));
  const pill = bar.querySelector(".tabs-pill");
  const place = () => {
    if (!active.offsetWidth) return false;
    const animate = bar.dataset.placed === "1";
    if (!animate) pill.style.transition = "none";
    pill.style.transform = `translateX(${active.offsetLeft}px)`;
    pill.style.width = `${active.offsetWidth}px`;
    if (!animate) {
      void pill.offsetWidth;
      pill.style.transition = "";
      bar.dataset.placed = "1";
    }
    return true;
  };
  if (!place()) requestAnimationFrame(place);
}

// FLIP: animate rows from where they were to where they are now.
function flip(nodes, before) {
  for (const node of nodes) {
    const was = before.get(node);
    if (!was || !node.isConnected) continue;
    const now = node.getBoundingClientRect();
    const dy = was.top - now.top;
    if (Math.abs(dy) < 1) continue;
    node.style.transition = "none";
    node.style.transform = `translateY(${dy}px)`;
    void node.offsetHeight;
    node.style.transition = "";
    node.style.transform = "";
  }
}

// Put exactly `nodes`, in order, into `container`.
function place(container, nodes) {
  nodes.forEach((node, i) => {
    if (container.children[i] !== node) container.insertBefore(node, container.children[i] ?? null);
  });
  while (container.children.length > nodes.length) container.lastElementChild.remove();
}

MNT.Panel = class {
  constructor(handlers) {
    this.on = handlers;
    this.host = document.createElement("div");
    this.host.id = "mnt-host";
    this.host.style.cssText = "all: initial; position: fixed; z-index: 2147483000; display: none;";
    this.root = this.host.attachShadow({ mode: "open" });
    this.rows = new Map(); // seg id -> row element
    this.hitRows = new Map(); // ecli -> row element
    this.groupOpen = Object.fromEntries(GROUPS.map((g) => [g.key, g.open]));
    this.screen = null;
    // Open only on request ("Wijzig"); before a question is asked the editor
    // shows regardless (see renderQuestion).
    this.editing = false;
  }

  mount() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("src/panel.css");
    const mascotCss = document.createElement("link");
    mascotCss.rel = "stylesheet";
    mascotCss.href = chrome.runtime.getURL("src/mascot.css");
    link.addEventListener("load", () => {
      this.host.style.display = "block";
      requestAnimationFrame(() => this.root.querySelectorAll(".tabs").forEach((b) => setTabs(b, b.querySelector('[aria-selected="true"]')?.dataset.v)));
    });
    this.root.append(mascotCss, link, this.skeleton());
    document.documentElement.append(this.host);
    this.bind();
  }

  $(sel) {
    return this.root.querySelector(sel);
  }

  skeleton() {
    return MNT.h(`
      <div class="shell">
        <button class="pill" type="button" data-act="open" aria-label="Open de Leeswijzer">
          ${MNT.mascot(24)}<span class="pill-label">Leeswijzer</span><span class="pill-count" hidden></span>
        </button>
        <aside class="panel" data-open="false" aria-label="Minuut Leeswijzer">
          <header class="hd">
            ${MNT.mascot(38)}
            <div class="hd-text">
              <div class="hd-title">Leeswijzer</div>
              <div class="hd-status"><span class="swap status-text">Klaar om mee te lezen</span></div>
            </div>
            <button class="icon" type="button" data-act="settings" title="Over en privacy">${ICON.gear}</button>
            <button class="icon" type="button" data-act="close" title="Inklappen">${ICON.minus}</button>
          </header>
          <div class="body">
            <section class="q" data-editing="false" data-has-q="false">
              <button type="button" class="q-add" data-act="edit-q">
                <span class="q-add-plus" aria-hidden="true">+</span>Rechtsvraag stellen<span class="q-optional">optioneel</span>
              </button>
              <div class="q-summary">
                <button type="button" class="q-summary-main" data-act="edit-q">
                  <span class="q-label">Uw rechtsvraag</span>
                  <span class="q-text"></span>
                </button>
                <span class="q-actions">
                  <button type="button" class="link small strong" data-act="edit-q">Wijzig</button>
                  <button type="button" class="link small" data-act="clear-q" title="Zonder vraag: toon de kernoverwegingen">Wis</button>
                </span>
              </div>
              <div class="acc-panel">
                <div class="acc-inner">
                  <form class="ask" autocomplete="off">
                    <div class="q-lead">
                      <p class="q-lead-title">Welke uitspraken gaan over uw vraag?</p>
                      <p class="q-lead-text">Typ uw rechtsvraag. De eerste 50 zoekresultaten krijgen ja, deels of nee en komen op volgorde.</p>
                    </div>
                    <label class="q-label" for="mnt-q">Uw rechtsvraag <span class="q-optional">optioneel</span></label>
                    <div class="ask-box">
                      <textarea id="mnt-q" rows="2" maxlength="500" placeholder="Optioneel. Bijv.: kan een huurovereenkomst worden ontbonden wegens overlast?"></textarea>
                      <div class="ask-foot">
                        <span class="ask-hint">Enter</span>
                        <button class="primary" type="submit"><span class="primary-label">Lees mee</span>${ICON.enter}</button>
                      </div>
                    </div>
                    <div class="recent"></div>
                  </form>
                </div>
              </div>
            </section>
            <div class="alert-slot"></div>
            <div class="screen"></div>
          </div>
          <footer class="ft">
            <div class="ft-actions"></div>
            <a class="ad" href="https://minuut.eu/?ref=leeswijzer" target="_blank" rel="noopener">
              <span class="ad-mark">M</span>
              <span class="ad-text"><b>Minuut</b> is de grondigste juridische AI van Nederland</span>
              <span class="ad-arrow">${ICON.arrow}</span>
            </a>
            <div class="privacy">${ICON.lock}<span>Niets bewaard · zero data retention</span></div>
          </footer>
        </aside>
      </div>`);
  }

  bind() {
    const form = this.$("form.ask");
    const ta = this.$("textarea");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = ta.value.trim();
      if (!q && !this.lastState?.question) return ta.focus();
      this.editing = false;
      this.on.ask(q);
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      } else if (e.key === "Escape") {
        this.editing = false;
        this.on.rerender();
      }
    });
    // Keep Rechtspraak.nl's (and our own j/k) key handlers out of the text field.
    for (const type of ["keydown", "keyup", "keypress"]) ta.addEventListener(type, (e) => e.stopPropagation());

    this.root.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el || el.disabled) return;
      const { act } = el.dataset;
      const v = el.dataset.v;
      if (act === "open") this.on.setOpen(true);
      else if (act === "close") this.on.setOpen(false);
      else if (act === "settings") this.on.settings();
      else if (act === "clear-q") {
        ta.value = "";
        this.editing = false;
        this.on.ask("");
      } else if (act === "edit-q") {
        this.editing = true;
        this.on.rerender();
        setTimeout(() => ta.focus(), cssMs(this.host, "--mnt-duration-fast", 250));
      } else if (act === "recent") {
        ta.value = el.dataset.q;
        this.editing = false;
        this.on.ask(el.dataset.q);
      } else if (act === "filter") this.on.filter(el.dataset.role);
      else if (act === "sort") this.on.sort(v);
      else if (act === "low-mode") this.on.lowMode(v);
      else if (act === "jump") this.on.jump(Number(el.dataset.seg));
      else if (act === "group") {
        this.groupOpen[el.dataset.group] = !this.groupOpen[el.dataset.group];
        this.on.rerender();
      } else if (act === "copy") this.on.copy(el);
      else if (act === "nav") this.on.nav(Number(el.dataset.dir));
      else if (act === "retry") this.on.retry();
      else if (act === "open-hit") this.on.openHits([el.dataset.href], true);
      else if (act === "open-top") this.on.openTop(Number(el.dataset.n));
      else if (act === "more-hits") this.on.moreHits();
      else if (act === "save-defaults") this.on.saveDefaults();
      else if (act === "hit-filter") this.on.hitFilter(v);
      else if (act === "reset-view") this.on.resetView();
    });
  }

  flashCopied(button, text) {
    const label = button.querySelector(".swap");
    if (!label) return;
    const before = label.textContent;
    swapText(label, text);
    button.classList.add("done");
    setTimeout(() => {
      swapText(label, before);
      button.classList.remove("done");
    }, 1800);
  }

  focusQuestion() {
    this.$("textarea").focus();
  }

  // ---- Render --------------------------------------------------------------

  render(s) {
    this.lastState = s;
    this.$(".panel").dataset.open = String(s.open);
    this.$(".shell").classList.toggle("is-open", s.open);
    document.documentElement.classList.toggle("mnt-panel-open", s.open);

    this.renderMascot(s);
    this.renderStatus(s);
    this.renderQuestion(s);
    this.renderAlert(s);

    const screen = s.mode === "ruling" ? (s.asked ? "ruling" : "intro") : s.mode === "results" ? (s.asked ? "results" : "results-intro") : s.mode;
    if (screen !== this.screen) this.buildScreen(screen, s);
    if (screen === "ruling") this.renderRuling(s);
    if (screen === "results") this.renderResults(s);
    if (screen === "ruling") this.renderDefaults(s, screen);
    if (screen === "intro") setNumber(this.$(".intro-count"), s.segments.filter((x) => x.kind === "ro").length);

    const pill = this.$(".pill-count");
    const n = s.mode === "results" ? s.hits.filter((h) => h.p >= MNT.RELEVANT).length : s.segments.filter((x) => MNT.tierOf(x.result) === "kern").length;
    pill.hidden = !n || !s.asked;
    pill.textContent = s.mode === "results" ? `${n} relevant` : `${n} kern`;
  }

  renderMascot(s) {
    let state = "idle";
    if (s.error && s.error.code !== "partial") state = "worried";
    else if (s.running || s.loadingHits) state = "thinking";
    else if (s.asked && s.progress && !s.running) state = "happy";
    MNT.setMascot(this.root, state);
  }

  renderStatus(s) {
    const el = this.$(".status-text");
    const wrap = this.$(".hd-status");
    const noun = s.mode === "results" ? "resultaten" : MNT.site.terms.many;
    let key = "idle";
    let text = "Klaar om mee te lezen";
    if (s.notice) {
      key = `notice:${s.notice}`;
      text = s.notice;
    } else if (s.loadingHits) {
      key = "loading";
      text = `Haalt resultaten op: ${s.loadingHits.have} van ${s.loadingHits.want}`;
    } else if (s.running && s.progress) {
      key = "running";
      text = `Leest mee: ${s.progress.done} van ${s.progress.total} ${noun}`;
    } else if (s.asked && s.progress) {
      key = "done";
      const secs = (s.progress.ms / 1000).toLocaleString("nl-NL", { maximumFractionDigits: 1 });
      text = `${s.progress.total} ${noun} gelezen${s.progress.cached ? "" : ` in ${secs} s`}`;
    } else if (s.mode === "results" && !s.question) {
      key = "wait";
      text = "Wacht op uw rechtsvraag";
    } else if (s.mode === "ruling" && !s.asked) {
      key = "ready";
      text = "Leest mee";
    }
    wrap.classList.toggle("shimmer", key === "running" || key === "loading");
    if (wrap.dataset.key !== key) {
      wrap.dataset.key = key;
      swapText(el, text);
    } else if (!el.classList.contains("is-exit")) {
      el.textContent = text;
    }
    el.dataset.text = text;
  }

  renderQuestion(s) {
    const q = this.$(".q");
    // The question is optional: closed by default, open while typing, and open
    // by itself only on search results without a question (nothing to do there).
    const editing = this.editing || (s.mode === "results" && !s.question);
    q.dataset.editing = String(editing);
    q.dataset.hasQ = String(Boolean(s.question));
    q.dataset.lead = String(s.mode === "results" && !s.question);
    this.$("textarea").placeholder =
      s.mode === "results"
        ? "Bijv.: kan een huurovereenkomst worden ontbonden wegens overlast?"
        : "Optioneel. Bijv.: kan een huurovereenkomst worden ontbonden wegens overlast?";
    this.$(".q-text").textContent = s.question;
    const ta = this.$("textarea");
    if (this.root.activeElement !== ta && ta.value !== s.question) ta.value = s.question;
    const clearing = !ta.value.trim() && s.question;
    this.$(".primary-label").textContent = clearing ? "Zonder vraag" : ({ results: "Lees resultaten", idle: "Bewaar vraag" }[s.mode] ?? "Lees mee");
    this.$(".primary").disabled = s.mode === "empty";
    const recent = s.recent.filter((x) => x !== s.question);
    const html = recent.length
      ? recent.map((x) => `<button type="button" class="chip" data-act="recent" data-q="${MNT.esc(x)}" title="${MNT.esc(x)}">${MNT.esc(x)}</button>`).join("")
      : "";
    const box = this.$(".recent");
    if (box.dataset.html !== html) {
      box.dataset.html = html;
      box.innerHTML = html;
    }
  }

  renderAlert(s) {
    const slot = this.$(".alert-slot");
    const msg = s.error ? s.error.message : "";
    if (slot.dataset.msg === msg) return;
    slot.dataset.msg = msg;
    if (!msg) {
      slot.replaceChildren();
      return;
    }
    const action = `<button type="button" class="link" data-act="retry">Opnieuw</button>`;
    slot.replaceChildren(MNT.h(`<div class="alert" role="alert"><span>${MNT.esc(msg)}</span>${action}</div>`));
  }

  // ---- Screens ---------------------------------------------------------------

  buildScreen(screen, s) {
    this.screen = screen;
    this.rows.clear();
    this.hitRows.clear();
    const box = this.$(".screen");
    const html =
      {
        idle: `<div class="intro reveal">
            <div class="intro-hero">${MNT.mascot(64)}</div>
            <p class="intro-lead r1">${MNT.esc(MNT.site.copy.idleLead)}</p>
            <p class="r2">${MNT.esc(MNT.site.copy.idleText)}</p>
          </div>`,
        empty: `<div class="intro reveal"><p class="intro-lead r1">Deze pagina heeft geen uitspraaktekst.</p><p class="r2">${MNT.esc(MNT.site.copy.empty)}</p></div>`,
        intro: `<div class="intro reveal">
            <p class="intro-lead r1"><span class="intro-count num"></span> ${MNT.site.terms.plural} gevonden.</p>
            <p class="r2">Leeswijzer zoekt de kernoverwegingen: waar de rechter zelf oordeelt over de inhoud en waar de beslissing op rust. De rest wordt verborgen. Met een rechtsvraag ziet u wat daarover gaat.</p>
          </div>`,
        "results-intro": `<div class="empty-state reveal">
            <div class="r1">${MNT.mascot(56)}</div>
            <p class="r2">Zonder vraag ziet u in elke uitspraak meteen de kernoverwegingen.</p>
          </div>`,
        ruling: `<div class="ruling">
            <section class="verdict" data-v="pending">
              <span class="v-dot"></span>
              <span class="v-word swap"></span>
              <span class="v-line swap"></span>
            </section>
            <div class="v-meta"><span class="num m-kern"></span> kernoverwegingen · <span class="num m-rel"></span> <span class="m-rel-label">raken uw vraag</span> · <span class="num m-all"></span> gelezen</div>
            <div class="ctl-row"><span class="ctl-label">Niet relevant</span>${tabsHtml("low-mode", MNT.LOW_MODES, `Niet-relevante ${MNT.site.terms.many}`)}</div>
            <div class="cats">${MNT.ROLES.map((r) => `<button type="button" class="cat cat-${r.key} is-btn" data-act="filter" data-role="${r.key}" aria-pressed="false" hidden>${r.label}<span class="num"></span></button>`).join("")}</div>
            <div class="defaults"></div>
            <div class="list-head"><span>Overwegingen</span>${tabsHtml("sort", [{ key: "rank", label: "Relevantie" }, { key: "doc", label: "Volgorde" }], "Volgorde")}</div>
            <div class="groups">
              ${GROUPS.map(
                (g) => `<section class="group" data-group="${g.key}" data-open="${this.groupOpen[g.key]}">
                  <button type="button" class="group-head" data-act="group" data-group="${g.key}"><span class="g-title">${g.title}</span><span class="num g-count"></span><span class="chev">${ICON.chevron}</span></button>
                  <div class="acc-panel"><div class="acc-inner"><ol class="list"></ol></div></div>
                </section>`,
              ).join("")}
              <section class="group flat" data-group="doc"><ol class="list"></ol></section>
            </div>
          </div>`,
        results: `<div class="results">
            <section class="tally" role="group" aria-label="Filter op oordeel">
              <button type="button" class="tl tl-ja" data-act="hit-filter" data-v="ja" aria-pressed="false"><i></i><span class="num n-ja"></span> ja</button>
              <button type="button" class="tl tl-deels" data-act="hit-filter" data-v="deels" aria-pressed="false"><i></i><span class="num n-deels"></span> deels</button>
              <button type="button" class="tl tl-nee" data-act="hit-filter" data-v="nee" aria-pressed="false"><i></i><span class="num n-nee"></span> nee</button>
            </section>
            <div class="ctl-row"><span class="ctl-label">Open de beste</span><div class="open-row">${TOP_N.map((n) => `<button type="button" class="ghost" data-act="open-top" data-n="${n}">${n}</button>`).join("")}</div></div>
            <div class="ctl-row nee-row"><span class="ctl-label">Nee-resultaten</span>${tabsHtml("low-mode", MNT.LOW_MODES.map((m) => (m.key === "fold" ? { ...m, label: "Dimmen" } : m)), "Resultaten die er niet over gaan")}</div>
            <div class="list-head"><span>Op relevantie</span></div>
            <ol class="list hits"></ol>
          </div>`,
      }[screen] ?? "";
    box.innerHTML = html;
    box.classList.remove("enter");
    void box.offsetHeight;
    box.classList.add("enter");
    this.$(".body").scrollTop = 0;
    for (const bar of box.querySelectorAll(".tabs")) delete bar.dataset.placed;

    const actions = this.$(".ft-actions");
    if (screen === "ruling") {
      actions.innerHTML = `<button type="button" class="secondary" data-act="copy">${ICON.copy}<span class="swap">Kopieer kernoverwegingen</span><span class="num ft-n"></span></button>
        <span class="nav"><button type="button" class="icon" data-act="nav" data-dir="-1" title="Vorige kernoverweging (k)">${ICON.up}</button><button type="button" class="icon" data-act="nav" data-dir="1" title="Volgende kernoverweging (j)">${ICON.down}</button></span>`;
    } else if (screen === "results") {
      actions.innerHTML = `<button type="button" class="secondary" data-act="more-hits"><span class="swap">Lees 50 meer</span><span class="ft-n"></span></button>`;
    } else {
      actions.innerHTML = "";
    }
    actions.hidden = !actions.innerHTML;
  }

  // "Standaard: …" with a way to keep the current view, or go back to it.
  renderDefaults(s, screen) {
    const box = this.$(".defaults");
    if (!box) return;
    const d = s.defaults;
    const modeLabel = { show: "tonen", fold: screen === "results" ? "dimmen" : "inklappen", hide: "verbergen" };
    const cats = d.filter.map((k) => MNT.ROLE_LABEL[k]).join(", ") || "alle categorieën";
    const same =
      s.lowMode === d.lowMode && (screen === "results" || (s.filter.size === d.filter.length && d.filter.every((k) => s.filter.has(k))));
    const text = screen === "results" ? `Standaard: niet-relevant ${modeLabel[d.lowMode]}` : `Standaard: ${cats} · ${modeLabel[d.lowMode]}`;
    const html = `<span class="def-text">${MNT.esc(text)}</span>${
      same ? "" : `<span class="def-actions"><button type="button" class="link small" data-act="reset-view">Terug</button><button type="button" class="link small strong" data-act="save-defaults">Maak dit standaard</button></span>`
    }`;
    if (box.dataset.html !== html) {
      box.dataset.html = html;
      box.innerHTML = html;
    }
  }

  renderRuling(s) {
    const judged = s.segments.filter((x) => x.result && !x.result.error);
    const kern = judged.filter((x) => MNT.tierOf(x.result) === "kern").length;
    const rel = judged.filter((x) => ["kern", "rel"].includes(MNT.tierOf(x.result))).length;

    // Verdict strip.
    const verdict = this.$(".verdict");
    if (s.verdict?.core) {
      verdict.dataset.v = kern ? "ja" : "nee";
      swapText(verdict.querySelector(".v-word"), String(kern));
      const noun = s.docNoun ?? "uitspraak";
      swapText(verdict.querySelector(".v-line"), kern === 1 ? `kernoverweging in deze ${noun}` : `kernoverwegingen in deze ${noun}`);
    } else if (s.verdict && !s.verdict.error) {
      const v = VERDICT.find((x) => s.verdict.p >= x.min);
      verdict.dataset.v = v.cls;
      swapText(verdict.querySelector(".v-word"), v.word);
      swapText(verdict.querySelector(".v-line"), v.line);
    } else {
      verdict.dataset.v = s.verdict?.error ? "nee" : "pending";
      swapText(verdict.querySelector(".v-word"), s.verdict?.error ? "?" : "…");
      swapText(verdict.querySelector(".v-line"), s.verdict?.error ? `geen oordeel over de hele ${s.docNoun ?? "uitspraak"}` : `leest de ${s.docNoun ?? "uitspraak"}`);
    }
    setNumber(this.$(".m-kern"), kern);
    setNumber(this.$(".m-rel"), rel);
    this.$(".m-rel-label").textContent = s.question ? "raken uw vraag" : "met een eigen oordeel";
    setNumber(this.$(".m-all"), judged.length);

    setTabs(this.$('[data-tabs="low-mode"]'), s.lowMode);
    setTabs(this.$('[data-tabs="sort"]'), s.sort);

    // Category filter chips.
    const counts = {};
    for (const x of judged) counts[x.result.role] = (counts[x.result.role] || 0) + 1;
    const cats = this.$(".cats");
    cats.classList.toggle("has-filter", s.filter.size > 0);
    for (const chip of cats.querySelectorAll(".cat")) {
      const n = counts[chip.dataset.role] ?? 0;
      chip.hidden = !n;
      chip.setAttribute("aria-pressed", String(s.filter.has(chip.dataset.role)));
      setNumber(chip.querySelector(".num"), n);
    }

    // Rows, grouped by tier (relevance order) or flat (document order).
    const rows = MNT.visibleRows(s);
    const before = new Map([...this.rows.values()].filter((n) => n.isConnected).map((n) => [n, n.getBoundingClientRect()]));
    const nodes = rows.map((x) => this.row(x));
    const groups = this.$(".groups");
    groups.dataset.sort = s.sort;
    if (s.sort === "doc") {
      place(this.$('[data-group="doc"] .list'), nodes);
      for (const g of GROUPS) place(this.$(`[data-group="${g.key}"] .list`), []);
    } else {
      place(this.$('[data-group="doc"] .list'), []);
      for (const g of GROUPS) {
        const inGroup = rows.filter((x) => MNT.tierOf(x.result) === g.key || (g.key === "doubt" && ["pending", "error"].includes(MNT.tierOf(x.result))));
        const section = this.$(`[data-group="${g.key}"]`);
        section.querySelector(".g-title").textContent = (s.question ? GROUP_TITLES_QUESTION : GROUP_TITLES_CORE)[g.key];
        section.hidden = !inGroup.length;
        section.dataset.open = String(this.groupOpen[g.key]);
        setNumber(section.querySelector(".g-count"), inGroup.length);
        place(section.querySelector(".list"), inGroup.map((x) => this.rows.get(x.id)));
      }
    }
    flip(nodes, before);

    const copy = this.$('[data-act="copy"]');
    if (copy) {
      copy.disabled = !kern;
      setNumber(copy.querySelector(".ft-n"), kern);
      for (const b of this.root.querySelectorAll('[data-act="nav"]')) b.disabled = !kern;
    }
  }

  row(x) {
    let node = this.rows.get(x.id);
    if (!node) {
      node = MNT.h(`<li class="row-li"><button type="button" class="row" data-act="jump" data-seg="${x.id}">
          <span class="row-nr">${MNT.esc(x.nr ?? "§")}</span>
          <span class="row-main"><span class="row-meta"></span><span class="row-snip">${MNT.esc(snippetOf(x))}</span></span>
        </button></li>`);
      this.rows.set(x.id, node);
    }
    const tier = MNT.tierOf(x.result);
    const r = x.result;
    const key = `${tier}|${r?.role ?? ""}`;
    if (node.dataset.key !== key) {
      const fresh = node.dataset.key?.startsWith("pending") && tier !== "pending";
      node.dataset.key = key;
      node.firstElementChild.className = `row t-${tier}`;
      const chip =
        r && !r.error
          ? `<span class="cat cat-${MNT.esc(r.role)}">${MNT.esc(MNT.ROLE_LABEL[r.role] ?? r.role)}</span>`
          : tier === "error"
            ? `<span class="cat">Niet gelezen</span>`
            : `<span class="cat skel"></span>`;
      const note = tier === "kern" ? `<span class="row-note kern">Kern</span>` : "";
      node.querySelector(".row-meta").innerHTML = note + chip;
      if (fresh) {
        node.classList.remove("landed");
        void node.offsetHeight;
        node.classList.add("landed");
      }
    }
    return node;
  }

  renderResults(s) {
    const tally = { ja: 0, deels: 0, nee: 0 };
    for (const h of s.hits) if (h.p != null) tally[MNT.hitVerdict(h.p)]++;
    for (const k of Object.keys(tally)) setNumber(this.$(`.n-${k}`), tally[k]);
    const tallyEl = this.$(".tally");
    tallyEl.classList.toggle("has-filter", s.hitFilter.size > 0);
    // A chosen filter decides what shows; the nee setting only applies without one.
    const neeRow = this.$(".nee-row");
    neeRow.classList.toggle("is-inactive", s.hitFilter.size > 0);
    neeRow.title = s.hitFilter.size ? "Geldt alleen zonder filter op ja / deels / nee" : "";
    for (const b of tallyEl.querySelectorAll(".tl")) b.setAttribute("aria-pressed", String(s.hitFilter.has(b.dataset.v)));
    setTabs(this.$('[data-tabs="low-mode"]'), s.lowMode);
    const judged = s.hits.filter((h) => h.p != null).length;
    for (const b of this.root.querySelectorAll('[data-act="open-top"]')) b.disabled = !judged;

    const ranked = [...s.hits].sort((a, b) => (b.p ?? -1) - (a.p ?? -1));
    const shown = s.hitFilter.size
      ? ranked.filter((h) => h.p != null && s.hitFilter.has(MNT.hitVerdict(h.p)))
      : s.lowMode === "hide"
        ? ranked.filter((h) => h.p == null || MNT.hitVerdict(h.p) !== "nee")
        : ranked;
    const before = new Map([...this.hitRows.values()].filter((n) => n.isConnected).map((n) => [n, n.getBoundingClientRect()]));
    const nodes = shown.map((h) => this.hitRow(h));
    place(this.$(".list.hits"), nodes);
    flip(nodes, before);

    const more = this.$('[data-act="more-hits"]');
    if (more) {
      more.disabled = Boolean(s.loadingHits || s.running || s.hitsExhausted);
      more.querySelector(".ft-n").textContent = `${s.hits.length}${s.hitsTotal ? ` van ${s.hitsTotal.toLocaleString("nl-NL")}` : ""}`;
    }
  }

  hitRow(h) {
    let node = this.hitRows.get(h.ecli);
    if (!node) {
      node = MNT.h(`<li class="row-li"><button type="button" class="row hit" data-act="open-hit" data-href="${MNT.esc(h.href)}" title="${MNT.esc(h.ecli)} · open in een nieuw tabblad">
          <span class="hit-dot"><i></i></span>
          <span class="row-main">
            <span class="hit-line"><span class="hit-title">${MNT.esc(h.court || h.ecli)}</span><span class="hit-date">${MNT.esc(h.date || "")}</span></span>
            <span class="hit-snip">${MNT.esc(h.inhoudsindicatie || "Geen inhoudsindicatie")}</span>
          </span>
        </button></li>`);
      this.hitRows.set(h.ecli, node);
    }
    const v = h.p == null ? (h.error ? "error" : "pending") : MNT.hitVerdict(h.p);
    if (node.dataset.v !== v) {
      const fresh = node.dataset.v === "pending";
      node.dataset.v = v;
      node.firstElementChild.className = `row hit t-${v}`;
      if (fresh) {
        node.classList.remove("landed");
        void node.offsetHeight;
        node.classList.add("landed");
      }
    }
    return node;
  }
};

// Rows in the panel list for the current filter and sort.
MNT.visibleRows = (s) => {
  let rows = s.segments.filter((x) => !s.filter.size || (x.result && !x.result.error && s.filter.has(x.result.role)));
  if (s.sort === "rank") rows = [...rows].sort((a, b) => MNT.rankOf(b.result) - MNT.rankOf(a.result) || a.id - b.id);
  return rows;
};
