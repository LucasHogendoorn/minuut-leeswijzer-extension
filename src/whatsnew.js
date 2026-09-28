// Minuut Leeswijzer: "Nieuw in Leeswijzer" after an update. Shown once, as a
// card over the panel (inside its shadow root, so the site's CSS stays out),
// with a short confetti burst on a canvas confined to the panel. The ruling
// keeps being read behind it.

var MNT = (globalThis.MNT = globalThis.MNT || {});

// Which release to announce, and to whom. The rule:
//   chrome.storage.local.seenVersion is the last version this profile was told
//   about. background.js writes it on install (the current version: a fresh
//   install gets the welcome page, never this card) and on update (the
//   previous version, when nothing is stored yet). Version 1.0.x never wrote
//   the key, and onInstalled may not have run before this content script:
//   1.1 adds host permissions, so Chrome keeps the extension off until they
//   are accepted, and the service worker may start later than the page. So a
//   profile without seenVersion but with a key only 1.0.1 wrote (panelOpen,
//   sort, defaults: set from the panel, so not every 1.0 profile has one)
//   counts as an upgrade from 1.0. Keys 1.1 itself writes (autoRun from the
//   tour, strictness) never count. A profile with neither is a fresh install:
//   only the current version is recorded. Only a new major or minor version
//   is announced; the new version is stored before the card shows, so a
//   second tab never shows it again.
const LEGACY_KEYS = ["panelOpen", "sort", "defaults"];
const minor = (v) => String(v ?? "").split(".").slice(0, 2).map(Number);
MNT.isNewerRelease = (from, to) => {
  const [fa, fb] = minor(from);
  const [ta, tb] = minor(to);
  return ta > fa || (ta === fa && tb > fb);
};

MNT.releaseToAnnounce = async () => {
  const version = chrome.runtime.getManifest().version;
  const saved = await MNT.storage.get(["seenVersion", ...LEGACY_KEYS]);
  const seen = saved.seenVersion ?? (LEGACY_KEYS.some((k) => k in saved) ? "1.0" : null);
  if (seen === version) return null;
  await MNT.storage.set({ seenVersion: version });
  return seen && MNT.isNewerRelease(seen, version) ? version : null;
};

// ---- Confetti --------------------------------------------------------------
// A burst from `origin` (fractions of the canvas), ~1.8 s, requestAnimationFrame,
// cleared when done. Returns a function that stops it early.
const CONFETTI_TOKENS = [
  "--mnt-accent",
  "--mnt-focus",
  "--mnt-cat-kader-ink",
  "--mnt-cat-obiter-ink",
  "--mnt-cat-stellingen-ink",
  "--mnt-cat-beslissing-ink",
  "--mnt-wet",
  "--mnt-underline",
];
MNT.confetti = (canvas, origin = { x: 0.5, y: 0.35 }, duration = 1800) => {
  const style = getComputedStyle(canvas);
  const colors = CONFETTI_TOKENS.map((t) => style.getPropertyValue(t).trim()).filter(Boolean);
  if (!colors.length) colors.push("#285640", "#739580", "#36597F", "#7B4C6C");
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const rand = (a, b) => a + Math.random() * (b - a);
  const parts = Array.from({ length: 110 }, () => {
    const angle = -Math.PI / 2 + rand(-0.55, 0.55) * Math.PI;
    const speed = rand(0.28, 0.72); // px per ms
    return {
      x: w * origin.x + rand(-12, 12),
      y: h * origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: rand(5, 9),
      h: rand(3, 6),
      round: Math.random() < 0.3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: rand(0, Math.PI * 2),
      vr: rand(-0.012, 0.012),
      wobble: rand(0, Math.PI * 2),
    };
  });

  let raf = 0;
  let last = performance.now();
  const started = last;
  const frame = (now) => {
    const dt = Math.min(32, now - last);
    last = now;
    const t = (now - started) / duration;
    if (t >= 1) return stop();
    const drag = 0.985 ** (dt / 16.7);
    const alpha = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = alpha;
    for (const p of parts) {
      p.vy += 0.00062 * dt;
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt + Math.sin(p.wobble += 0.004 * dt) * 0.25;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.y > h + 10) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.h / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // A flat strip seen from a turning angle: width follows a cosine.
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w * Math.abs(Math.cos(p.wobble)), p.h);
      }
      ctx.restore();
    }
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    ctx.clearRect(0, 0, w, h);
  };
  raf = requestAnimationFrame(frame);
  return stop;
};

