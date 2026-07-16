/* =========================================================================
   DAM IT!  —  a very Alberta beaver game
   Timberman-style chop-and-dodge core. Vertical slice.
   Everything is drawn procedurally on the canvas; audio is a tiny WebAudio
   synth. No external assets, so it runs by just opening index.html.
   ========================================================================= */

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const soundToggle = document.getElementById("soundToggle");
const todButton = document.getElementById("themeToggle");

const W = canvas.width;   // 540
const H = canvas.height;  // 960
const TAU = Math.PI * 2;

/* ---- world layout ---- */
const GROUND_Y = 838;          // top of the grass strip / base of the trunk
const TRUNK_X = 270;           // centre of the aspen
const TRUNK_W = 104;
const SEG_H = 138;             // height of one trunk segment
const STACK = 7;               // segments kept in the visible stack
const BEAVER_OFFSET = 108;     // how far the beaver sits from the trunk centre

/* ---- tuning ---- */
const MAX_TIME = 100;
const REFILL = 9;              // timer gained per chop
const DAY_CYCLE = 90;          // score for one full day -> night -> day loop
const SEASON_RUNS = 4;         // runs per season before winter is checked
const DAM_MAX = 10;
const LODGE_MAX = 8;
const COLONY_MAX = 12;

/* ---- palette (the beaver & trunk stay consistent; sky does the mood) ---- */
const C = {
  barkLight: "#ece9df", barkShade: "#d3cfc0", knot: "#20201d",
  grass: "#5aa845", grassDark: "#3f8a37", dirt: "#6b4a30",
  branch: "#6e4b2c", leaf: "#74b357",
  beaver: "#93602f", beaverDark: "#6b4420", beaverBelly: "#c79a63",
  tooth: "#fffdf3", toque: "#d6373b", toqueBand: "#f4f4f4",
  ink: "rgba(42,30,18,0.4)",
};

/* ======================================================================= */
/* Meta — the persistent colony (Phase 2)                                  */
/* ======================================================================= */

function defaultMeta() {
  return { wood: 0, dam: 0, lodge: 0, colony: 1, season: 1, runsLeft: SEASON_RUNS, valley: 1, mult: 1 };
}
function loadMeta() {
  try {
    const m = JSON.parse(localStorage.getItem("damit_meta"));
    if (m && typeof m.wood === "number") return Object.assign(defaultMeta(), m);
  } catch (e) { /* ignore */ }
  return defaultMeta();
}
const meta = loadMeta();
function saveMeta() { localStorage.setItem("damit_meta", JSON.stringify(meta)); }

function damWater() { return Math.min(100, meta.dam * 10); }
// gentle early targets so the first winters are reachable; ramps up each season
function seasonTarget() { return Math.min(85, 22 + meta.season * 8); }
// costs scale with the valley you're in, so a fresh (bigger) valley re-absorbs your wood
function damCost() { return Math.round((10 + meta.dam * 11) * meta.valley); }
function lodgeCost() { return Math.round((25 + meta.lodge * 18) * meta.valley); }
function colonyCost() { return Math.round((40 + meta.colony * 30) * meta.valley); }
function canPrestige() { return meta.dam >= DAM_MAX && meta.lodge >= LODGE_MAX; }

// run perks derived from the colony
function perkDrainMult() { return Math.max(0.6, 1 - meta.lodge * 0.05); }
function perkRefill() { return REFILL + meta.colony * 0.4; }
function perkShield() { return meta.lodge >= 3 ? 1 : 0; }

/* time-of-day: null = auto (follows score), else a fixed phase 0..1 */
const TOD_PRESETS = [null, 0.0, 0.25, 0.5, 0.75];
const TOD_ICONS = ["🌗", "🌤️", "🌆", "🌌", "🌅"];
let todIdx = 0;

/* ======================================================================= */
/* State                                                                   */
/* ======================================================================= */

const state = {
  scene: "title",       // "title" | "playing" | "dead"
  segments: [],         // [{ branch: null|"left"|"right", type: "branch"|"owl"|"bear" }]
  score: 0,
  combo: 0,
  best: Number(localStorage.getItem("damit_best") || 0),
  timer: MAX_TIME,
  slide: 0,             // trunk drop animation offset
  beaverSide: "left",
  chompT: 0,            // 0..1 chomp animation
  dangerNow: false,     // is the live hazard on the beaver's current side?
  deathAt: 0,
  deathCause: "branch",
  deathT: 0,            // 0..1 death animation progress
  deathLine: "",
  hitSide: "left",
  flash: 0,
  shake: 0,
  todOverride: null,
  shield: 0,            // hits the lodge lets you shrug off this run
  drainMult: 1,
  refill: REFILL,
  lastEarned: 0,        // wood banked from the most recent run
  winterResult: null,   // {ok, text} banner shown on the home hub
  frozen: false,        // the pond is iced over during the winter beat
  homeAt: 0,
  t: 0,                 // elapsed seconds, for idle animation
  soundOn: localStorage.getItem("damit_sound") !== "off",
};

const particles = [];
const flyingLogs = [];
const popups = [];

const DEATH_LINES = {
  branch: [
    "Took a branch to the toque. Classic.",
    "Timber-ed by a twig. Embarrassing, eh.",
    "That's a hard no from the aspen.",
    "Flat as a hockey rink. Nice work.",
  ],
  owl: [
    "The owl sends its regards.",
    "Bonked by a bird. It happens.",
    "Should've watched the branches, not the sky.",
    "Great horned owl: 1. Beaver: 0.",
  ],
  bear: [
    "Bear hug. You did not survive it. Cute though.",
    "That's a bear, bud. You chomped the bear.",
    "Mauled by adorable. Worth it?",
    "The bear was here first. Obviously.",
  ],
  time: [
    "Ran outta gas, eh. Chew faster.",
    "You froze up. Literally, soon.",
    "Even the moose is disappointed.",
    "No chops, no dam. Sorry aboot that.",
  ],
};

/* ======================================================================= */
/* Audio — minimal WebAudio synth (no files)                               */
/* ======================================================================= */

let actx = null;
function audio() {
  if (!actx) {
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      actx = null;
    }
  }
  if (actx && actx.state === "suspended") actx.resume();
  return actx;
}

