// Minuut Leeswijzer: the mascot. A bookmark ("leeswijzer") in reading
// glasses. States, set with data-state on the wrapper:
//   idle     blinks now and then
//   thinking eyes drift up, thought dots rise, body bobs (while Jev judges)
//   happy    one hop, smiling mouth, closed happy eyes, blush (when done)
//   worried  eyebrows up, wavy mouth (on errors)
// All motion lives in panel.css under .mascot and respects reduced motion.

var MNT = (globalThis.MNT = globalThis.MNT || {});

MNT.mascot = (size = 34) => `
  <span class="mascot" data-state="idle" style="--m-size:${size}px" aria-hidden="true">
    <svg viewBox="0 0 48 48" class="m-svg">
      <g class="m-thought">
        <circle class="m-dot d1" cx="36.5" cy="7.5" r="1.3"/>
        <circle class="m-dot d2" cx="40.5" cy="4.2" r="1.7"/>
        <circle class="m-dot d3" cx="45" cy="1.6" r="2.1"/>
      </g>
      <g class="m-body">
        <path class="m-ribbon" d="M13 7h22a3 3 0 0 1 3 3v32.5l-14-8.3-14 8.3V10a3 3 0 0 1 3-3z"/>
        <path class="m-fold" d="M13 7h22a3 3 0 0 1 3 3v2H10v-2a3 3 0 0 1 3-3z"/>
        <g class="m-brows">
          <path d="M14.8 13.6q2.6-1.4 5.2-.2"/>
          <path d="M28 13.4q2.6-1.2 5.2.2"/>
        </g>
        <g class="m-glasses">
          <circle cx="18" cy="19.6" r="5.1"/>
          <circle cx="30" cy="19.6" r="5.1"/>
          <path d="M23.1 19.2q.9-1.1 1.8 0"/>
        </g>
        <g class="m-eyes">
          <circle cx="18" cy="20" r="2"/>
          <circle cx="30" cy="20" r="2"/>
        </g>
        <g class="m-happy-eyes">
          <path d="M15.8 20.6q2.2-2.6 4.4 0"/>
          <path d="M27.8 20.6q2.2-2.6 4.4 0"/>
        </g>
        <circle class="m-cheek" cx="13.6" cy="26" r="1.9"/>
        <circle class="m-cheek" cx="34.4" cy="26" r="1.9"/>
        <path class="m-mouth m-mouth-idle" d="M21.2 27.6q2.8 1.4 5.6 0"/>
        <path class="m-mouth m-mouth-happy" d="M20.4 27q3.6 3.8 7.2 0"/>
        <path class="m-mouth m-mouth-think" d="M22.6 28.2h2.8"/>
        <path class="m-mouth m-mouth-worried" d="M21 28.6q1.5-1.4 3 0t3 0"/>
      </g>
    </svg>
  </span>`;

MNT.setMascot = (root, state) => {
  for (const m of root.querySelectorAll(".mascot")) {
    if (m.dataset.state === state) continue;
    m.dataset.state = state;
  }
};
