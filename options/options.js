// Minuut Leeswijzer: the welcome flow (?welkom, once after install) and the
// settings and privacy page (from the panel's gear). No inline scripts: the
// extension page runs under the MV3 content security policy.

const $ = (id) => document.getElementById(id);
const welcome = new URLSearchParams(location.search).has("welkom");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Where the Leeswijzer works. One place: the copy on step 3 reads this list,
// so a new site is one line here (and a match in manifest.json).
const SITES = [
  { name: "Rechtspraak.nl", note: "uitspraken en zoekresultaten" },
  { name: "Curia", note: "Hof van Justitie EU: arresten, beschikkingen, conclusies" },
  { name: "EUR-Lex", note: "EU-rechtspraak, ook de oudere arresten" },
];

// The example ruling of the tour: Haviltex (uitleg van een overeenkomst).
const EXAMPLE = { ecli: "ECLI:NL:HR:1981:AG4158", url: "https://uitspraken.rechtspraak.nl/details?id=ECLI:NL:HR:1981:AG4158" };

// ---- Strictness: one setting, two controls, one preview ---------------------
// storage.local.strictness = "minder" (kieskeuriger) | "standaard" | "meer".

const STRICT_KEYS = ["minder", "standaard", "meer"];
const radios = () => document.querySelectorAll('input[name="strictness"], input[name="strictness-ob"]');

// The preview: ten overwegingen with a fixed relevance each; the setting
// moves the cut-off, as it does in src/shared.js (0.6 -> 0.8 / 0.4).
const PREVIEW = [0.92, 0.45, 0.71, 0.3, 0.85, 0.62, 0.22, 0.66, 0.5, 0.38];
const CUTOFF = { minder: 0.8, standaard: 0.6, meer: 0.4 };
const PREVIEW_NRS = ["3.1", "3.2", "3.3", "3.4", "4.1", "4.2", "4.3", "4.4", "5.1", "5.2"];

function buildPreviews() {
  for (const doc of document.querySelectorAll("[data-preview-doc]")) {
    doc.innerHTML = PREVIEW.map(
      (_, i) => `<div class="pv-ro" data-i="${i}">
        <div class="pv-inner">
          <span class="pv-nr">${PREVIEW_NRS[i]}</span>
          <span class="pv-lines"><i style="width:${78 + ((i * 37) % 20)}%"></i><i style="width:${40 + ((i * 53) % 45)}%"></i></span>
          <span class="pv-tag">Kern</span>
        </div>
        <div class="pv-skip"><i></i><span></span><i></i></div>
      </div>`,
    ).join("");
  }
}

function renderPreview(key) {
  const cut = CUTOFF[key] ?? CUTOFF.standaard;
  const shown = PREVIEW.filter((p) => p >= cut).length;
  for (const doc of document.querySelectorAll("[data-preview-doc]")) {
    const rows = [...doc.querySelectorAll(".pv-ro")];
    // Consecutive hidden r.o.'s collapse into one "n overwegingen overgeslagen" line.
    let run = null;
    rows.forEach((row, i) => {
      const kern = PREVIEW[i] >= cut;
      row.dataset.kern = String(kern);
      row.dataset.lead = "false";
      if (kern) run = null;
      else {
        if (!run) {
          run = { lead: row, n: 0 };
          row.dataset.lead = "true";
        }
        run.n++;
        run.lead.querySelector(".pv-skip span").textContent = `${run.n} ${run.n === 1 ? "overweging" : "overwegingen"} overgeslagen`;
      }
    });
  }
  for (const el of document.querySelectorAll("[data-preview-count]")) el.textContent = `${shown} van 10 getoond`;
}

function setStrictness(key, persist) {
  if (!STRICT_KEYS.includes(key)) key = "standaard";
  for (const input of radios()) input.checked = input.value === key;
  renderPreview(key);
  if (persist) chrome.storage.local.set({ strictness: key });
}

buildPreviews();
chrome.storage.local.get(["strictness", "autoRun"]).then(({ strictness, autoRun }) => {
  setStrictness(strictness ?? "standaard", false);
  $("autorun").checked = autoRun !== false;
});
for (const input of radios()) input.addEventListener("change", () => setStrictness(input.value, true));
$("autorun").addEventListener("change", (e) => chrome.storage.local.set({ autoRun: e.target.checked }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.strictness) setStrictness(changes.strictness.newValue, false);
});

// ---- The tour: flag the example ruling, then open it ------------------------
// content.js reads the flag once, only in the tab whose ECLI matches.