function tone(freq, dur, type, gain, glideTo) {
  if (!state.soundOn) return;
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// filtered noise whose lowpass closes over the note — the "crunch"
function crunch(dur, gain, fStart, fEnd, q) {
  if (!state.soundOn) return;
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const buf = a.createBuffer(1, Math.max(1, (a.sampleRate * dur) | 0), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const e = 1 - i / d.length;
    d[i] = (Math.random() * 2 - 1) * e * e; // decaying grit
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(fStart, t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(80, fEnd), t + dur);
  lp.Q.value = q || 1;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(lp).connect(g).connect(a.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}

// crackly grit (sparse sharp grains) through a resonant lowpass — a proper wood crunch
function crackle(dur, gain, freq, q) {
  if (!state.soundOn) return;
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const len = Math.max(1, (a.sampleRate * dur) | 0);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const env = Math.pow(1 - i / len, 1.6);
    d[i] = (Math.random() < 0.5 ? Math.random() * 2 - 1 : 0) * env; // sparse grains = crackle
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(freq * 1.6, t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(90, freq * 0.4), t + dur);
  lp.Q.value = q || 1;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(lp).connect(g).connect(a.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}

function noiseBurst(dur, gain, freq) {
  if (!state.soundOn) return;
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const buf = a.createBuffer(1, (a.sampleRate * dur) | 0, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq;
  bp.Q.value = 0.9;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(bp).connect(g).connect(a.destination);
  src.start(t);
}

const sfx = {
  chop(combo) {
    const v = 0.62 + Math.random() * 0.86;            // big per-chomp pitch swing
    crackle(0.16, 0.6, 1900 * v, 3.0);                 // crunchy grit — the meat of the bite
    crunch(0.045, 0.4, 6200 * v, 1500 * v, 1.2);       // sharp splintery crack
    tone(110 * v + Math.min(combo, 20) * 7, 0.09, "triangle", 0.13, 66 * v); // woody thunk
  },
  hit() {
    tone(300, 0.3, "sawtooth", 0.18, 70);
    noiseBurst(0.22, 0.22, 380);
  },
  owl() {                                             // soft "hoo... hoo"
    tone(540, 0.2, "sine", 0.22, 430);
    setTimeout(() => tone(500, 0.26, "sine", 0.22, 400), 250);
  },
  bear() {                                            // low rumbling growl
    tone(96, 0.5, "sawtooth", 0.22, 58);
    tone(74, 0.52, "sawtooth", 0.18, 46);
    crunch(0.5, 0.34, 520, 110, 2.6);
  },
  start() {
    tone(523, 0.1, "square", 0.14);
    setTimeout(() => tone(784, 0.14, "square", 0.14), 90);
  },
};

/* ======================================================================= */
/* Gameplay                                                                */
/* ======================================================================= */

function branchChance() {
  return Math.min(0.30 + state.score * 0.006, 0.62);
}

function makeSegment(allowBranch = true) {
  if (!allowBranch || Math.random() > branchChance()) {
    return { branch: null, type: "branch" };
  }
  const side = Math.random() < 0.5 ? "left" : "right";
  const r = Math.random();
  const bearChance = Math.min(0.12 + state.score * 0.002, 0.28);
  let type = "branch";
  if (r < bearChance) type = "bear";
  else if (r < bearChance + 0.24) type = "owl";
  return { branch: side, type };
}

function startRun() {
  state.scene = "playing";
  state.score = 0;
  state.combo = 0;
  state.timer = MAX_TIME;
  state.slide = 0;
  state.beaverSide = "left";
  state.chompT = 0;
  state.dangerNow = false;
  state.deathT = 0;
  state.frozen = false;
  state.segments = [];
  for (let i = 0; i < STACK; i++) state.segments.push(makeSegment(i > 2));
  particles.length = 0;
  flyingLogs.length = 0;
  popups.length = 0;
  // apply colony perks
  state.shield = perkShield();
  state.drainMult = perkDrainMult();
  state.refill = perkRefill();
  sfx.start();
}

function chop(side) {
  if (state.scene !== "playing") return;

  state.beaverSide = side;
  state.chompT = 1;

  const threat = state.segments[0];
  if (threat && threat.branch === side) {
    if (state.shield > 0) { blockHit(side); return; }
    die(threat.type);
    return;
  }

  state.score += 1;
  state.combo += 1;
  state.timer = Math.min(MAX_TIME, state.timer + state.refill);

  flyingLogs.push({
    x: TRUNK_X,
    y: GROUND_Y - SEG_H * 0.4,
    vx: (side === "left" ? 1 : -1) * (160 + Math.random() * 80),
    vy: -220 - Math.random() * 80,
    rot: 0,
    vr: (side === "left" ? 1 : -1) * 8,
    life: 1.4,
  });

  spawnChips(side);
  state.shake = Math.min(14, 6 + state.combo * 0.2);
  state.slide = SEG_H;

  if (state.combo > 0 && state.combo % 10 === 0) {
    popups.push({ text: `COMBO x${state.combo}!`, y: 430, life: 1.1, big: true });
  }

  state.segments.shift();
  state.segments.push(makeSegment());

  sfx.chop(state.combo);
}

// lodge shield: shrug off a hit instead of dying
function blockHit(side) {
  state.shield -= 1;
  state.shake = 14;
  state.flash = 0.5;
  popups.push({ text: "🛡️ SHIELD!", y: 430, life: 1.1, big: true });
  spawnChips(side);
  state.slide = SEG_H;
  state.segments.shift();
  state.segments.push(makeSegment());
  tone(660, 0.18, "square", 0.16, 990);
}

function die(cause) {
  state.scene = "dead";
  state.deathCause = cause;
  state.deathAt = performance.now();
  state.deathT = 0;
  state.hitSide = state.beaverSide;
  state.flash = 1;
  state.shake = 16;
  state.combo = 0;
  if (state.score > state.best) {
    state.best = state.score;
    localStorage.setItem("damit_best", String(state.best));
  }
  // bank the run's wood into the colony (scaled by the valley multiplier)
  const earned = Math.round(state.score * (meta.mult || 1));
  state.lastEarned = earned;
  meta.wood += earned;
  meta.runsLeft -= 1;
  saveMeta();
  if (cause === "owl") sfx.owl();
  else if (cause === "bear") sfx.bear();
  else sfx.hit();
  spawnImpact();
  const lines = DEATH_LINES[cause] || DEATH_LINES.branch;
  state.deathLine = lines[(Math.random() * lines.length) | 0];
}

function spawnChips(side) {
  const dir = side === "left" ? 1 : -1;
  for (let i = 0; i < 10; i++) {
    particles.push({
      x: TRUNK_X + dir * 30,
      y: GROUND_Y - SEG_H * 0.45,
      vx: dir * (60 + Math.random() * 220),
      vy: -120 - Math.random() * 200,
      g: 900,
      life: 0.6 + Math.random() * 0.4,
      max: 1,
      size: 4 + Math.random() * 6,
      rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 20,
      color: Math.random() < 0.5 ? C.branch : C.beaver,
      star: false,
    });
  }
}

function spawnImpact() {
  const cx = TRUNK_X + (state.hitSide === "left" ? -BEAVER_OFFSET : BEAVER_OFFSET);
  const cy = GROUND_Y - 110;
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * TAU;
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(ang) * (120 + Math.random() * 120),
      vy: Math.sin(ang) * (120 + Math.random() * 120) - 40,
      g: 500,
      life: 0.7 + Math.random() * 0.3,
      max: 1,
      size: 7 + Math.random() * 5,
      rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 20,
      color: "#ffe27a",
      star: true,
    });
  }
}

/* ======================================================================= */
/* Update                                                                  */
/* ======================================================================= */

function update(dt) {
  state.t += dt;
  state.chompT = Math.max(0, state.chompT - dt * 6);
  state.slide = Math.max(0, state.slide - dt * SEG_H * 8);
  state.shake *= Math.pow(0.001, dt);
  state.flash = Math.max(0, state.flash - dt * 3);

  state.dangerNow = false;
  if (state.scene === "playing") {
    const drain = Math.min(16 + state.score * 0.16, 40) * state.drainMult;
    state.timer -= drain * dt;
    const threat = state.segments[0];
    state.dangerNow = !!(threat && threat.branch && threat.branch === state.beaverSide);
    if (state.timer <= 0) {
      state.timer = 0;
      die("time");
    }
  } else if (state.scene === "dead") {
    state.deathT = Math.min(1, state.deathT + dt * 2.6);
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += p.g * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.life -= dt;
    if (p.life <= 0) particles.splice(i, 1);
  }

  for (let i = flyingLogs.length - 1; i >= 0; i--) {
    const l = flyingLogs[i];
    l.vy += 700 * dt;
    l.x += l.vx * dt;
    l.y += l.vy * dt;
    l.rot += l.vr * dt;
    l.life -= dt;
    if (l.life <= 0) flyingLogs.splice(i, 1);
  }

  for (let i = popups.length - 1; i >= 0; i--) {
    popups[i].y -= dt * 40;
    popups[i].life -= dt;
    if (popups[i].life <= 0) popups.splice(i, 1);
  }
}

/* ======================================================================= */
/* Rendering                                                               */
/* ======================================================================= */

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(t) { return Math.max(0, Math.min(1, t)); }
function easeOut(t) { return 1 - (1 - t) * (1 - t); }
function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(c1, c2, t) {
  const a = hex(c1), b = hex(c2);
  return `rgb(${(lerp(a[0], b[0], t)) | 0},${(lerp(a[1], b[1], t)) | 0},${(lerp(a[2], b[2], t)) | 0})`;
}
// keyframe interpolation across an array evenly spaced around the loop
function kf(phase, arr) {
  const p = ((phase % 1) + 1) % 1;
  const s = p * arr.length;
  const i = Math.floor(s) % arr.length;
  return mix(arr[i], arr[(i + 1) % arr.length], s - Math.floor(s));
}

function todPhase() {
  if (state.todOverride != null) return state.todOverride;
  return (state.score / DAY_CYCLE) % 1;
}

/* ---- background: a rolling day -> dusk -> night -> dawn cycle ---- */

const SKY_TOP = ["#57b6e6", "#2b2e5a", "#070c22", "#3a4a86"]; // day, dusk, night, dawn
const SKY_MID = ["#a9dcf0", "#e0714f", "#111a3e", "#d98fa0"];
const SKY_LOW = ["#dcf1f7", "#f4b06a", "#20305e", "#f3c79c"];

function drawBackground() {
  const phase = todPhase();
  const light = 0.5 + 0.5 * Math.cos(phase * TAU); // 1 = midday, 0 = midnight
  const night = 1 - light;

  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, kf(phase, SKY_TOP));
  sky.addColorStop(0.55, kf(phase, SKY_MID));
  sky.addColorStop(1, kf(phase, SKY_LOW));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  drawStars(night);
  drawCelestials(light);
  drawAurora(night);

  // clouds — dimmer and greyer at night
  ctx.globalAlpha = 0.2 + 0.65 * light;
  ctx.fillStyle = mix("#4a5578", "#ffffff", light);
  drawCloud((state.t * 12) % (W + 160) - 80, 130, 1);
  drawCloud((state.t * 8 + 300) % (W + 200) - 100, 210, 0.7);
  ctx.globalAlpha = 1;

  drawRange(560, mix("#8aa6c6", "#2f3d63", night), mix("#eef4f8", "#cdd9ef", night));
  drawRange(640, mix("#6d8bab", "#243358", night), mix("#e6eef5", "#c2d0ea", night));
  drawPumpjack(70, 648, mix("#33465e", "#0c1330", night));

  ctx.fillStyle = mix("#2f5d3b", "#132033", night);
  for (let x = -10; x < W + 40; x += 46) drawSpruce(x + ((x * 7) % 13), 690 - ((x * 13) % 20));

  ctx.fillStyle = mix(C.dirt, "#181f16", night * 0.85);
  ctx.fillRect(0, GROUND_Y - 4, W, H - GROUND_Y + 4);
  ctx.fillStyle = mix(C.grass, "#20331f", night * 0.85);
  ctx.fillRect(0, GROUND_Y - 4, W, 30);
  ctx.fillStyle = mix(C.grassDark, "#182a17", night * 0.85);
  for (let x = 0; x < W; x += 16) ctx.fillRect(x + 4, GROUND_Y - 10, 3, 8);
}

function drawStars(night) {
  if (night < 0.04) return;
  for (let i = 0; i < 70; i++) {
    const x = (i * 97) % W;
    const y = (i * 53) % 420;
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(state.t * 1.5 + i));
    ctx.fillStyle = `rgba(255,255,255,${tw * night})`;
    ctx.fillRect(x, y, 2, 2);
  }
}

