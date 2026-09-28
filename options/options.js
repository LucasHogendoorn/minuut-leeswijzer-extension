// Minuut Leeswijzer: welcome and privacy page. Opens once on install
// (?welkom) and later from the panel's settings button.

const $ = (id) => document.getElementById(id);
const welcome = new URLSearchParams(location.search).has("welkom");

$("mascot").innerHTML = MNT.mascot(84);
if (welcome) {
  $("eyebrow").textContent = "Geïnstalleerd";
  $("title").textContent = "Welkom bij de Leeswijzer";
  // A pleased hop once the page has settled in.
  setTimeout(() => MNT.setMascot(document, "happy"), 700);
}

chrome.storage.local.get("autoRun").then(({ autoRun }) => {
  $("autorun").checked = autoRun !== false;
});
$("autorun").addEventListener("change", (e) => chrome.storage.local.set({ autoRun: e.target.checked }));