async function openExample(button) {
  button.disabled = true;
  try {
    await chrome.storage.session.set({ tour: { ecli: EXAMPLE.ecli, at: Date.now() } });
  } catch {
    // Without session storage the ruling still opens, only without the tour.
  }
  window.open(EXAMPLE.url, "_blank", "noopener");
  setTimeout(() => (button.disabled = false), 1500);
}
$("open-example").addEventListener("click", (e) => openExample(e.currentTarget));
$("tour-again").addEventListener("click", (e) => openExample(e.currentTarget));

// ---- Views ----------------------------------------------------------------

$("mascot").innerHTML = MNT.mascot(84);
$("ob-mascot").innerHTML = MNT.mascot(64);
$("onboarding").hidden = !welcome;
$("settings").hidden = welcome;
document.title = welcome ? "Leeswijzer · Welkom" : "Leeswijzer · Instellingen en privacy";

$("to-settings").addEventListener("click", (e) => {
  e.preventDefault();
  history.replaceState(null, "", "options.html");
  $("onboarding").hidden = true;
  $("settings").hidden = false;
  document.title = "Leeswijzer · Instellingen en privacy";
  window.scrollTo(0, 0);
});

// ---- Welcome flow ----------------------------------------------------------

if (welcome) {
  const steps = [...document.querySelectorAll(".ob-step")];
  let at = 0;
  let pinned = false;
  let advanceTimer = 0;

  $("sites").innerHTML = SITES.map((s) => `<li><b>${s.name}</b><span>${s.note}</span></li>`).join("");
  const names = SITES.map((s) => s.name);
  $("sites-title").textContent = names.length > 1 ? `${names.slice(0, -1).join(", ")} en ${names[names.length - 1]}` : names[0];

  function show(n, dir) {
    at = Math.max(0, Math.min(steps.length - 1, n));
    steps.forEach((el, i) => {
      el.hidden = i !== at;
      if (i === at) {
        el.classList.remove("is-in", "from-left");
        void el.offsetWidth;
        if (dir < 0) el.classList.add("from-left");
        el.classList.add("is-in");
      }
    });
    $("ob-dots").innerHTML = steps.map((_, i) => `<i class="${i === at ? "on" : i < at ? "past" : ""}"></i>`).join("");
    $("ob-count").textContent = `Stap ${at + 1} van ${steps.length}`;
    $("ob-back").hidden = at === 0;
    const next = $("ob-next");
    next.hidden = at === steps.length - 1;
    // Step 1 is a choice: confirm it.
    next.textContent = at === 0 ? "Bevestigen" : "Volgende";
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    clearTimeout(advanceTimer);
    if (at === 1) watchPin();
  }
  $("ob-next").addEventListener("click", () => show(at + 1, 1));
  $("ob-back").addEventListener("click", () => show(at - 1, -1));
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== "radio") return;
    if (e.key === "ArrowRight" && at < steps.length - 1) show(at + 1, 1);
    else if (e.key === "ArrowLeft" && at > 0) show(at - 1, -1);
  });

  // Is the icon on the toolbar already? Chrome 91+ tells us; poll while the
  // reader is on this step and move on by itself once it is pinned.
  async function checkPin() {
    try {
      const s = await chrome.action.getUserSettings();
      return Boolean(s?.isOnToolbar);
    } catch {
      return false;
    }
  }
  function markPinned(already) {
    pinned = true;
    $("chrome").classList.add("is-pinned");
    const state = $("pin-state");
    state.dataset.pinned = "true";
    $("pin-text").textContent = already ? "Staat al in de werkbalk." : "Gelukt: het pictogram staat in de werkbalk.";
    if (!already && at === 1) advanceTimer = setTimeout(() => at === 1 && show(2, 1), 1600);
  }
  let pinTimer = 0;
  async function watchPin() {
    clearInterval(pinTimer);
    if (pinned) return;
    if (await checkPin()) return markPinned(true);
    pinTimer = setInterval(async () => {
      if (at !== 1 || pinned) return clearInterval(pinTimer);
      if (await checkPin()) {
        clearInterval(pinTimer);
        markPinned(false);
      }
    }, 1000);
  }

  // The Chrome mock is drawn at 520px and scaled to the room it has, so the
  // loop's coordinates stay exact on every screen.
  const wrap = $("chrome-wrap");
  const fit = () => {
    const s = Math.min(1, wrap.clientWidth / 520);
    wrap.style.setProperty("--s", String(s));
  };
  new ResizeObserver(fit).observe(wrap);
  fit();

  show(0, 1);
  // A pleased hop once the page has settled in.
  setTimeout(() => MNT.setMascot(document, "happy"), 700);
  setTimeout(() => MNT.setMascot(document, "idle"), 2600);
} else {
  setTimeout(() => MNT.setMascot(document, "idle"), 0);
}