function drawCelestials(light) {
  const night = 1 - light;
  const sa = clamp01(light * 1.4 - 0.2);
  if (sa > 0.02) {
    ctx.globalAlpha = sa;
    ctx.fillStyle = "rgba(255,240,170,0.25)";
    ctx.beginPath(); ctx.arc(420, 300 - light * 180, 66, 0, TAU); ctx.fill();
    ctx.fillStyle = "#ffe08a";
    ctx.beginPath(); ctx.arc(420, 300 - light * 180, 46, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }
  const ma = clamp01(night * 1.4 - 0.2);
  if (ma > 0.02) {
    const my = 300 - night * 180;
    ctx.globalAlpha = ma;
    ctx.fillStyle = "#eaf0ff";
    ctx.beginPath(); ctx.arc(120, my, 38, 0, TAU); ctx.fill();
    ctx.fillStyle = kf(todPhase(), SKY_TOP);
    ctx.beginPath(); ctx.arc(136, my - 10, 32, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawAurora(night) {
  const alpha = clamp01((night - 0.45) / 0.35);
  if (alpha <= 0.02) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const bands = [
    { y: 250, amp: 34, col: "94,255,170", speed: 0.5 },
    { y: 300, amp: 26, col: "90,220,255", speed: 0.7 },
    { y: 210, amp: 40, col: "200,140,255", speed: 0.35 },
  ];
  for (const b of bands) {
    const grad = ctx.createLinearGradient(0, b.y - 90, 0, b.y + 50);
    grad.addColorStop(0, `rgba(${b.col},0)`);
    grad.addColorStop(0.5, `rgba(${b.col},${0.28 * alpha})`);
    grad.addColorStop(1, `rgba(${b.col},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 12) {
      const y = b.y - 70 + Math.sin(x * 0.012 + state.t * b.speed) * b.amp;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    for (let x = W; x >= 0; x -= 12) {
      const y = b.y + 50 + Math.sin(x * 0.012 + state.t * b.speed + 1) * b.amp;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawCloud(x, y, s) {
  ctx.beginPath();
  ctx.arc(x, y, 26 * s, 0, TAU);
  ctx.arc(x + 30 * s, y + 6 * s, 22 * s, 0, TAU);
  ctx.arc(x - 28 * s, y + 8 * s, 20 * s, 0, TAU);
  ctx.arc(x + 4 * s, y + 14 * s, 24 * s, 0, TAU);
  ctx.fill();
}

function drawRange(baseY, body, snow) {
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  const peaks = 5;
  for (let i = 0; i <= peaks; i++) {
    const x = (W / peaks) * i;
    const h = 120 + ((i * 53) % 90);
    ctx.lineTo(x - W / peaks / 2, baseY - h);
    ctx.lineTo(x, baseY - h * 0.55);
  }
  ctx.lineTo(W, baseY);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = snow;
  for (let i = 0; i <= peaks; i++) {
    const x = (W / peaks) * i - W / peaks / 2;
    const h = 120 + ((i * 53) % 90);
    ctx.beginPath();
    ctx.moveTo(x, baseY - h);
    ctx.lineTo(x - 18, baseY - h + 30);
    ctx.lineTo(x - 4, baseY - h + 22);
    ctx.lineTo(x + 6, baseY - h + 32);
    ctx.lineTo(x + 18, baseY - h + 24);
    ctx.closePath();
    ctx.fill();
  }
}

function drawSpruce(x, baseY) {
  ctx.beginPath();
  ctx.moveTo(x, baseY - 60);
  ctx.lineTo(x - 20, baseY);
  ctx.lineTo(x + 20, baseY);
  ctx.closePath();
  ctx.moveTo(x, baseY - 40);
  ctx.lineTo(x - 24, baseY + 14);
  ctx.lineTo(x + 24, baseY + 14);
  ctx.closePath();
  ctx.fill();
}

function drawPumpjack(x, y, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(x - 16, y);
  ctx.lineTo(x, y - 40);
  ctx.lineTo(x + 16, y);
  ctx.stroke();
  const nod = Math.sin(state.t * 1.4) * 0.25;
  ctx.save();
  ctx.translate(x, y - 40);
  ctx.rotate(nod);
  ctx.fillRect(-46, -4, 90, 8);
  ctx.beginPath();
  ctx.moveTo(44, -4);
  ctx.lineTo(58, 14);
  ctx.lineTo(40, 12);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ---- trunk, branches, owls, bears ---- */

function segBaseY(i) {
  return GROUND_Y - i * SEG_H - state.slide;
}

function drawTrunk() {
  const playing = state.scene === "playing";
  const dead = state.scene === "dead";
  for (let i = state.segments.length - 1; i >= 0; i--) {
    const seg = state.segments[i];
    const baseY = segBaseY(i);
    const topY = baseY - SEG_H;
    const left = TRUNK_X - TRUNK_W / 2;

    ctx.fillStyle = C.barkLight;
    ctx.fillRect(left, topY, TRUNK_W, SEG_H);
    ctx.fillStyle = C.barkShade;
    ctx.fillRect(left, topY, 14, SEG_H);
    ctx.fillRect(TRUNK_X + TRUNK_W / 2 - 8, topY, 8, SEG_H);

    ctx.fillStyle = C.knot;
    const seed = (i * 928371) % 1000;
    drawKnot(TRUNK_X - 18 + (seed % 20), topY + 34 + (seed % 40));
    drawKnot(TRUNK_X + 14 - (seed % 16), topY + 92 - (seed % 30));

    if (seg.branch) {
      const live = i === 0;
      const danger = live && playing && seg.branch === state.beaverSide;
      const attacking = live && dead && state.deathCause === seg.type && seg.branch === state.hitSide;
      const y = baseY - SEG_H * 0.52;
      const opts = { live, danger, attacking };
      if (seg.type === "owl") drawOwl(seg.branch, y, opts);
      else if (seg.type === "bear") drawBear(seg.branch, y, opts);
      else drawBranch(seg.branch, y, opts);
    }
  }
}

function drawKnot(x, y) {
  ctx.beginPath();
  ctx.ellipse(x, y, 8, 5, 0, 0, TAU);
  ctx.fill();
}

function hazardGlow(x, y, opts, radius) {
  if (!opts.live) return;
  if (opts.danger) {
    const p = 0.4 + 0.35 * Math.sin(state.t * 12);
    ctx.fillStyle = `rgba(255,70,70,${p})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
    drawWarning(x, y - radius - 12);
  } else {
    ctx.fillStyle = "rgba(255,214,90,0.18)";
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.9, 0, TAU);
    ctx.fill();
  }
}

function drawBranch(side, y, opts = {}) {
  const dir = side === "left" ? -1 : 1;
  const x0 = TRUNK_X + dir * (TRUNK_W / 2 - 4);
  const tx = x0 + dir * 76, ty = y - 36;

  if (opts.live) {
    const dangerPulse = opts.danger ? 0.45 + 0.4 * Math.sin(state.t * 12) : 0.3;
    ctx.strokeStyle = opts.danger ? `rgba(255,70,70,${dangerPulse})` : "rgba(255,214,90,0.32)";
    ctx.lineWidth = opts.danger ? 30 : 24;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(tx, ty);
    ctx.stroke();
  }

  ctx.strokeStyle = C.branch;
  ctx.lineWidth = 16;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  ctx.fillStyle = C.leaf;
  for (let k = 0; k < 4; k++) {
    const lx = x0 + dir * (34 + k * 15);
    const ly = y - 22 - k * 8 - (k % 2) * 8;
    ctx.beginPath();
    ctx.ellipse(lx, ly, 13, 9, dir * 0.5, 0, TAU);
    ctx.fill();
  }

  if (opts.danger) drawWarning(tx + dir * 6, ty - 34);
}

function drawWarning(x, y) {
  const pulse = 0.7 + 0.3 * Math.sin(state.t * 12);
  ctx.fillStyle = `rgba(255,60,60,${pulse})`;
  ctx.beginPath();
  ctx.arc(x, y, 15, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "900 22px Trebuchet MS, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("!", x, y + 8);
  ctx.textAlign = "left";
}

function drawOwl(side, y, opts = {}) {
  drawBranch(side, y, opts);
  const dir = side === "left" ? -1 : 1;
  const x = TRUNK_X + dir * 96;
  const oy = y - 34;
  const lunge = opts.attacking ? easeOut(state.deathT) : 0;

  ctx.save();
  ctx.translate(x + dir * lunge * 24, oy + lunge * 30);

  if (opts.attacking) {
    const flap = Math.sin(state.t * 22) * 0.4;
    ctx.fillStyle = "#6f6151";
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.rotate(s * (0.7 + flap));
      ctx.beginPath();
      ctx.ellipse(s * 26, 0, 26, 12, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  ctx.fillStyle = "#8a7a63";
  ctx.beginPath(); ctx.ellipse(0, 0, 24, 30, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = "#6f6151";
  ctx.beginPath(); ctx.ellipse(0, 6, 15, 20, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = "#8a7a63";
  ctx.beginPath();
  ctx.moveTo(-16, -22); ctx.lineTo(-22, -40); ctx.lineTo(-8, -26); ctx.closePath();
  ctx.moveTo(16, -22); ctx.lineTo(22, -40); ctx.lineTo(8, -26); ctx.closePath();
  ctx.fill();
  const eyeR = opts.attacking ? 11 : 9;
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(-9, -6, eyeR, 0, TAU); ctx.arc(9, -6, eyeR, 0, TAU); ctx.fill();
  ctx.fillStyle = "#111";
  const blink = !opts.attacking && Math.sin(state.t * 3 + x) > 0.9 ? 2 : 5;
  ctx.beginPath(); ctx.arc(-9, -6, blink, 0, TAU); ctx.arc(9, -6, blink, 0, TAU); ctx.fill();
  if (opts.attacking) {
    ctx.fillStyle = "#e6b800";
    ctx.beginPath(); ctx.arc(-9, -6, 3, 0, TAU); ctx.arc(9, -6, 3, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = "#e6a23c";
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-4, 8); ctx.lineTo(4, 8); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// a whole-body black bear hugging the trunk on the given side
function drawBear(side, y, opts = {}) {
  const dir = side === "left" ? -1 : 1;
  const edge = TRUNK_X + dir * (TRUNK_W / 2);
  const cx = edge + dir * 20;          // body straddles the trunk edge
  hazardGlow(cx, y, opts, 48);
  const lunge = opts.attacking ? easeOut(state.deathT) : 0;

  const black = "#2b2b2b", dark = "#1e1e1e", claw = "#e6d3aa", tan = "#c7a06a";

  ctx.save();
  ctx.translate(cx + dir * lunge * 26, y + lunge * 6);
  ctx.scale(dir, 1); // local -x points toward the trunk, +x toward the beaver

  ctx.strokeStyle = dark;
  ctx.lineCap = "round";

  // far legs/arms wrapping around the trunk (drawn behind the body)
  ctx.lineWidth = 22;
  ctx.beginPath(); ctx.moveTo(-8, 46); ctx.lineTo(-52, 34); ctx.stroke();   // back leg
  ctx.beginPath(); ctx.moveTo(-6, -30); ctx.lineTo(-54, -18); ctx.stroke(); // front arm

  // claws gripping the trunk edge
  ctx.fillStyle = claw;
  for (const gy of [-18, 34]) for (let i = -1; i <= 1; i++) {
    ctx.beginPath(); ctx.ellipse(-54, gy + i * 6, 3, 2, 0, 0, TAU); ctx.fill();
  }

  // body hugging the trunk (tall)
  ctx.fillStyle = black;
  ctx.beginPath(); ctx.ellipse(4, 6, 30, 48, 0, 0, TAU); ctx.fill();
  // belly patch
  ctx.fillStyle = "#3a3a3a";
  ctx.beginPath(); ctx.ellipse(10, 12, 15, 30, 0, 0, TAU); ctx.fill();

  // near legs/arms over the body, also gripping toward the trunk
  ctx.strokeStyle = black;
  ctx.lineWidth = 18;
  ctx.beginPath(); ctx.moveTo(8, 40); ctx.lineTo(-34, 48); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(10, -14); ctx.lineTo(-36, -6); ctx.stroke();

  // head near the top, turned to face the beaver
  const hx = 12, hy = -46;
  ctx.fillStyle = black;
  ctx.beginPath(); ctx.arc(hx, hy, 25, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(hx - 16, hy - 16, 10, 0, TAU); ctx.arc(hx + 18, hy - 15, 10, 0, TAU); ctx.fill();
  ctx.fillStyle = "#5a4634";
  ctx.beginPath(); ctx.arc(hx - 16, hy - 16, 5, 0, TAU); ctx.arc(hx + 18, hy - 15, 5, 0, TAU); ctx.fill();
  // muzzle
  ctx.fillStyle = tan;
  ctx.beginPath(); ctx.ellipse(hx + 13, hy + 8, 14, 11, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = "#141414";
  ctx.beginPath(); ctx.ellipse(hx + 18, hy + 4, 5, 4, 0, 0, TAU); ctx.fill();
  // eyes
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(hx + 3, hy - 6, 6, 0, TAU); ctx.arc(hx + 21, hy - 6, 6, 0, TAU); ctx.fill();
  ctx.fillStyle = "#111";
  const bl = opts.attacking ? 4 : 3;
  ctx.beginPath(); ctx.arc(hx + 3, hy - 6, bl, 0, TAU); ctx.arc(hx + 21, hy - 6, bl, 0, TAU); ctx.fill();
  if (opts.attacking) {
    // angry brow + open mouth
    ctx.strokeStyle = "#000"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(hx - 4, hy - 14); ctx.lineTo(hx + 10, hy - 8); ctx.stroke();
    ctx.fillStyle = "#5a1010";
    ctx.beginPath(); ctx.ellipse(hx + 16, hy + 12, 7, 5, 0, 0, TAU); ctx.fill();
    // swipe paw lunging at the beaver
    ctx.fillStyle = black;
    ctx.beginPath(); ctx.ellipse(46, 6, 15, 12, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = claw;
    for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.ellipse(59, 2 + i * 6, 3, 2, 0, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}

/* ---- the beaver ---- */

function drawBeaver() {
  const dead = state.scene === "dead";
  const cause = state.deathCause;
  const side = dead ? state.hitSide : state.beaverSide;
  const facing = side === "left" ? 1 : -1;
  const cx = TRUNK_X + (side === "left" ? -BEAVER_OFFSET : BEAVER_OFFSET);
  const feetY = GROUND_Y;

  const chomp = dead ? 0 : state.chompT;
  const alarm = !dead && state.dangerNow ? 1 : 0;
  const idle = state.scene === "playing" || dead ? 0 : Math.sin(state.t * 2) * 3;

  const dT = dead ? easeOut(state.deathT) : 0;
  const topple = cause === "branch" ? dT * 1.5 : 0;   // fall over flat
  const stun = cause === "owl" ? dT : 0;              // squashed + dizzy
  const pancake = cause === "bear" ? dT : 0;          // flattened
  const slump = cause === "time" ? dT : 0;            // deflate

  const lean = chomp * 14 * facing - alarm * 12 * facing;
  const squashY = 1 + chomp * 0.12 - stun * 0.4 - slump * 0.28 - pancake * 0.62;
  const faceMode = dead
    ? (cause === "branch" ? "x" : cause === "owl" ? "dizzy" : cause === "bear" ? "x" : "tired")
    : (alarm ? "alarm" : "normal");

  ctx.save();
  ctx.translate(cx + lean, feetY + idle);
  ctx.scale(facing, 1);
  if (topple) ctx.rotate(-topple);
  if (pancake) ctx.scale(1 + pancake * 0.5, 1);
  if (slump) ctx.translate(0, slump * 12);

  // tail
  ctx.fillStyle = C.beaverDark;
  ctx.beginPath();
  ctx.ellipse(-34, -20, 20, 13, -0.5, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1.5;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(-46, -22 + i * 7);
    ctx.lineTo(-24, -18 + i * 7);
    ctx.stroke();
  }

  // body
  ctx.fillStyle = C.beaver;
  ctx.beginPath();
  ctx.ellipse(0, -46 * squashY, 34, 44 * squashY, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = C.ink; ctx.lineWidth = 2.5; ctx.stroke();
  // belly
  ctx.fillStyle = C.beaverBelly;
  ctx.beginPath();
  ctx.ellipse(6, -40 * squashY, 20, 30 * squashY, 0, 0, TAU);
  ctx.fill();

  // arm
  ctx.strokeStyle = C.beaverDark;
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(10, -52);
  if (alarm) ctx.lineTo(26, -74);
  else ctx.lineTo(30, -46 + chomp * 4);
  ctx.stroke();

  // head
  const hy = -92 * squashY;
  ctx.fillStyle = C.beaver;
  ctx.beginPath();
  ctx.ellipse(8, hy, 26, 24, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = C.ink; ctx.lineWidth = 2.5; ctx.stroke();

  // ear
  ctx.fillStyle = C.beaverDark;
  ctx.beginPath();
  ctx.arc(-6, hy - 18, 7, 0, TAU);
  ctx.fill();

  // muzzle
  ctx.fillStyle = C.beaverBelly;
  ctx.beginPath();
  ctx.ellipse(20, hy + 8, 14, 12, 0, 0, TAU);
  ctx.fill();

  // buck teeth
  const gap = 2 + chomp * 8 + alarm * 5;
  ctx.fillStyle = C.tooth;
  ctx.fillRect(20, hy + 10, 5, 8 + gap);
  ctx.fillRect(26, hy + 10, 5, 8 + gap);
  ctx.strokeStyle = "rgba(0,0,0,0.2)";
  ctx.lineWidth = 1;
  ctx.strokeRect(20, hy + 10, 5, 8 + gap);
  ctx.strokeRect(26, hy + 10, 5, 8 + gap);

  // nose
  ctx.fillStyle = "#3a2a1c";
  ctx.beginPath();
  ctx.ellipse(30, hy + 2, 6, 5, 0, 0, TAU);
  ctx.fill();

  drawFace(faceMode, hy);

  // toque
  ctx.fillStyle = C.toque;
  ctx.beginPath();
  ctx.moveTo(-16, hy - 12);
  ctx.quadraticCurveTo(8, hy - 44, 30, hy - 12);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = C.toqueBand;
  ctx.fillRect(-16, hy - 16, 46, 8);
  ctx.beginPath();
  ctx.arc(8, hy - 42, 7, 0, TAU);
  ctx.fill();

  ctx.restore();

  if (dead && cause === "owl") drawStars(cx, feetY - 118, 5, 30, 0.9);
}

function drawFace(mode, hy) {
  const ex = 14, ey = hy - 4;
  if (mode === "x") {
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ex - 6, ey - 6); ctx.lineTo(ex + 6, ey + 6);
    ctx.moveTo(ex + 6, ey - 6); ctx.lineTo(ex - 6, ey + 6);
    ctx.stroke();
  } else if (mode === "dizzy") {
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 3; a += 0.25) {
      const r = 1 + a * 1.1;
      const px = ex + Math.cos(a + state.t * 5) * r;
      const py = ey + Math.sin(a + state.t * 5) * r;
      a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
  } else if (mode === "tired") {
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ex - 6, ey - 3); ctx.lineTo(ex + 6, ey + 2);
    ctx.stroke();
  } else {
    const r = mode === "alarm" ? 9 : 7;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(ex, ey, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(ex + 2, ey - (mode === "alarm" ? 1 : 0), mode === "alarm" ? 4 : 3.4, 0, TAU);
    ctx.fill();
    if (mode === "alarm") {
      ctx.strokeStyle = "#3a2a1c";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(ex - 5, ey - 13); ctx.lineTo(ex + 11, ey - 9);
      ctx.stroke();
    }
  }
}

function drawStars(cx, cy, n, radius, speed) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + state.t * speed * 3;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius * 0.5;
    star(x, y, 6, "#ffe27a");
  }
}

function star(x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU - Math.PI / 2;
    const a2 = a + Math.PI / 5;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    ctx.lineTo(x + Math.cos(a2) * r * 0.45, y + Math.sin(a2) * r * 0.45);
  }
  ctx.closePath();
  ctx.fill();
}

function drawParticles() {
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = clamp01(p.life / p.max);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    if (p.star) {
      star(0, 0, p.size, p.color);
    } else {
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  for (const l of flyingLogs) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, l.life);
    ctx.translate(l.x, l.y);
    ctx.rotate(l.rot);
    ctx.fillStyle = C.barkLight;
    ctx.fillRect(-30, -16, 60, 32);
    ctx.fillStyle = "#c9a36f";
    ctx.beginPath();
    ctx.ellipse(-30, 0, 8, 16, 0, 0, TAU);
    ctx.ellipse(30, 0, 8, 16, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

/* ---- HUD & overlays ---- */

function drawHUD() {
  const bw = W - 120, bx = 60, by = 40;
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  roundRect(bx - 4, by - 4, bw + 8, 26, 13);
  ctx.fill();
  const frac = state.timer / MAX_TIME;
  const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  g.addColorStop(0, frac < 0.3 ? "#e23b3b" : "#f4a72c");
  g.addColorStop(1, frac < 0.3 ? "#f47c2c" : "#ffe08a");
  ctx.fillStyle = g;
  roundRect(bx, by, Math.max(0, bw * frac), 18, 9);
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 6;
  ctx.textAlign = "center";
  ctx.font = "900 92px Trebuchet MS, sans-serif";
  ctx.strokeText(state.score, W / 2, 180);
  ctx.fillText(state.score, W / 2, 180);

  if (state.combo >= 3) {
    ctx.font = "900 30px Trebuchet MS, sans-serif";
    ctx.fillStyle = "#ffe08a";
    ctx.fillText(`x${state.combo} combo`, W / 2, 220);
  }

  if (state.shield > 0) {
    ctx.textAlign = "left";
    ctx.font = "900 30px Trebuchet MS, sans-serif";
    ctx.fillText("🛡️", 22, 200);
  }

  for (const p of popups) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.font = `900 ${p.big ? 40 : 28}px Trebuchet MS, sans-serif`;
    ctx.fillStyle = "#fff2a8";
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 5;
    ctx.strokeText(p.text, W / 2, p.y);
    ctx.fillText(p.text, W / 2, p.y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

function drawTitle() {
  dim(0.28);
  ctx.textAlign = "center";

  ctx.save();
  ctx.translate(W / 2, 300 + Math.sin(state.t * 2) * 6);
  ctx.rotate(-0.04);
  ctx.font = "900 96px Trebuchet MS, sans-serif";
  ctx.lineWidth = 12;
  ctx.strokeStyle = "#20201d";
  ctx.strokeText("DAM IT!", 0, 0);
  ctx.fillStyle = "#ffd24a";
  ctx.fillText("DAM IT!", 0, 0);
  ctx.restore();

  ctx.font = "700 26px Trebuchet MS, sans-serif";
  ctx.fillStyle = "#fff";
  ctx.fillText("A very Alberta beaver problem.", W / 2, 360);

  if (Math.sin(state.t * 4) > -0.3) {
    ctx.font = "900 34px Trebuchet MS, sans-serif";
    ctx.fillStyle = "#fff";
    ctx.fillText("TAP  or  ← →  to chop", W / 2, 560);
  }

  ctx.font = "600 22px Trebuchet MS, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText("Chomp the side with no branch, owl, or bear.", W / 2, 620);
  ctx.fillText(`Best: ${state.best}`, W / 2, 660);
  ctx.textAlign = "left";
}

function drawDead() {
  dim(0.5);
  ctx.textAlign = "center";

  ctx.font = "900 74px Trebuchet MS, sans-serif";
  ctx.lineWidth = 10;
  ctx.strokeStyle = "#20201d";
  ctx.strokeText("TIMBER!", W / 2, 300);
  ctx.fillStyle = "#ff6b6b";
  ctx.fillText("TIMBER!", W / 2, 300);

  ctx.font = "800 88px Trebuchet MS, sans-serif";
  ctx.fillStyle = "#fff";
  ctx.fillText(state.score, W / 2, 420);
  ctx.font = "700 26px Trebuchet MS, sans-serif";
  ctx.fillStyle = "#ffe08a";
  const nb = state.score >= state.best && state.score > 0;
  ctx.fillText(nb ? "🍁 NEW BEST! 🍁" : `Best: ${state.best}`, W / 2, 462);

  ctx.font = "800 30px Trebuchet MS, sans-serif";
  ctx.fillStyle = "#9be89b";
  ctx.fillText(`+${state.lastEarned} 🪵 for the colony`, W / 2, 508);

  ctx.font = "italic 600 24px Trebuchet MS, sans-serif";
  ctx.fillStyle = "#fff";
  wrapText(state.deathLine || "", W / 2, 566, W - 120, 32);

  if (performance.now() - state.deathAt > 500 && Math.sin(state.t * 4) > -0.3) {
    ctx.font = "900 32px Trebuchet MS, sans-serif";
    ctx.fillStyle = "#fff";
    ctx.fillText("TAP to visit the valley", W / 2, 662);
  }
  ctx.textAlign = "left";
}

function dim(a) {
  ctx.fillStyle = `rgba(10,16,26,${a})`;
  ctx.fillRect(0, 0, W, H);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// break text into lines that fit maxW using the current ctx.font
function wrapLines(text, maxW) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function wrapText(text, x, y, maxW, lh) {
  const words = text.split(" ");
  let line = "", yy = y;
  for (const w of words) {
    const test = line + w + " ";
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line.trim(), x, yy);
      line = w + " ";
      yy += lh;
    } else {
      line = test;
    }
  }
  ctx.fillText(line.trim(), x, yy);
}

function render() {
  if (state.scene === "home") { drawHome(); return; }

  ctx.save();
  if (state.shake > 0.3) {
    ctx.translate((Math.random() - 0.5) * state.shake, (Math.random() - 0.5) * state.shake);
  }

  drawBackground();
  drawTrunk();
  drawBeaver();
  drawParticles();

  if (state.scene !== "title") drawHUD();

  if (state.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${state.flash * 0.6})`;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.restore();

  if (state.scene === "title") drawTitle();
  else if (state.scene === "dead") drawDead();
}

/* ======================================================================= */
/* The Valley — home hub (Phase 2)                                         */
/* ======================================================================= */

const HOME_BTN = {
  a:    { x: 28, y: 704, w: 158, h: 94 },   // Dam  (or wide New-Valley when maxed)
  b:    { x: 191, y: 704, w: 158, h: 94 },  // Lodge
  c:    { x: 354, y: 704, w: 158, h: 94 },  // Have a Kit
  play: { x: 70, y: 842, w: 400, h: 94 },
};
const HOME_WIDE = { x: 28, y: 704, w: 321, h: 94 }; // slots a+b combined for prestige

function pointIn(r, mx, my) {
  return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
}

function goHome() {
  state.scene = "home";
  state.homeAt = performance.now();
  if (meta.runsLeft <= 0) resolveWinter();
}

function resolveWinter() {
  const water = damWater();
  const target = seasonTarget();
  state.frozen = true; // ice over the pond for the winter beat
  if (water >= target) {
    const bonus = 20 * meta.season * meta.valley;
    if (meta.colony < COLONY_MAX) meta.colony += 1;
    meta.wood += bonus;
    meta.season += 1;
    state.winterResult = { ok: true, text: `❄ Winter survived! 🍼 A kit is born — colony ${meta.colony}. +${bonus} 🪵.` };
    tone(523, 0.12, "square", 0.15);
    setTimeout(() => tone(784, 0.16, "square", 0.15), 120);
    setTimeout(() => tone(1046, 0.2, "square", 0.15), 260);
  } else {
    meta.dam = 0; // the dam gives out under the ice
    state.winterResult = { ok: false, text: `❄ Winter! The dam gave out and the pond froze over. Rebuild it — your wood, kits & valley are safe.` };
    tone(220, 0.5, "sawtooth", 0.22, 70);
    crackle(0.5, 0.35, 500, 2.5);
  }
  meta.runsLeft = SEASON_RUNS;
  saveMeta();
}

function buyDam() {
  if (meta.dam >= DAM_MAX || meta.wood < damCost()) return;
  meta.wood -= damCost();
  meta.dam += 1;
  saveMeta();
  tone(300, 0.1, "square", 0.14, 480);
}

function buyLodge() {
  if (meta.lodge >= LODGE_MAX || meta.wood < lodgeCost()) return;
  meta.wood -= lodgeCost();
  meta.lodge += 1;
  saveMeta();
  tone(260, 0.1, "square", 0.14, 420);
}

function buyKit() {
  if (meta.colony >= COLONY_MAX || meta.wood < colonyCost()) return;
  meta.wood -= colonyCost();
  meta.colony += 1;
  saveMeta();
  tone(700, 0.12, "square", 0.14, 1050);
  popups.push({ text: "🍼", y: 300, life: 1 });
}

// move downstream: reset the dam & lodge into a bigger, richer valley
function prestige() {
  if (!canPrestige()) return;
  meta.valley += 1;
  meta.mult = meta.valley;
  meta.dam = 0;
  meta.lodge = 0;
  saveMeta();
  state.winterResult = {
    ok: true,
    text: `🏞️ Valley ${meta.valley}! Bigger creek downstream. Dam & lodge reset, but wood now flows ×${meta.mult} — rebuild grander.`,
  };
  [392, 523, 659, 784].forEach((f, i) => setTimeout(() => tone(f, 0.16, "square", 0.15), i * 110));
}

function handleHomeTap(mx, my) {
  if (pointIn(HOME_BTN.play, mx, my)) { state.winterResult = null; startRun(); return; }
  if (pointIn(HOME_BTN.c, mx, my)) { buyKit(); return; }
  if (canPrestige()) {
    if (pointIn(HOME_WIDE, mx, my)) { prestige(); return; }
  } else {
    if (pointIn(HOME_BTN.a, mx, my)) { buyDam(); return; }
    if (pointIn(HOME_BTN.b, mx, my)) { buyLodge(); return; }
  }
  if (state.winterResult) { state.winterResult = null; state.frozen = false; }
}

function drawButton(r, title, sub, enabled, accent, big) {
  ctx.fillStyle = enabled ? accent : "rgba(120,120,120,0.4)";
  roundRect(r.x, r.y, r.w, r.h, 16);
  ctx.fill();
  ctx.fillStyle = enabled ? "#fff" : "rgba(255,255,255,0.55)";
  ctx.textAlign = "center";
  ctx.font = `900 ${big ? 26 : 20}px Trebuchet MS, sans-serif`;
  ctx.fillText(title, r.x + r.w / 2, r.y + (sub ? (big ? 40 : 38) : r.h / 2 + 9));
  if (sub) {
    ctx.font = `700 ${big ? 19 : 14}px Trebuchet MS, sans-serif`;
    ctx.fillText(sub, r.x + r.w / 2, r.y + (big ? 68 : 64));
  }
  ctx.textAlign = "left";
}

// A stick-mound lodge rising from the pond floor (baseY) to apexY just above the
// water, outlined so it reads as an object, with an underwater entrance at the base.
function drawLodge(cx, baseY, apexY, level) {
  const rw = 76 + level * 2;

  // mound body + outline
  ctx.beginPath();
  ctx.moveTo(cx - rw, baseY);
  ctx.quadraticCurveTo(cx - rw, apexY, cx, apexY);
  ctx.quadraticCurveTo(cx + rw, apexY, cx + rw, baseY);
  ctx.closePath();
  ctx.fillStyle = "#7c5730";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#3d2915";
  ctx.stroke();

  // stick texture, clipped to the mound
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = "#8f6a3d";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (let i = -6; i <= 6; i++) {
    ctx.beginPath();
    ctx.moveTo(cx + i * 15, baseY + 6);
    ctx.lineTo(cx + i * 7, apexY + 10);
    ctx.stroke();
  }
  ctx.restore();

  // snow cap on the exposed top
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath();
  ctx.moveTo(cx - 34, apexY + 22);
  ctx.quadraticCurveTo(cx, apexY - 8, cx + 34, apexY + 22);
  ctx.quadraticCurveTo(cx, apexY + 28, cx - 34, apexY + 22);
  ctx.closePath();
  ctx.fill();

  // chimney smoke
  ctx.fillStyle = "rgba(230,230,242,0.5)";
  for (let i = 0; i < 3; i++) {
    const yy = apexY - 8 - i * 14 - ((state.t * 12) % 14);
    ctx.beginPath();
    ctx.arc(cx + 6 + Math.sin(state.t + i) * 5, yy, 5 - i, 0, TAU);
    ctx.fill();
  }

  // underwater entrance at the base (dark tunnel; the translucent water tints it)
  ctx.fillStyle = "#20130a";
  ctx.beginPath();
  ctx.ellipse(cx, baseY - 10, 18, 22, 0, 0, TAU);
  ctx.fill();
}

function drawKit(x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = C.beaver;
  ctx.beginPath(); ctx.ellipse(0, 0, 20, 18, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = C.beaverBelly;
  ctx.beginPath(); ctx.ellipse(0, 4, 11, 10, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(-6, -4, 4, 0, TAU); ctx.arc(6, -4, 4, 0, TAU); ctx.fill();
  ctx.fillStyle = "#111";
  ctx.beginPath(); ctx.arc(-6, -4, 2, 0, TAU); ctx.arc(6, -4, 2, 0, TAU); ctx.fill();
  ctx.fillStyle = C.tooth;
  ctx.fillRect(-3, 4, 6, 5);
  ctx.restore();
}

// a wall of stacked logs that grows with the water it holds back
function drawDamWall(x, bedY, topY) {
  const w = 32;
  const rows = Math.max(1, Math.round((bedY - topY) / 13));
  for (let i = 0; i < rows; i++) {
    const y = bedY - 8 - i * 13;
    ctx.fillStyle = i % 2 ? "#7c5a34" : "#8b6a3f";
    roundRect(x - w / 2, y - 6, w, 12, 4);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(58,38,20,0.5)";
    roundRect(x - w / 2, y - 6, w, 12, 4);
    ctx.stroke();
  }
  // log ends (dots) for a woodpile read
  ctx.fillStyle = "#caa06a";
  for (let i = 0; i < rows; i += 1) {
    const y = bedY - 8 - i * 13;
    ctx.beginPath();
    ctx.arc(x - w / 2 + 5, y, 2.4, 0, TAU);
    ctx.fill();
  }
}

// ice + falling snow over the creek during the winter beat
function drawFreeze(cRim, bedY, damX, leftY, streamY) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, cRim, W, bedY - cRim + 14);
  ctx.clip();
  ctx.fillStyle = "rgba(224,238,248,0.86)";
  ctx.fillRect(0, leftY - 2, damX, bedY - leftY + 16);
  ctx.fillRect(damX, streamY - 2, W - damX, bedY - streamY + 16);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) {
    const bx = 20 + i * 58;
    ctx.beginPath();
    ctx.moveTo(bx, leftY + 4);
    ctx.lineTo(bx + 18, leftY + 24);
    ctx.lineTo(bx + 4, leftY + 44);
    ctx.stroke();
  }
  ctx.restore();
  // snow over the whole scene
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  for (let i = 0; i < 46; i++) {
    const sx = (i * 137 + state.t * 26 * (0.5 + (i % 3) * 0.25)) % W;
    const sy = (i * 71 + state.t * 55) % 700;
    ctx.beginPath();
    ctx.arc(sx, sy, 1.6 + (i % 2), 0, TAU);
    ctx.fill();
  }
}

function drawHome() {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#7cc0e6");
  sky.addColorStop(0.55, "#bfe0d6");
  sky.addColorStop(1, "#e9d9b0");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  drawRange(430, "#8aa6c6", "#eef4f8");
  ctx.fillStyle = "#57b6e6";
  drawCloud((state.t * 8) % (W + 160) - 80, 110, 0.8);

  // grassy ground across the whole valley
  ctx.fillStyle = "#5aa845";
  ctx.fillRect(0, 452, W, H - 452);
  ctx.fillStyle = "#4f9a3f";
  ctx.fillRect(0, 452, W, 9);

  // ---- the creek runs the full width; the dam holds the water high on the LEFT ----
  const cRim = 476, bedY = 650, streamY = 632, loMax = 496, damX = 350;
  const water = damWater(), target = seasonTarget();
  const leftY = streamY - (streamY - loMax) * (water / 100); // left-pool surface rises with the dam
  const targetY = streamY - (streamY - loMax) * (target / 100);

  // dug channel (mud) full width
  const bedGrad = ctx.createLinearGradient(0, cRim, 0, bedY);
  bedGrad.addColorStop(0, "#6f4d2e");
  bedGrad.addColorStop(1, "#402a17");
  ctx.fillStyle = bedGrad;
  ctx.fillRect(0, cRim, W, bedY - cRim + 12);
  ctx.fillStyle = "rgba(40,26,15,0.45)";
  ctx.fillRect(0, cRim, W, 5);

  // lodge in the pond behind the dam (drawn before the water so it half-submerges)
  drawLodge(150, bedY, loMax - 28, meta.lodge);

  // water: a high pool on the left of the dam, a low trickle on the right
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, cRim, W, bedY - cRim + 12);
  ctx.clip();
  ctx.fillStyle = "rgba(47,159,214,0.74)";
  ctx.fillRect(0, leftY, damX, bedY - leftY + 12);
  ctx.fillStyle = "rgba(47,159,214,0.58)";
  ctx.fillRect(damX, streamY, W - damX, bedY - streamY + 12);
  ctx.fillStyle = "rgba(170,218,240,0.9)";
  ctx.beginPath();
  ctx.moveTo(0, leftY);
  for (let x = 0; x <= damX; x += 14) ctx.lineTo(x, leftY + Math.sin(x * 0.05 + state.t * 2) * 3);
  ctx.lineTo(damX, leftY + 7);
  ctx.lineTo(0, leftY + 7);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(damX, streamY, W - damX, 3);
  ctx.restore();

  // overflow spilling over the dam
  if (leftY < streamY - 8) {
    ctx.fillStyle = "rgba(205,232,246,0.8)";
    ctx.fillRect(damX - 2, leftY, 9, streamY - leftY);
  }

  // the dam wall (grows with the water it holds)
  drawDamWall(damX, bedY, Math.min(leftY, streamY) - 3);

  // winter line across the pool + colony swimming
  ctx.strokeStyle = "#eef7ff";
  ctx.lineWidth = 3;
  ctx.setLineDash([9, 7]);
  ctx.beginPath();
  ctx.moveTo(6, targetY);
  ctx.lineTo(damX - 6, targetY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#2c4a72";
  ctx.font = "700 16px Trebuchet MS, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`❄ need ${target}%`, 8, targetY - 6);

  const surf = Math.min(leftY, bedY - 14);
  for (let i = 0; i < Math.min(meta.colony, 6); i++) {
    drawKit(246 + (i % 3) * 34, surf - 2 + Math.floor(i / 3) * 18, 0.5);
  }

  if (state.frozen) drawFreeze(cRim, bedY, damX, leftY, streamY);

  // header
  ctx.textAlign = "center";
  ctx.fillStyle = "#213247";
  ctx.font = "900 42px Trebuchet MS, sans-serif";
  ctx.fillText("THE VALLEY", W / 2, 72);
  ctx.font = "800 30px Trebuchet MS, sans-serif";
  ctx.fillStyle = "#5a3f1a";
  ctx.fillText(`🪵 ${meta.wood} wood${meta.mult > 1 ? `  ×${meta.mult}` : ""}`, W / 2, 112);
  ctx.font = "700 20px Trebuchet MS, sans-serif";
  ctx.fillStyle = "#2a3a2a";
  const rl = Math.max(0, meta.runsLeft);
  const line1 = meta.valley > 1 ? `Valley ${meta.valley}  ·  Season ${meta.season}` : `Season ${meta.season}`;
  ctx.fillText(line1, W / 2, 140);
  ctx.fillText(`${rl} run${rl === 1 ? "" : "s"} till ❄ winter  ·  pond ${water}%`, W / 2, 166);

  const since = (performance.now() - state.homeAt) / 1000;
  if (state.lastEarned > 0 && since < 2.4 && !state.winterResult) {
    ctx.globalAlpha = Math.max(0, 1 - since / 2.4);
    ctx.font = "900 30px Trebuchet MS, sans-serif";
    ctx.fillStyle = "#1a7a3a";
    ctx.fillText(`+${state.lastEarned} 🪵 banked!`, W / 2, 196);
    ctx.globalAlpha = 1;
  }

  // upgrade row — when the dam & lodge are maxed, their slots merge into New Valley
  if (canPrestige()) {
    drawButton(HOME_WIDE, "🏞️ New Valley", `move downstream · wood ×${meta.valley + 1}`, true, "#8a5cd6", true);
  } else {
    const canDam = meta.dam < DAM_MAX && meta.wood >= damCost();
    const canLodge = meta.lodge < LODGE_MAX && meta.wood >= lodgeCost();
    drawButton(HOME_BTN.a,
      meta.dam >= DAM_MAX ? "🌊 Dam max" : "🌊 Raise Dam",
      meta.dam >= DAM_MAX ? "pond full" : `raises water · ${damCost()}🪵`,
      canDam, "#2f9fd6");
    drawButton(HOME_BTN.b,
      meta.lodge >= LODGE_MAX ? "🏠 Lodge max" : "🏠 Lodge",
      meta.lodge >= LODGE_MAX ? `Lv ${meta.lodge}` : `tougher runs · ${lodgeCost()}🪵`,
      canLodge, "#c9762e");
  }
  const canKit = meta.colony < COLONY_MAX && meta.wood >= colonyCost();
  drawButton(HOME_BTN.c,
    meta.colony >= COLONY_MAX ? "🍼 Colony full" : "🍼 Have a Kit",
    meta.colony >= COLONY_MAX ? `${meta.colony} kits` : `longer runs · ${colonyCost()}🪵`,
    canKit, "#e0883c");
  drawButton(HOME_BTN.play, "▶ PLAY", "chop some trees", true, "#3aa34a", true);

  // winter banner (auto-sized to its message so nothing overflows)
  if (state.winterResult) {
    ctx.textAlign = "center";
    ctx.font = "800 22px Trebuchet MS, sans-serif";
    const lines = wrapLines(state.winterResult.text, W - 116);
    const lh = 28, padTop = 24, boxY = 230;
    const boxH = padTop + lines.length * lh + 34;
    ctx.fillStyle = state.winterResult.ok ? "rgba(26,120,58,0.96)" : "rgba(58,70,110,0.96)";
    roundRect(28, boxY, W - 56, boxH, 18);
    ctx.fill();
    ctx.fillStyle = "#fff";
    let ty = boxY + padTop + 16;
    for (const ln of lines) { ctx.fillText(ln, W / 2, ty); ty += lh; }
    ctx.font = "700 16px Trebuchet MS, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillText("tap to dismiss", W / 2, ty + 4);
  }
  ctx.textAlign = "left";
}

/* ======================================================================= */
/* Main loop                                                               */
/* ======================================================================= */

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  render();
  requestAnimationFrame(frame);
}

/* ======================================================================= */
/* Input                                                                   */
/* ======================================================================= */

function cycleTod() {
  todIdx = (todIdx + 1) % TOD_PRESETS.length;
  state.todOverride = TOD_PRESETS[todIdx];
  if (todButton) todButton.textContent = TOD_ICONS[todIdx];
}

// advance from the title or the death screen into the next scene
function advance() {
  if (state.scene === "title") startRun();
  else if (state.scene === "dead") { if (performance.now() - state.deathAt > 500) goHome(); }
  else if (state.scene === "home") { state.winterResult = null; startRun(); }
}

canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  audio();
  const rect = canvas.getBoundingClientRect();
  const mx = ((e.clientX - rect.left) / rect.width) * W;
  const my = ((e.clientY - rect.top) / rect.height) * H;
  if (state.scene === "playing") { chop(mx < W / 2 ? "left" : "right"); return; }
  if (state.scene === "home") { handleHomeTap(mx, my); return; }
  advance();
});

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  audio();
  if (state.scene === "playing") {
    if (k === "arrowleft" || k === "a") chop("left");
    else if (k === "arrowright" || k === "d") chop("right");
    else if (k === "t") cycleTod();
    return;
  }
  if (k === "t") { cycleTod(); return; }
  if (k === " " || k === "enter" || k === "arrowleft" || k === "arrowright") {
    e.preventDefault();
    advance();
  }
});

soundToggle.addEventListener("pointerdown", (e) => e.stopPropagation());
soundToggle.addEventListener("click", () => {
  state.soundOn = !state.soundOn;
  localStorage.setItem("damit_sound", state.soundOn ? "on" : "off");
  soundToggle.textContent = state.soundOn ? "🔊" : "🔇";
  if (state.soundOn) sfx.start();
});
soundToggle.textContent = state.soundOn ? "🔊" : "🔇";

if (todButton) {
  todButton.addEventListener("pointerdown", (e) => e.stopPropagation());
  todButton.addEventListener("click", cycleTod);
  todButton.textContent = TOD_ICONS[todIdx];
}

/* boot */
startRun();
state.scene = "title";
requestAnimationFrame(frame);
