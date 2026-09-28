// Minuut Leeswijzer: controller. Watches the page (Rechtspraak.nl and Curia are
// single-page apps), segments each ruling, asks Jev about every segment or
// search hit, and keeps the panel, the ruling and the result list in step with
// one state object. What differs per site lives in src/sites.js.

(() => {
  const MNT = globalThis.MNT;
  const site = MNT.site;
  // EUR-Lex also holds legislation: stay out of everything but case law.
  if (!site.active()) return;
  const TICK_MS = 600;
  const RECENT_MAX = 5;
  const HIT_BATCH = 50;

  const S = {
    open: true,
    mode: "idle", // idle | ruling | empty | results
    question: "",
    asked: false,
    recent: [],
    running: false,
    progress: null,
    notice: "",
    verdict: null,
    segments: [],
    filter: new Set(),
    sort: "rank",
    lowMode: "hide",
    // The view every new ruling opens with; adjustable from the panel.
    // Kader too: in a Hoge Raad arrest the core is often the rule itself.
    defaults: { filter: ["kader", "toepassing"], lowMode: "hide" },
    error: null,
    hits: [],
    hitFilter: new Set(), // "ja" | "deels" | "nee"; empty = all
    hitsTotal: 0,
    hitsExhausted: false,
    loadingHits: null,
  };
  const ctx = {
    runId: 0,
    href: "",
    root: null,
    firstWrap: null,
    meta: null,
    forcedOpen: new Set(),
    navAt: -1,
    autoRun: true,
    hitVerdicts: new Map(), // ecli -> { pending } | { p } | { error }
    hitsQuestion: "",
    hitTarget: HIT_BATCH,
    hitRun: 0,
    emptyTicks: 0,
  };

  // Tabs opened in the background (e.g. "Top 25") start reading only when the
  // lawyer looks at them: no burst of calls, no cost for tabs never read.
  function whenVisible(fn) {
    if (!document.hidden) return fn();
    const href = location.href;
    const onShow = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onShow);
      if (location.href === href) fn();
    };
    document.addEventListener("visibilitychange", onShow);
  }

  let renderTimer = 0;
  const schedule = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      panel.render(S);
    }, 60);
  };
  const notify = (text) => {
    S.notice = text;
    schedule();
    setTimeout(() => {
      if (S.notice === text) {
        S.notice = "";
        schedule();
      }
    }, 3500);
  };

  // ---- Ruling ---------------------------------------------------------------

  function setupRuling(root) {
    ctx.runId++;
    ctx.root = root;
    ctx.href = location.href;
    ctx.meta = site.readMeta(root);
    // An advocate general's opinion is not an "uitspraak" in the panel.
    S.docNoun = ctx.meta.court === "de advocaat-generaal" ? "conclusie" : "uitspraak";
    ctx.forcedOpen.clear();
    ctx.navAt = -1;
    const segments = site.segment(root);
    for (const seg of segments) {
      MNT.wrapSegment(seg);
      MNT.decorateSegment(seg, toggleFold);
      seg.result = null;
    }
    ctx.firstWrap = segments[0]?.wraps[0] ?? null;
    Object.assign(S, {
      mode: "ruling",
      segments,
      asked: false,
      running: false,
      progress: null,
      verdict: null,
      error: null,
      filter: new Set(S.defaults.filter),
      lowMode: S.defaults.lowMode,
    });
    schedule();
    // With the panel open, every ruling summarises its core by itself; a closed
    // panel means the extension is off and the page stays untouched.
    if (S.open && ctx.autoRun && segments.length) whenVisible(runRuling);
  }

  // How a segment shows: tinted and labelled, or folded / hidden when it does
  // not touch the question or falls outside the category filter.
  // What one segment should look like, before runs are taken into account.
  function viewOf(seg) {
    const r = seg.result;
    const tier = MNT.tierOf(r);
    const judged = r && !r.error;
    const filtered = S.filter.size > 0 && judged && !S.filter.has(r.role);
    const irrelevant = tier === "low" && S.lowMode !== "show";
    const forced = ctx.forcedOpen.has(seg.id);
    let mode = "show";
    if (filtered) mode = S.lowMode === "show" ? "fold" : S.lowMode;
    else if (irrelevant) mode = S.lowMode;
    const wouldHide = mode === "hide";
    if (forced && mode !== "show") mode = "show";
    return {
      tier,
      result: r,
      mode,
      reason: filtered ? "filtered" : "low",
      // In hide mode the run's marker line handles opening and closing.
      forcedOpen: forced && (filtered || irrelevant) && !wouldHide,
      wouldHide,
      skip: null,
    };
  }

  // Hidden r.o.'s leave no gap: each run of consecutive hidden ones (within a
  // section) is replaced by one thin marker line, "2 overwegingen overgeslagen".
  function applyAll() {
    if (!S.asked) {
      for (const seg of S.segments) MNT.clearSegment(seg);
      MNT.collapseEmpty(ctx.root);
      return;
    }
    const views = S.segments.map(viewOf);
    ctx.skipRuns = new Map();
    let run = null;
    S.segments.forEach((seg, i) => {
      const prev = S.segments[i - 1];
      if (!views[i].wouldHide || (prev && prev.section !== seg.section)) run = null;
      if (!views[i].wouldHide) return;
      if (!run) {
        run = [];
        ctx.skipRuns.set(seg.id, run);
      }
      run.push(seg.id);
    });
    for (const [leader, ids] of ctx.skipRuns) {
      const open = ids.every((id) => ctx.forcedOpen.has(id));
      views[leader].skip = { count: ids.length, first: S.segments[ids[0]].nr, last: S.segments[ids[ids.length - 1]].nr, open };
    }
    S.segments.forEach((seg, i) => MNT.renderSegment(seg, views[i]));
    MNT.collapseEmpty(ctx.root);
  }
  const applySegment = () => applyAll();

  function rulingText() {
    const ordered = [...S.segments].sort(
      (a, b) => Number(site.prioritySection.test(b.section)) - Number(site.prioritySection.test(a.section)) || a.id - b.id,
    );
    return ordered.map((s) => (s.nr ? `${s.nr} ${s.text}` : s.text)).join("\n\n");
  }

  async function runRuling() {
    const id = ++ctx.runId;
    const question = S.question;
    const cancelled = () => id !== ctx.runId;
    const started = performance.now();
    let allCached = true;
    let stopped = false;

    for (const seg of S.segments) seg.result = null;
    ctx.forcedOpen.clear();
    ctx.jumped = false;
    ctx.userScrolled = false;
    for (const seg of S.segments) {
      seg.sentencesAsked = false;
      MNT.unmarkSentences?.(seg);
    }
    Object.assign(S, { asked: true, running: true, error: null, verdict: null, progress: { done: 0, total: S.segments.length, ms: 0, cached: false } });
    applyAll();
    schedule();

    const core = !question;
    const court = ctx.meta.court ?? MNT.courtOf(ctx.meta.instantie);
    // EU pages name their language; the Worker then asks its EU questions in
    // that language. Rechtspraak.nl sends nothing and keeps its own templates.
    const lang = site.euLang?.(ctx.meta);
    const verdictTask = (core ? Promise.resolve(null) : MNT.evaluate("ruling", question, MNT.rulingState(ctx.meta, rulingText()), undefined, undefined, lang)).then(
      (d) => {
        if (cancelled()) return;
        if (!d) {
          S.verdict = { core: true };
          return schedule();
        }
        allCached &&= d.cached;
        S.verdict = { p: MNT.unit(d.answers?.over?.probability) };
        schedule();
      },
      (err) => {
        if (cancelled()) return;
        S.verdict = { error: true };
        if (err.code === "request") {
          stopped = true;
          S.error = err;
        }
        schedule();
      },
    );

    await MNT.pool(
      S.segments,
      async (seg) => {
        try {
          const d = core
            ? await MNT.evaluate("core", "", MNT.segmentState(ctx.meta, seg), undefined, court, lang)
            : await MNT.evaluate("segment", question, MNT.segmentState(ctx.meta, seg), undefined, site.speakerInQuestion ? court : undefined, lang);
          if (cancelled()) return;
          allCached &&= d.cached;
          const read = core ? MNT.readCoreAnswers(d.answers) : MNT.readSegmentAnswers(d.answers);
          seg.result = { ...read, summary: MNT.SUMMARY_SECTION.test(seg.section), ...(lang ? { eu: true } : {}) };
        } catch (err) {
          if (cancelled()) return;
          seg.result = { error: err.message };
          if (err.code === "request") {
            stopped = true;
            S.error = err;
          }
        }
        S.progress.done++;
        applySegment(seg);
        watchSentences(seg);
        maybeJumpToFirst();
        schedule();
      },
      () => cancelled() || stopped,
    );
    await verdictTask;
    if (cancelled()) return;
    S.running = false;
    S.progress.ms = performance.now() - started;
    S.progress.cached = allCached;
    const failed = S.segments.filter((s) => s.result?.error).length;
    if (!S.error && failed) S.error = { code: "partial", message: `${failed} van de ${S.segments.length} overwegingen kregen geen oordeel.` };
    schedule();
  }

  // ---- Jump to the first relevant r.o. --------------------------------------
  // As soon as every r.o. above it has been judged, bring the first one that
  // touches the question into view, unless the reader has scrolled meanwhile.
  const isRelevant = (seg) => ["kern", "rel"].includes(MNT.tierOf(seg.result));
  function firstRelevant() {
    for (const seg of S.segments) {
      if (!seg.result) return null; // an earlier r.o. is still being judged
      if (isRelevant(seg) && (!S.filter.size || S.filter.has(seg.result.role))) return seg;
    }
    return null;
  }
  function maybeJumpToFirst() {
    if (ctx.jumped || ctx.userScrolled) return;
    const seg = firstRelevant();
    if (!seg) return;
    ctx.jumped = true;
    // Let the fold/hide accordion settle first so the target does not move.
    setTimeout(() => MNT.flashSegment(seg), 380);
  }
  for (const type of ["wheel", "touchmove"]) window.addEventListener(type, () => (ctx.userScrolled = true), { passive: true });
  window.addEventListener("keydown", (e) => {
    if (["PageDown", "PageUp", "ArrowDown", "ArrowUp", " ", "Home", "End"].includes(e.key)) ctx.userScrolled = true;
  });

  // ---- Sentences, fetched when a relevant r.o. comes into view -------------
  const sentenceObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        sentenceObserver.unobserve(entry.target);
        const seg = S.segments[Number(entry.target.dataset.mntSeg)];
        if (seg) loadSentences(seg);
      }
    },
    { rootMargin: "300px 0px" },
  );
  function watchSentences(seg) {
    if (isRelevant(seg) && !seg.sentencesAsked) sentenceObserver.observe(seg.wraps[0]);
  }
  async function loadSentences(seg) {
    if (seg.sentencesAsked || !isRelevant(seg)) return;
    seg.sentencesAsked = true;
    let text = seg.text.replace(/^(?:r\.?\s?o\.?\s*)?\d{1,2}(?:\.\d{1,3}){0,4}\.?\s+/i, "");
    // An opinion's footnote markers "(20)" are not part of a sentence.
    if (site.footnotes) text = text.replace(site.footnotes, "");
    const sentences = MNT.splitSentences(text);
    if (sentences.length < 2) return;
    const id = ctx.runId;
    try {
      const d = await MNT.evaluate("sentences", S.question, MNT.sentenceState(ctx.meta, seg, S.question), sentences, undefined, site.euLang?.(ctx.meta));
      if (id !== ctx.runId) return;
      MNT.markSentences(seg, MNT.pickSentences(d.answers, sentences));
    } catch {
      // Marks are a bonus; the r.o. itself is already judged and shown.
    }
  }

  function toggleFold(seg) {
    const run = ctx.skipRuns?.get(seg.id) ?? [seg.id];
    const open = run.every((id) => ctx.forcedOpen.has(id));
    for (const id of run) open ? ctx.forcedOpen.delete(id) : ctx.forcedOpen.add(id);
    applyAll();
  }

  function jump(id) {
    const seg = S.segments[id];
    if (!seg) return;
    if (seg.wraps.some((w) => w.classList.contains("mnt-folded") || w.classList.contains("mnt-hidden"))) {
      ctx.forcedOpen.add(seg.id);
      applySegment(seg);
    }
    MNT.flashSegment(seg);
  }

  // Only kernoverwegingen are marked, copied and navigated.
  const isMarked = (seg) => MNT.tierOf(seg.result) === "kern";

  function nav(dir) {
    const marked = MNT.visibleRows(S).filter(isMarked);
    if (!marked.length) return;
    ctx.navAt = (ctx.navAt + dir + marked.length) % marked.length;
    jump(marked[ctx.navAt].id);
  }

  async function copyMarked(button) {
    const marked = S.segments.filter(isMarked);
    if (!marked.length) return;
    const m = ctx.meta;
    const head = `${m.ecli}${m.instantie ? ` (${m.instantie}${m.datum ? `, ${m.datum}` : ""})` : ""}`;
    const body = (seg) => seg.text.replace(/^(?:r\.?\s?o\.?\s*)?\d{1,2}(?:\.\d{1,3}){0,4}\.?\s+/i, "");
    const label = (seg) => (seg.nr ? `${site.terms.short} ${seg.nr}` : seg.section || "Passage");
    const plain = [head, ...marked.map((s) => `${label(s)}\n${body(s)}`)].join("\n\n");
    const html = `<p><strong>${MNT.esc(head)}</strong></p>${marked
      .map((s) => `<p><strong>${MNT.esc(label(s))}</strong></p>${body(s).split("\n").map((l) => `<p>${MNT.esc(l)}</p>`).join("")}`)
      .join("")}`;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": new Blob([plain], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) }),
      ]);
    } catch {
      await navigator.clipboard.writeText(plain);
    }
    panel.flashCopied(button, `${marked.length} gekopieerd`);
  }

  // ---- Search results ------------------------------------------------------

  function readTotal() {
    const el = [...document.querySelectorAll("h1, h2, h3, span, div")].find(
      (e) => e.childElementCount === 0 && /^Resultaten\s*\(\d/.test(e.textContent.trim()),
    );
    return Number(el?.textContent.replace(/\D/g, "")) || 0;
  }

  // Sync badges on the site's list and the panel's ranked list; judge new hits.
  function scanHits() {
    const hits = MNT.readHits();
    if (!S.asked || !S.question) {
      for (const hit of hits) MNT.renderHit(hit, null, S.lowMode);
      S.hits = [];
      return;
    }
    if (ctx.hitsQuestion !== S.question) {
      ctx.hitVerdicts.clear();
      ctx.hitsQuestion = S.question;
    }
    const fresh = hits.filter((h) => !ctx.hitVerdicts.has(h.ecli));
    if (fresh.length) judgeHits(fresh, S.question);

    let done = 0;
    for (const hit of hits) {
      const entry = ctx.hitVerdicts.get(hit.ecli);
      const key = `${S.question}|${S.lowMode}|${[...S.hitFilter].join()}|${entry?.pending ? "pending" : entry?.error ? "error" : entry?.p}`;
      if (hit.el.dataset.mntHit !== key || !hit.el.querySelector(":scope > .mnt-hit")) {
        MNT.renderHit(hit, entry, S.lowMode, S.hitFilter);
        hit.el.dataset.mntHit = key;
      }
      if (entry && !entry.pending) done++;
    }
    S.hits = hits.map(({ el, ...h }) => {
      const entry = ctx.hitVerdicts.get(h.ecli);
      return { ...h, p: entry?.p ?? null, error: entry?.error ?? null };
    });
    S.hitsTotal = readTotal() || S.hitsTotal;
    if (S.loadingHits) S.loadingHits.have = hits.length;
    S.running = hits.some((h) => ctx.hitVerdicts.get(h.ecli)?.pending);
    S.progress = { done, total: hits.length, ms: S.progress?.ms ?? 0, cached: false };
    const signature = JSON.stringify([S.hits.map((h) => [h.ecli, h.p, h.error]), S.running, S.loadingHits, S.hitsTotal, S.hitsExhausted, S.error?.message, [...S.hitFilter], S.lowMode]);
    if (signature !== ctx.hitsSignature) {
      ctx.hitsSignature = signature;
      schedule();
    }
  }

  async function judgeHits(hits, question) {
    const started = performance.now();
    for (const hit of hits) ctx.hitVerdicts.set(hit.ecli, { pending: true });
    await MNT.pool(
      hits,
      async (hit) => {
        try {
          const d = await MNT.evaluate("ruling", question, MNT.hitState(hit));
          if (ctx.hitsQuestion === question) ctx.hitVerdicts.set(hit.ecli, { p: MNT.unit(d.answers?.over?.probability) });
        } catch (err) {
          if (ctx.hitsQuestion === question) ctx.hitVerdicts.set(hit.ecli, { error: err.message });
          if (err.code === "request") S.error = err;
        }
        scanHits();
      },
      () => ctx.hitsQuestion !== question,
    );
    if (S.progress) S.progress.ms = performance.now() - started;
    scanHits();
  }

  // Load hits up to the current target with Rechtspraak.nl's own button, then
  // let scanHits judge whatever appeared.
  async function runHits() {
    const id = ++ctx.hitRun;
    S.asked = true;
    S.error = null;
    S.loadingHits = { have: document.querySelectorAll(".rnl-listresults-item-container").length, want: ctx.hitTarget };
    scanHits();
    const have = await MNT.loadHitsUntil(ctx.hitTarget, () => id !== ctx.hitRun);
    if (id !== ctx.hitRun) return;
    S.loadingHits = null;
    S.hitsExhausted = have < ctx.hitTarget;
    scanHits();
  }

  function openHits(urls, active = false) {
    return chrome.runtime.sendMessage({ type: "open-tabs", urls, active });
  }

  function openTop(n) {
    const ranked = S.hits
      .filter((h) => h.p != null && (S.hitFilter.size ? S.hitFilter.has(MNT.hitVerdict(h.p)) : MNT.hitVerdict(h.p) !== "nee"))
      .sort((a, b) => b.p - a.p)
      .slice(0, n);
    if (!ranked.length) return notify("Nog geen relevante resultaten om te openen.");
    openHits(ranked.map((h) => h.href));
    const fewer = ranked.length < n ? ` (er zijn er ${ranked.length} relevant)` : "";
    notify(`${ranked.length} uitspraken geopend in nieuwe tabbladen${fewer}.`);
  }

  // ---- Page watching --------------------------------------------------------

  function switchOff() {
    ctx.runId++;
    ctx.hitRun++;
    ctx.hitsQuestion = "";
    Object.assign(S, { asked: false, running: false, progress: null, verdict: null, error: null, loadingHits: null });
    for (const seg of S.segments) {
      seg.result = null;
      seg.sentencesAsked = false;
      MNT.unmarkSentences(seg);
      MNT.clearSegment(seg);
    }
    if (S.mode === "results") scanHits();
  }

  function resetRuling() {
    ctx.runId++;
    ctx.root = null;
    ctx.firstWrap = null;
    Object.assign(S, { segments: [], verdict: null, progress: null, running: false, error: null, filter: new Set() });
  }

  function tick() {
    if (site.isRuling()) {
      const root = site.findRoot();
      if (root) {
        ctx.emptyTicks = 0;
        const stale = root !== ctx.root || ctx.href !== location.href || (ctx.firstWrap && !root.contains(ctx.firstWrap));
        if (stale) setupRuling(root);
      } else if (site.isTextless()) {
        // A ruling page without text. Wait two ticks to be sure.
        if (++ctx.emptyTicks >= 2 && S.mode !== "empty") {
          resetRuling();
          S.mode = "empty";
          schedule();
        }
      }
      return;
    }
    if (S.mode === "ruling" || S.mode === "empty") resetRuling();
    if (site.isResults()) {
      if (S.mode !== "results" || ctx.href !== location.href) {
        S.mode = "results";
        ctx.href = location.href;
        ctx.hitTarget = HIT_BATCH;
        ctx.hitRun++;
        Object.assign(S, { asked: false, progress: null, error: null, hits: [], hitFilter: new Set(), hitsExhausted: false, loadingHits: null, lowMode: S.defaults.lowMode });
        if (S.open && ctx.autoRun && S.question) whenVisible(runHits);
        schedule();
      }
      scanHits();
      return;
    }
    if (S.mode !== "idle") {
      Object.assign(S, { mode: "idle", asked: false, progress: null });
      schedule();
    }
  }

  // ---- Intents from the panel ----------------------------------------------

  const panel = new MNT.Panel({
    // An empty question means the general mode: find the kernoverwegingen.
    ask(q) {
      S.question = q;
      if (q) S.recent = [q, ...S.recent.filter((x) => x !== q)].slice(0, RECENT_MAX);
      MNT.session.set({ question: q, recent: S.recent });
      if (S.mode === "ruling") runRuling();
      else if (S.mode === "results") {
        ctx.hitsQuestion = "";
        S.hitFilter = new Set();
        if (q) runHits();
        else {
          S.asked = false;
          scanHits();
        }
      } else if (S.mode === "idle") {
        const hint = site.id === "rechtspraak" ? "Zoek nu op Rechtspraak.nl; de resultaten worden meteen beoordeeld." : "Open nu een uitspraak.";
        notify(q ? `Vraag bewaard. ${hint}` : "Zonder vraag toont Leeswijzer in elke uitspraak de kernoverwegingen.");
      }
      schedule();
    },
    // Open = on: read what is on screen. Closed = off: stop, and give the page
    // back exactly as Rechtspraak.nl shows it.
    setOpen(open) {
      S.open = open;
      MNT.storage.set({ panelOpen: open });
      if (open) {
        if (S.mode === "ruling" && S.segments.length) runRuling();
        else if (S.mode === "results" && S.question) runHits();
      } else {
        switchOff();
      }
      schedule();
    },
    settings: () => chrome.runtime.sendMessage({ type: "open-options" }),
    filter(role) {
      if (!role) S.filter = new Set();
      else if (S.filter.has(role)) S.filter.delete(role);
      else S.filter.add(role);
      ctx.forcedOpen.clear();
      ctx.navAt = -1;
      applyAll();
      schedule();
      const first = firstRelevant();
      if (first) setTimeout(() => MNT.flashSegment(first), 380);
    },
    sort(sort) {
      S.sort = sort;
      ctx.navAt = -1;
      MNT.storage.set({ sort });
      schedule();
    },
    lowMode(mode) {
      S.lowMode = mode;
      ctx.forcedOpen.clear();
      applyAll();
      if (S.mode === "ruling" && mode === "hide") {
        const first = firstRelevant();
        if (first) setTimeout(() => MNT.flashSegment(first), 380);
      }
      if (S.mode === "results") scanHits();
      schedule();
    },
    hitFilter(v) {
      if (S.hitFilter.has(v)) S.hitFilter.delete(v);
      else S.hitFilter.add(v);
      scanHits();
      schedule();
    },
    saveDefaults() {
      S.defaults = { filter: [...S.filter], lowMode: S.lowMode };
      MNT.storage.set({ defaults: S.defaults });
      notify("Standaardweergave bewaard.");
    },
    resetView() {
      S.filter = new Set(S.defaults.filter);
      S.lowMode = S.defaults.lowMode;
      ctx.forcedOpen.clear();
      applyAll();
      if (S.mode === "results") scanHits();
      schedule();
      const first = S.mode === "ruling" && firstRelevant();
      if (first) setTimeout(() => MNT.flashSegment(first), 380);
    },
    jump,
    nav,
    copy: copyMarked,
    openHits,
    openTop,
    moreHits() {
      ctx.hitTarget = Math.max(ctx.hitTarget, S.hits.length) + HIT_BATCH;
      runHits();
    },
    retry() {
      if (S.mode === "ruling") runRuling();
      else if (S.mode === "results") {
        ctx.hitsQuestion = "";
        runHits();
      }
    },
    rerender: schedule,
  });

  // j / k: next / previous kernoverweging, like a reader's shortcut.
  document.addEventListener("keydown", (e) => {
    if (S.mode !== "ruling" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.id === "mnt-host")) return;
    if (e.key === "j") nav(1);
    else if (e.key === "k") nav(-1);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "toggle-panel") panel.on.setOpen(!S.open);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.autoRun) ctx.autoRun = changes.autoRun.newValue !== false;
    // The question is shared by all tabs: a change in one tab reaches the
    // others (a tab in the background applies it when it is viewed).
    if (area === "session" && changes.question) {
      const q = changes.question.newValue ?? "";
      if (q === S.question) return;
      S.question = q;
      if (changes.recent?.newValue) S.recent = changes.recent.newValue;
      ctx.hitsQuestion = "";
      S.hitFilter = new Set();
      if (S.open && S.mode === "ruling" && S.segments.length) whenVisible(runRuling);
      else if (S.open && S.mode === "results") {
        if (q) whenVisible(runHits);
        else {
          S.asked = false;
          scanHits();
        }
      }
      schedule();
    }
  });

  (async () => {
    const saved = await MNT.storage.get(["panelOpen", "sort", "lowMode", "autoRun", "defaults"]);
    const session = await MNT.session.get(["question", "recent"]).catch(() => ({}));
    S.open = saved.panelOpen !== false;
    S.question = session.question ?? "";
    S.recent = session.recent ?? [];
    S.sort = saved.sort ?? "rank";
    if (saved.defaults) S.defaults = saved.defaults;
    S.lowMode = S.defaults.lowMode;
    ctx.autoRun = saved.autoRun !== false;
    // The strip the page frees for the panel takes the site's own background.
    const pageBg = getComputedStyle(document.querySelector("main") ?? document.body).backgroundColor;
    if (pageBg && pageBg !== "rgba(0, 0, 0, 0)") document.documentElement.style.setProperty("--mnt-page-bg", pageBg);
    document.documentElement.classList.add(`mnt-site-${site.id}`);
    panel.mount();
    schedule();
    tick();
    setInterval(tick, TICK_MS);
  })();
})();