// ---- The card ---------------------------------------------------------------

const CURIA_SEARCH = "https://curia.europa.eu/juris/recherche.jsf?language=nl";

// `panel` is the mounted MNT.Panel; `site` the current site id (the Curia link
// only shows on Rechtspraak.nl). Escape, the button and the scrim close it.
MNT.showWhatsNew = (panel, { version, site }) => {
  const root = panel.root;
  const frame = panel.$(".panel");
  if (!frame || root.querySelector(".wn")) return;
  const label = version.split(".").slice(0, 2).join(".");
  const el = MNT.h(`
    <div class="wn" role="dialog" aria-modal="true" aria-labelledby="mnt-wn-title">
      <canvas class="wn-confetti" aria-hidden="true"></canvas>
      <div class="wn-card reveal">
        <div class="wn-hero r1">${MNT.mascot(64)}</div>
        <p class="wn-eyebrow r1">Nieuw in Leeswijzer ${MNT.esc(label)}</p>
        <h2 class="wn-title r2" id="mnt-wn-title">Leest nu ook Europese rechtspraak</h2>
        <ul class="wn-list r3">
          <li><b>Curia en EUR-Lex.</b> Arresten van het Hof van Justitie en het Gerecht en conclusies van advocaten-generaal. Nederlandse en Engelse pagina's krijgen vragen in hun eigen taal.</li>
          <li><b>Sneller.</b> Een uitspraak die al eerder is gelezen, staat vrijwel meteen klaar.</li>
          <li><b>Scherper in Europese arresten.</b> Het dictum en het antwoord op de prejudiciële vragen worden beter herkend als kernoverweging.</li>
        </ul>
        <div class="wn-actions r4">
          <button type="button" class="primary wn-close">Aan de slag</button>
          ${site === "rechtspraak" ? `<a class="wn-link" href="${CURIA_SEARCH}" target="_blank" rel="noopener">Open een arrest op Curia</a>` : ""}
        </div>
      </div>
    </div>`);
  frame.append(el);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const quick = parseFloat(getComputedStyle(panel.host).getPropertyValue("--mnt-duration-quick")) || 150;
  const previous = root.activeElement;
  let stopConfetti = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stopConfetti();
    root.removeEventListener("keydown", onKey);
    document.removeEventListener("keydown", onKey, true);
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), reduced ? 0 : quick);
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab" && e.composedPath().includes(el)) {
      // Keep Tab inside the card.
      const focusable = [...el.querySelectorAll("button, a[href]")];
      const at = focusable.indexOf(root.activeElement);
      const next = focusable[(at + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  };
  el.querySelector(".wn-close").addEventListener("click", close);
  el.addEventListener("click", (e) => {
    if (e.target === el) close();
  });
  root.addEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey, true);

  requestAnimationFrame(() => {
    el.querySelector(".wn-close").focus({ preventScroll: true });
    if (!reduced) {
      // Burst from the mascot.
      const hero = el.querySelector(".wn-hero").getBoundingClientRect();
      const box = el.getBoundingClientRect();
      stopConfetti = MNT.confetti(el.querySelector(".wn-confetti"), { x: (hero.left + hero.width / 2 - box.left) / box.width, y: (hero.top + hero.height / 2 - box.top) / box.height });
    }
  });
  // The mascot hops once the card has settled in.
  setTimeout(() => MNT.setMascot(el, "happy"), reduced ? 0 : 450);
};
