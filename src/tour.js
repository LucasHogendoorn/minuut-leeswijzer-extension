// Minuut Leeswijzer: the guided tour on a ruling page. Coach marks with a
// spotlight over the real panel and the real ruling, one step at a time.
// Runs only when the page was opened from the welcome page or from
// "Rondleiding opnieuw bekijken" (a one-shot flag in chrome.storage.session
// that content.js consumes); never on a normal visit.
//
// The tour owns nothing: it reads the controller's state, points at what the
// panel and the ruling already show, and waits for the model where a step
// needs a judged overweging. Everything lives in its own shadow root under
// #mnt-tour-host, above the panel.

(() => {
  const MNT = (globalThis.MNT = globalThis.MNT || {});

  // The example question of the tour: the ruling is Haviltex, the question
  // is what it decided. Also used by options/options.js for the copy there.
  const EXAMPLE_QUESTION = "Welke maatstaf geldt bij de uitleg van een schriftelijke overeenkomst?";
  const PAD = 6;
  const CARD_W = 344;
  const GAP = 14;
  const MOVE_MS = 420;
  const POLL_MS = 200;

  const KBD = (k) => `<kbd>${k}</kbd>`;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const visible = (el) => Boolean(el && el.isConnected && el.getClientRects().length);
  const isFolded = (seg) => seg.wraps.some((w) => w.classList.contains("mnt-folded") || w.classList.contains("mnt-hidden"));

  // Steps. `target` returns the element to spotlight (page or panel shadow),
  // `ready` says whether the step can show (otherwise the card waits, with
  // `waiting` as text), `done` auto-advances once the reader did the thing,
  // `enter` runs when the step opens.
  const STEPS = [
    {
      key: "paneel",
      title: "Dit is de Leeswijzer",
      body: () =>
        `Rechts staat het paneel. De mascotte leest de uitspraak mee en de regel eronder laat zien hoever hij is. U hoeft niets te doen: dit gebeurt in elke uitspraak die u opent.`,
      target: (a) => a.$(".hd"),
    },
    {
      key: "kern",
      title: "Een kernoverweging",
      body: (a) => {
        const seg = a.kernSeg();
        const role = seg?.result?.role ? MNT.ROLE_LABEL[seg.result.role] : null;
        return `${seg?.nr ? `Overweging ${MNT.esc(seg.nr)}` : "Deze passage"} is een kernoverweging: hier oordeelt de rechter zelf en hierop rust de beslissing. De tint staat voor de categorie${
          role ? ` (${MNT.esc(role.toLowerCase())})` : ""
        }; houd de muis erop om die te zien. De zin die het meest zegt wordt vet en onderstreept zodra de overweging in beeld is.`;
      },
      waiting: "Het model leest de overwegingen. Zodra het een kernoverweging vindt, wijst de rondleiding die aan.",
      fallback:
        "Het model vond in deze uitspraak geen kernoverweging, dat gebeurt soms. De rondleiding gaat verder met het paneel.",
      ready: (a) => a.kernSeg() || !a.S.running,
      target: (a) => {
        const seg = a.kernSeg();
        if (!seg) return null;
        if (isFolded(seg)) a.jump(seg.id);
        return seg.wraps[0];
      },
      scroll: "page",
    },
    {
      key: "lijst",
      title: "Alle overwegingen op een rij",
      body: () =>
        `Het paneel zet elke overweging in een groep: kernoverwegingen bovenaan, daaronder wat de vraag raakt, twijfel en de rest. Klik op een regel om er in de tekst naartoe te springen.`,
      target: (a) => {
        const seg = a.kernSeg();
        const row = seg && a.panel.rows.get(seg.id);
        return visible(row) ? row : a.$(".groups");
      },
      scroll: "panel",
    },
    {
      key: "vraag",
      title: "Stel een rechtsvraag",
      body: () =>
        `Zonder vraag toont de Leeswijzer de kernoverwegingen. Met een rechtsvraag ziet u welke overwegingen daarover gaan. Probeer het met een voorbeeldvraag en druk op ${KBD("Enter")}.`,
      action: { label: "Vul de voorbeeldvraag in", act: "example" },
      hint: "Gaat vanzelf verder zodra u de vraag stelt.",
      target: (a) => a.$(".q"),
      done: (a) => Boolean(a.S.question) && a.S.asked,
      scroll: "panel",
    },
    {
      key: "oordeel",
      title: "Het oordeel",
      body: (a) =>
        a.S.question
          ? `Bovenaan staat of deze uitspraak over uw vraag gaat: ja, deels of nee. Daaronder hoeveel overwegingen kern zijn, hoeveel uw vraag raken en hoeveel er gelezen zijn.`
          : `Zonder vraag telt het paneel hier de kernoverwegingen van deze uitspraak. Met een vraag komt hier te staan of de uitspraak over die vraag gaat: ja, deels of nee.`,
      waiting: "Het model leest de uitspraak opnieuw met uw vraag. Een ogenblik.",
      ready: (a) => Boolean(a.S.verdict) || !a.S.running,
      target: (a) => a.$(".verdict"),
      extra: (a) => a.$(".v-meta"),
      scroll: "panel",
    },
    {
      key: "niet-relevant",
      title: "Wat niet relevant is",
      body: () =>
        `Overwegingen die er niet over gaan staan standaard verborgen; in de tekst blijft een dunne lijn over, zoals "3 overwegingen overgeslagen". Kies Inklappen om per overweging één regel te houden, of Tonen om alles terug te halen.`,
      hint: "Probeer het gerust; Volgende staat klaar.",
      target: (a) => a.$('[data-tabs="low-mode"]'),
      scroll: "panel",
    },
    {
      key: "categorie",
      title: "Filter op categorie",
      body: () =>
        `Elke overweging krijgt een categorie: juridisch kader, toepassing, feiten, procesverloop en zo verder. Klik op een categorie om alleen die te zien, en nog eens om het filter los te laten. Met "Maak dit standaard" opent elke uitspraak zo.`,
      target: (a) => a.$(".cats"),
      scroll: "panel",
    },
    {
      key: "volgorde",
      title: "Relevantie of volgorde",
      body: () => `De lijst staat op relevantie. Kies Volgorde om de overwegingen in de volgorde van de uitspraak te zien.`,
      target: (a) => a.$('[data-tabs="sort"]'),
      scroll: "panel",
    },
    {
      key: "toetsen",
      title: "Springen met het toetsenbord",
      body: () => `Druk op ${KBD("j")} voor de volgende kernoverweging en op ${KBD("k")} voor de vorige. De pijlen hier doen hetzelfde.`,
      hint: "Druk op j om het te proberen.",
      target: (a) => a.$(".nav"),
      done: (a) => a.pressed.has("j") || a.pressed.has("k"),
      scroll: "panel",
    },
    {
      key: "instellingen",
      title: "Instellingen en privacy",
      body: () =>
        `Achter dit tandwiel staan de instellingen: hoe kieskeurig de Leeswijzer is en of hij automatisch meeleest. Daar staan ook de privacyfeiten, en u kunt deze rondleiding er opnieuw starten.`,
      target: (a) => a.$('[data-act="settings"]'),
    },
    {
      key: "klaar",
      title: "Klaar",
      body: () => `Open nu een uitspraak naar keuze. De Leeswijzer leest mee zodra de pagina er is.`,
      end: true,
    },
  ];

  MNT.Tour = class {
    // api: { S, panel, jump(id) }
    constructor(api) {
      this.api = { ...api, $: (sel) => api.panel.root.querySelector(sel), kernSeg: () => this.kernSeg(), pressed: new Set() };
      this.i = -1;
      this.active = false;
      this.host = null;
      this.onKey = (e) => this.key(e);
      this.frame = () => this.tick();
    }

    // Prefer a numbered r.o. of readable length that is on screen; an old
    // arrest also carries long loose passages, which make a poor example.
    kernSeg() {
      const kern = this.api.S.segments.filter((s) => MNT.tierOf(s.result) === "kern");
      const shown = kern.filter((s) => !isFolded(s));
      const pick = (list) => list.find((s) => s.kind === "ro" && s.text.length < 3000) ?? list.find((s) => s.kind === "ro");
      return pick(shown) ?? pick(kern) ?? shown[0] ?? kern[0] ?? null;
    }

    mount() {
      this.host = document.createElement("div");
      this.host.id = "mnt-tour-host";
      this.host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483001; pointer-events: none;";
      this.root = this.host.attachShadow({ mode: "closed" }); // as the panel: not reachable from the page
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = chrome.runtime.getURL("src/tour.css");
      const mascotCss = document.createElement("link");
      mascotCss.rel = "stylesheet";
      mascotCss.href = chrome.runtime.getURL("src/mascot.css");
      this.root.append(
        mascotCss,
        css,
        MNT.h(`<div class="tour" data-ready="false">
          <div class="shade shade-t"></div><div class="shade shade-b"></div><div class="shade shade-l"></div><div class="shade shade-r"></div>
          <div class="spot" hidden></div>
          <div class="card" role="dialog" aria-modal="false" aria-labelledby="mnt-tour-title" tabindex="-1">
            <div class="card-top"><span class="dots" aria-hidden="true"></span><span class="count"></span></div>
            <h2 class="title" id="mnt-tour-title"></h2>
            <div class="body"></div>
            <div class="wait" hidden><span class="wait-dot"></span><span class="wait-text"></span></div>
            <div class="action" hidden></div>
            <p class="hint" hidden></p>
            <div class="foot">
              <button type="button" class="link" data-act="skip">Overslaan</button>
              <span class="btns">
                <button type="button" class="ghost" data-act="back">Terug</button>
                <button type="button" class="primary" data-act="next">Volgende</button>
              </span>
            </div>
          </div>
        </div>`),
      );
      css.addEventListener("load", () => (this.$(".tour").dataset.ready = "true"));
      document.documentElement.append(this.host);
      this.root.addEventListener("click", (e) => {
        const el = e.target.closest("[data-act]");
        if (!el || el.disabled) return;
        const act = el.dataset.act;
        if (act === "next") this.go(1);
        else if (act === "back") this.go(-1);
        else if (act === "skip" || act === "close") this.end();
        else if (act === "example") this.fillExample();
        else if (act === "search") {
          this.end();
          location.assign("https://uitspraken.rechtspraak.nl/");
        }
      });
    }

    $(sel) {
      return this.root.querySelector(sel);
    }

    start() {
      if (this.active) return;
      if (!this.host) this.mount();
      this.active = true;
      this.host.style.pointerEvents = "none";
      window.addEventListener("keydown", this.onKey);
      window.addEventListener("resize", this.frame);
      this.i = -1;
      this.go(1);
      this.raf = requestAnimationFrame(this.frame);
    }

    end() {
      if (!this.active) return;
      this.active = false;
      cancelAnimationFrame(this.raf);
      clearInterval(this.poll);
      window.removeEventListener("keydown", this.onKey);
      window.removeEventListener("resize", this.frame);
      // The example question is the tour's, not the lawyer's: drop it, or the
      // next ruling they open would be judged against Haviltex. The question is
      // shared across tabs for the session, so this also clears it there.
      const { S, panel } = this.api;
      if (S.question === EXAMPLE_QUESTION) {
        S.recent = S.recent.filter((q) => q !== EXAMPLE_QUESTION);
        panel.on.ask("");
      }
      const host = this.host;
      this.host = null;
      this.root.querySelector(".tour").classList.add("is-leaving");
      setTimeout(() => host.remove(), reduced() ? 0 : 260);
    }

    key(e) {
      if (!this.active || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.composedPath()[0];
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "j" || e.key === "k") this.api.pressed.add(e.key);
      if (e.key === "Escape") {
        e.preventDefault();
        this.end();
      } else if (e.key === "ArrowRight") {
        if (!this.waiting) this.go(1);
      } else if (e.key === "ArrowLeft") this.go(-1);
    }

    fillExample() {
      const { panel } = this.api;
      panel.editing = true;
      panel.on.rerender();
      // After the panel's render (which resets an unfocused, unchanged field).
      setTimeout(() => {
        const ta = panel.$("textarea");
        ta.value = EXAMPLE_QUESTION;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }, 300);
    }

    go(dir) {
      const next = Math.min(STEPS.length - 1, Math.max(0, this.i + dir));
      if (next === this.i) return;
      this.i = next;
      this.api.pressed.clear();
      this.step = STEPS[this.i];
      this.moveFrom = this.spotRect ? { ...this.spotRect } : null;
      this.moveAt = performance.now();
      this.stepStartedAt = this.moveAt;
      this.scrolled = false;
      this.waiting = false;
      this.fellBack = false;
      clearInterval(this.poll);
      this.render();
      this.poll = setInterval(() => this.check(), POLL_MS);
      this.check(true);
    }

    // Waiting steps: keep checking whether the model delivered; done steps:
    // advance once the reader did the thing.
    check(first) {
      const st = this.step;
      const a = this.api;
      if (st.ready) {
        const ok = st.ready(a);
        if (!ok) {
          if (!this.waiting || first) {
            this.waiting = true;
            this.render();
          }
          return;
        }
        if (this.waiting || first) {
          this.waiting = false;
          this.fellBack = Boolean(st.fallback) && !st.target?.(a);
          this.render();
        }
      }
      if (st.done && st.done(a) && performance.now() - this.stepStartedAt > 600) this.go(1);
    }

    render() {
      const st = this.step;
      const a = this.api;
      const tour = this.$(".tour");
      const card = this.$(".card");
      tour.dataset.end = String(Boolean(st.end));
      tour.dataset.waiting = String(this.waiting);
      this.$(".dots").innerHTML = STEPS.map((s, i) => `<i class="${i === this.i ? "on" : i < this.i ? "past" : ""}"></i>`).join("");
      this.$(".count").textContent = `${this.i + 1} van ${STEPS.length}`;
      this.$(".title").textContent = st.title;
      const body = this.$(".body");
      body.innerHTML = st.end
        ? `<div class="end-mascot">${MNT.mascot(56)}</div><p>${st.body(a)}</p>`
        : `<p>${this.fellBack ? st.fallback : st.body(a)}</p>`;
      if (st.end) setTimeout(() => MNT.setMascot(this.root, "happy"), 350);
      const wait = this.$(".wait");
      wait.hidden = !this.waiting;
      this.$(".wait-text").textContent = this.waiting ? st.waiting ?? "Een ogenblik." : "";
      const action = this.$(".action");
      action.hidden = !st.action || this.waiting;
      action.innerHTML = st.action ? `<button type="button" class="secondary" data-act="${st.action.act}">${st.action.label}</button>` : "";
      const hint = this.$(".hint");
      hint.hidden = !st.hint || this.waiting;
      hint.textContent = st.hint ?? "";
      this.$('[data-act="back"]').hidden = this.i === 0 || Boolean(st.end);
      this.$('[data-act="skip"]').hidden = Boolean(st.end);
      const nextBtn = this.$('[data-act="next"]');
      nextBtn.disabled = this.waiting;
      nextBtn.textContent = st.end ? "Sluiten" : "Volgende";
      nextBtn.dataset.act = st.end ? "close" : "next";
      // Foot of the end card: search on Rechtspraak.nl as the natural next step.
      const btns = this.$(".btns");
      btns.querySelector('[data-act="search"]')?.remove();
      if (st.end) btns.prepend(MNT.h(`<button type="button" class="ghost" data-act="search">Zoeken op Rechtspraak.nl</button>`));
      // Re-reveal the card.
      card.classList.remove("is-in");
      void card.offsetWidth;
      card.classList.add("is-in");
      this.tick();
      // Keyboard users land in the card (Tab reaches its buttons); no ring on
      // the container itself.
      setTimeout(() => card.focus({ preventScroll: true }), 50);
    }

    // Where the spotlight goes right now: the step's target (plus `extra`)
    // while waiting the panel's status line, at the end nothing.
    targetRect() {
      const st = this.step;
      const a = this.api;
      if (st.end) return null;
      let el = this.waiting ? a.$(".hd-status") : st.target?.(a);
      if (!visible(el)) el = this.waiting ? null : a.$(".hd");
      if (!visible(el)) return null;
      let r = el.getBoundingClientRect();
      // Bring the target on screen once, and again if the page shifted under
      // it (an accordion settling, a late layout) and it slid out of view.
      const off = r.bottom < 0 || r.top > window.innerHeight;
      const now = performance.now();
      if (!this.waiting && (!this.scrolled || (off && now - this.revealAt > 1500))) {
        this.scrolled = true;
        this.revealAt = now;
        this.reveal(el, st.scroll);
      }
      const extra = !this.waiting && st.extra?.(a);
      if (visible(extra)) {
        const e = extra.getBoundingClientRect();
        r = new DOMRect(Math.min(r.left, e.left), Math.min(r.top, e.top), 0, 0);
        r.width = Math.max(el.getBoundingClientRect().right, e.right) - r.left;
        r.height = Math.max(el.getBoundingClientRect().bottom, e.bottom) - r.top;
      }
      return { left: r.left - PAD, top: r.top - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
    }

    // Bring the target on screen: the panel scrolls its own body, the page
    // scrolls under whatever Rechtspraak.nl pins to the top.
    reveal(el, how) {
      if (how === "panel") el.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" });
      else if (how === "page") {
        const top = el.getBoundingClientRect().top + window.scrollY - Math.max(96, window.innerHeight * 0.22);
        window.scrollTo({ top, behavior: reduced() ? "auto" : "smooth" });
      }
    }

    tick() {
      if (!this.active) return;
      this.raf = requestAnimationFrame(this.frame);
      const live = this.targetRect();
      const now = performance.now();
      let rect = live;
      // Glide from the previous spotlight to the new one on a step change;
      // otherwise follow scroll and resize exactly.
      if (live && this.moveFrom && !reduced()) {
        const t = Math.min(1, (now - this.moveAt) / MOVE_MS);
        const k = ease(t);
        rect = {
          left: this.moveFrom.left + (live.left - this.moveFrom.left) * k,
          top: this.moveFrom.top + (live.top - this.moveFrom.top) * k,
          width: this.moveFrom.width + (live.width - this.moveFrom.width) * k,
          height: this.moveFrom.height + (live.height - this.moveFrom.height) * k,
        };
        if (t >= 1) this.moveFrom = null;
      } else this.moveFrom = null;
      this.spotRect = live;
      this.layout(rect);
    }

    layout(r) {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const spot = this.$(".spot");
      const shades = ["t", "b", "l", "r"].map((k) => this.$(`.shade-${k}`));
      if (!r) {
        spot.hidden = true;
        shades[0].style.cssText = `left:0;top:0;width:${W}px;height:${H}px`;
        for (const s of shades.slice(1)) s.style.cssText = "width:0;height:0";
      } else {
        spot.hidden = false;
        spot.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
        shades[0].style.cssText = `left:0;top:0;width:${W}px;height:${Math.max(0, r.top)}px`;
        shades[1].style.cssText = `left:0;top:${r.top + r.height}px;width:${W}px;height:${Math.max(0, H - r.top - r.height)}px`;
        shades[2].style.cssText = `left:0;top:${r.top}px;width:${Math.max(0, r.left)}px;height:${r.height}px`;
        shades[3].style.cssText = `left:${r.left + r.width}px;top:${r.top}px;width:${Math.max(0, W - r.left - r.width)}px;height:${r.height}px`;
      }
      // The card: beside a panel target (to its left), under or above a page
      // target, centred when there is nothing to point at.
      const card = this.$(".card");
      const cw = Math.min(CARD_W, W - 32);
      const ch = card.offsetHeight;
      let left;
      let top;
      const panelLeft = this.api.S.open ? this.api.panel.$(".panel").getBoundingClientRect().left : W;
      const inPanel = r && r.left >= panelLeft - 2;
      if (!r) {
        const area = Math.min(W, panelLeft > 400 ? panelLeft : W);
        left = (area - cw) / 2;
        top = (H - ch) / 2;
      } else if (inPanel && panelLeft - GAP - cw >= 16) {
        // Beside the panel, never over it: the reader must see the whole control.
        left = panelLeft - GAP - cw;
        top = r.top;
      } else if (r.top + r.height + GAP + ch <= H - 16) {
        left = r.left;
        top = r.top + r.height + GAP;
      } else if (r.top - GAP - ch >= 16) {
        left = r.left;
        top = r.top - GAP - ch;
      } else {
        left = r.left + r.width + GAP;
        top = r.top;
      }
      const maxLeft = Math.max(16, (inPanel ? W : Math.min(W, panelLeft)) - cw - 16);
      left = Math.min(Math.max(16, left), maxLeft);
      top = Math.min(Math.max(16, top), Math.max(16, H - ch - 16));
      card.style.width = `${cw}px`;
      card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }
  };

  MNT.TOUR_EXAMPLE_QUESTION = EXAMPLE_QUESTION;
})();
