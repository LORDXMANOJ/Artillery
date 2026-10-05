/**
 * FP-155 Canard Steering Assembly — photoreal engineering digital twin
 * ---------------------------------------------------------------------------
 * Three.js r169 (ES modules via import map, loaded with dynamic import() so the
 * page also works when opened straight from disk).
 *
 * Modules (in file order):
 *   0  Boot ................ loads Three.js + addons, fonts, starts the twin
 *   1  Math & easing ....... cubic-bezier solver, seeded RNG, helpers
 *   2  Audio FX ............ Web Audio synthesized clicks / latches / servo ticks
 *   3  Procedural textures . height→normal maps (lathe, knurl, brushed, micro),
 *                            PCB artwork, stencilled body livery, contact shadow
 *   4  Studio environment .. 1024×512 HDR equirect built in memory → PMREM
 *   5  Geometry kernels .... watertight revolve (with partial-sweep caps),
 *                            true helical thread, double-wedge fin loft, helix tube
 *   6  Materials ........... PBR library + section-cut hatched cap shader patch
 *   7  Assembly ............ seven subsystems, exploded-view metadata
 *   8  Flow FX ............. oblique shock cones + streamline particles
 *   9  Controller .......... state, UI binding, animation loop, OBJ export
 *  10  Mission analysis .... 2D trajectory / CEP dispersion plots (native canvas),
 *                            sensor modes, inductive link + interlock simulation
 *
 * Units: 1 scene unit = 77.5 mm (outer body radius = 1.0 → Ø155 mm).
 * The assembly is built along local +Y (nose up) and laid horizontally
 * (nose → +X) by rotating the root group.
 */
'use strict';

let THREE, OrbitControls, OBJExporter, mergeGeometries, RoundedBoxGeometry;

const MM_PER_UNIT = 77.5;

/* ═══════════════════════════════ 0 · BOOT ═══════════════════════════════ */

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function setStatus(text, progress, isError = false) {
  const label = document.getElementById('loaderText');
  const bar = document.getElementById('loaderBar');
  label.textContent = text;
  label.classList.toggle('error', isError);
  if (progress != null) bar.style.width = `${Math.round(progress * 100)}%`;
}

async function boot() {
  try {
    setStatus('Loading Three.js r169 modules…', 0.1);
    const [core, orbit, objExp, bgu, rbox] = await Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
      import('three/addons/exporters/OBJExporter.js'),
      import('three/addons/utils/BufferGeometryUtils.js'),
      import('three/addons/geometries/RoundedBoxGeometry.js'),
    ]);
    THREE = core;
    OrbitControls = orbit.OrbitControls;
    OBJExporter = objExp.OBJExporter;
    mergeGeometries = bgu.mergeGeometries;
    RoundedBoxGeometry = rbox.RoundedBoxGeometry;
  } catch (err) {
    console.error(err);
    setStatus('Could not load Three.js from the CDN. Check the network connection and reload.', 0, true);
    return;
  }

  setStatus('Loading stencil typeface…', 0.2);
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('80px "Allerta Stencil"'),
        document.fonts.load('600 20px "JetBrains Mono"'),
      ]),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  } catch { /* fall back to system fonts */ }

  try {
    await startTwin();
  } catch (err) {
    console.error(err);
    setStatus(`Initialization failed: ${err.message}`, 0, true);
  }
}

/* ═══════════════════════════ 1 · MATH & EASING ═══════════════════════════ */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const damp = (current, target, rate, dt) => lerp(current, target, 1 - Math.exp(-rate * dt));

/** CSS-style cubic-bezier(x1, y1, x2, y2) easing, solved by bisection. */
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 28; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}
const EASE_EXPLODE = cubicBezier(0.76, 0, 0.24, 1);
const EASE_CAMERA = cubicBezier(0.65, 0, 0.35, 1);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ═══════════════════════════════ 2 · AUDIO FX ═══════════════════════════════ */

class SoundFX {
  constructor() { this.ctx = null; this.enabled = true; }
  _ctx() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  _blip(type, f0, f1, dur, vol) {
    const ctx = this._ctx();
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + dur);
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  }
  click() { this._blip('sine', 1400, 320, 0.04, 0.06); }
  latch() { this._blip('triangle', 520, 90, 0.11, 0.14); this._blip('square', 2600, 1800, 0.02, 0.02); }
  servo() { this._blip('sawtooth', 880, 1120, 0.03, 0.012); }
  whoosh() { this._blip('sine', 180, 60, 0.35, 0.05); }
  cannonFire() {
    const ctx = this._ctx();
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    // 1. Sub-bass boom
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(26, now + 1.3);
    oscGain.gain.setValueAtTime(0.85, now);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
    osc.connect(oscGain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 1.35);

    // 2. High-energy muzzle blast filtered noise
    const bufLen = Math.floor(ctx.sampleRate * 1.2);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.22));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, now);
    filter.frequency.exponentialRampToValueAtTime(120, now + 1.3);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.8, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
    noise.connect(filter).connect(noiseGain).connect(ctx.destination);
    noise.start(now);

    // 3. Shockwave crack
    this._blip('sawtooth', 3600, 160, 0.09, 0.35);
  }
  airburst() {
    const ctx = this._ctx();
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 0.9);
    oscGain.gain.setValueAtTime(0.7, now);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    osc.connect(oscGain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.95);

    const bufLen = Math.floor(ctx.sampleRate * 0.9);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.16));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(900, now);
    filter.Q.value = 2.0;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.6, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    noise.connect(filter).connect(noiseGain).connect(ctx.destination);
    noise.start(now);
  }
}

/* ═══════════════════════════ 3 · PROCEDURAL TEXTURES ═══════════════════════════ */

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function toTexture(canvas, { srgb = false, repeat = [1, 1], aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Tileable 1-D noise, blurred `passes` times (circular). */
function noise1D(n, rand, passes = 2) {
  let a = Float32Array.from({ length: n }, () => rand() * 2 - 1);
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) b[i] = (a[(i - 1 + n) % n] + 2 * a[i] + a[(i + 1) % n]) / 4;
    a = b;
  }
  return a;
}

/** Tileable 2-D noise field, box-blurred `passes` times. */
function noise2D(w, h, rand, passes = 2) {
  let a = Float32Array.from({ length: w * h }, () => rand() * 2 - 1);
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) s += a[((y + dy + h) % h) * w + ((x + dx + w) % w)];
        }
        b[y * w + x] = s / 9;
      }
    }
    a = b;
  }
  return a;
}

/** Converts a tileable height field into an OpenGL-convention tangent-space normal map. */
function normalMapFromHeight(w, h, heightAt, strength, texOpts) {
  const hts = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) hts[y * w + x] = heightAt(x, y);
  const [c, ctx] = canvas2d(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = hts[y * w + ((x - 1 + w) % w)];
      const r = hts[y * w + ((x + 1) % w)];
      const up = hts[((y - 1 + h) % h) * w + x]; // canvas row above = higher v (flipY)
      const dn = hts[((y + 1) % h) * w + x];
      const nx = (l - r) * strength;
      const ny = (dn - up) * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const i = (y * w + x) * 4;
      d[i] = (nx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, texOpts);
}

function createSurfaceTextures(aniso) {
  const rand = mulberry32(2026);

  // Circular CNC lathe-turning grooves: height varies along v (the profile / axial
  // direction), so ridges run around the circumference of every revolved part.
  const LH = 512, LW = 32;
  const feed = noise1D(LH, rand, 1);
  const chatter = noise1D(LH, rand, 6);
  const grain = noise2D(LW, LH, rand, 1);
  const lathe = normalMapFromHeight(LW, LH, (x, y) =>
    0.55 * Math.sin((y / LH) * TAU * 16) + 0.35 * feed[y] + 0.5 * chatter[y] + 0.05 * grain[y * LW + x],
  1.6, { repeat: [1, 3], aniso });

  // Diamond knurl (crossed 30° helices → pyramids), 8×8 diamonds per tile.
  const KN = 256, KP = 8;
  const knurl = normalMapFromHeight(KN, KN, (x, y) => {
    const a = ((x + y) / KN) * KP;
    const b = ((x - y) / KN) * KP;
    const ga = Math.abs(a - Math.round(a));
    const gb = Math.abs(b - Math.round(b));
    return Math.min(ga, gb) * 2;
  }, 7, { repeat: [6, 1.65], aniso });

  // Brushed finish: streaks run along u (circumferential).
  const BN = 256;
  const streak = noise1D(BN, rand, 0);
  const streakSoft = noise1D(BN, rand, 3);
  const bgrain = noise2D(BN, BN, rand, 1);
  const brushed = normalMapFromHeight(BN, BN, (x, y) =>
    0.6 * streak[y] + 0.6 * streakSoft[y] + 0.12 * bgrain[y * BN + x],
  1.1, { repeat: [3, 5], aniso });

  // Isotropic micro-texture (bead blast / cast coating orange peel).
  const MN = 256;
  const micro1 = noise2D(MN, MN, rand, 2);
  const micro2 = noise2D(MN, MN, rand, 0);
  const micro = normalMapFromHeight(MN, MN, (x, y) =>
    micro1[y * MN + x] + 0.35 * micro2[y * MN + x], 2.2, { repeat: [5, 5], aniso });

  return { lathe, knurl, brushed, micro };
}

/** Solder-mask PCB artwork with gold pads, vias, traces and silkscreen (+ ORM map). */
function createPCBTextures(seed, aniso) {
  const S = 1024;
  const rng = mulberry32(seed);
  const [c, g] = canvas2d(S, S);
  const [oc, o] = canvas2d(S, S);

  g.fillStyle = '#0b3a24';
  g.fillRect(0, 0, S, S);
  o.fillStyle = 'rgb(0,95,0)'; // roughness ≈ 0.37, dielectric
  o.fillRect(0, 0, S, S);

  // Hatched ground pour under the mask
  g.strokeStyle = 'rgba(46,128,78,0.28)';
  g.lineWidth = 2;
  for (let i = -S; i < S * 2; i += 13) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + S, S); g.stroke();
  }

  const gold = (x, y, w, h) => {
    g.fillStyle = '#d9b04c'; g.fillRect(x, y, w, h);
    o.fillStyle = 'rgb(0,50,255)'; o.fillRect(x, y, w, h);
  };
  const via = (x, y, r) => {
    g.fillStyle = '#d9b04c'; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    o.fillStyle = 'rgb(0,50,255)'; o.beginPath(); o.arc(x, y, r, 0, TAU); o.fill();
    g.fillStyle = '#05140c'; g.beginPath(); g.arc(x, y, r * 0.45, 0, TAU); g.fill();
  };

  // Octilinear copper traces (raised under the mask)
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = 0; i < 90; i++) {
    g.strokeStyle = rng() < 0.5 ? 'rgba(40,132,76,0.95)' : 'rgba(30,110,62,0.95)';
    g.lineWidth = 2 + rng() * 4;
    let x = 120 + rng() * (S - 240);
    let y = 120 + rng() * (S - 240);
    g.beginPath();
    g.moveTo(x, y);
    via(x, y, 5);
    for (let k = 0; k < 4; k++) {
      const len = 30 + rng() * 150;
      const dir = Math.floor(rng() * 8) * (Math.PI / 4);
      x += Math.cos(dir) * len;
      y += Math.sin(dir) * len;
      g.lineTo(x, y);
    }
    g.stroke();
    via(x, y, 5);
  }

  // IC footprints with gold pad rows and silkscreen outlines
  g.font = '600 20px "JetBrains Mono", monospace';
  const refs = ['U1', 'U2', 'U3', 'U7', 'Q4', 'L2', 'Y1', 'U12', 'FL1', 'J3'];
  for (let i = 0; i < 11; i++) {
    const w = 60 + rng() * 80;
    const x = 170 + rng() * (S - 340 - w);
    const y = 170 + rng() * (S - 340 - w);
    const pitch = 11;
    for (let p = x + 8; p < x + w - 8; p += pitch) {
      gold(p, y - 14, 6, 12);
      gold(p, y + w + 2, 6, 12);
    }
    for (let p = y + 8; p < y + w - 8; p += pitch) {
      gold(x - 14, p, 12, 6);
      gold(x + w + 2, p, 12, 6);
    }
    g.strokeStyle = 'rgba(235,240,230,0.85)';
    g.lineWidth = 2;
    g.strokeRect(x - 20, y - 20, w + 40, w + 40);
    g.fillStyle = 'rgba(235,240,230,0.9)';
    g.fillText(refs[i % refs.length], x - 18, y - 26);
  }

  // Passive pads
  for (let i = 0; i < 140; i++) {
    const x = 120 + rng() * (S - 240);
    const y = 120 + rng() * (S - 240);
    if (rng() < 0.5) { gold(x, y, 7, 9); gold(x + 13, y, 7, 9); } else { gold(x, y, 9, 7); gold(x, y + 13, 9, 7); }
  }

  // Board ID + edge plating ring
  g.fillStyle = 'rgba(235,240,230,0.92)';
  g.font = '700 26px "JetBrains Mono", monospace';
  g.fillText(`AVN-${seed % 7}0${seed % 3} REV C`, S * 0.36, S * 0.86);
  g.font = '600 18px "JetBrains Mono", monospace';
  g.fillText('HIGH-G  //  CONFORMAL COAT', S * 0.33, S * 0.9);
  for (const ctx of [g, o]) {
    ctx.strokeStyle = ctx === g ? '#d9b04c' : 'rgb(0,50,255)';
    ctx.lineWidth = 14;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 9, 0, TAU); ctx.stroke();
  }

  return {
    map: toTexture(c, { srgb: true, aniso }),
    orm: toTexture(oc, { aniso }),
  };
}

/**
 * Outer body livery: slate-green aerospace coating, stencils, calibration ruler,
 * chipped edges. UVs use u = angle, v = (y − Y0)/(Y1 − Y0).
 */
const BODY_Y0 = -4.2;
const BODY_Y1 = -1.6;

function createBodyTextures(aniso) {
  const W = 2048, H = 1024;
  const rng = mulberry32(155);
  const [c, g] = canvas2d(W, H);
  const [oc, o] = canvas2d(W, H);
  const row = (y) => (1 - (y - BODY_Y0) / (BODY_Y1 - BODY_Y0)) * H;
  const pxPerUnitU = W / TAU; // circumference at R = 1
  const pxPerUnitV = H / (BODY_Y1 - BODY_Y0);
  const ratio = pxPerUnitU / pxPerUnitV;
  const stencilFont = '"Allerta Stencil", "Arial Narrow", Impact, sans-serif';

  // Base coat + mottling
  g.fillStyle = '#3d4b42';
  g.fillRect(0, 0, W, H);
  o.fillStyle = 'rgb(0,150,0)'; // roughness ≈ 0.59
  o.fillRect(0, 0, W, H);
  for (let i = 0; i < 900; i++) {
    const light = rng() < 0.5;
    g.fillStyle = light ? `rgba(220,235,220,${0.012 + rng() * 0.025})` : `rgba(8,16,10,${0.02 + rng() * 0.04})`;
    g.beginPath();
    g.arc(rng() * W, rng() * H, 10 + rng() * 70, 0, TAU);
    g.fill();
  }
  // Grime toward the shoulder
  const grime = g.createLinearGradient(0, row(-1.6), 0, row(-2.3));
  grime.addColorStop(0, 'rgba(10,12,8,0.28)');
  grime.addColorStop(1, 'rgba(10,12,8,0)');
  g.fillStyle = grime;
  g.fillRect(0, 0, W, row(-2.3));

  // Stencil blocks (text runs along the body axis, toward the nose)
  const fitFont = (text, maxWidth, base) => {
    g.font = `${base}px ${stencilFont}`;
    return Math.min(base, (base * maxWidth) / g.measureText(text).width);
  };
  const drawBlock = (cx) => {
    for (const [ctx, paint] of [[g, '#e6e1d0'], [o, 'rgb(0,118,0)']]) {
      ctx.save();
      ctx.translate(cx, row(-3.42));
      ctx.rotate(-Math.PI / 2);
      ctx.scale(1, ratio);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = paint;
      ctx.strokeStyle = paint;

      const L = 1.05 * pxPerUnitV;
      const f1 = fitFont('FLIGHT PROBE 155', L, 110);
      ctx.font = `${f1}px ${stencilFont}`;
      ctx.fillText('FLIGHT PROBE 155', 0, -44);
      const f2 = fitFont('SER-2026-A // MASS 43.5 KG', L, 60);
      ctx.font = `${f2}px ${stencilFont}`;
      ctx.fillText('SER-2026-A // MASS 43.5 KG', 0, 22);

      // calibration ruler (5 mm minor / 20 mm major)
      const mm = pxPerUnitV / MM_PER_UNIT;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-L / 2, 62); ctx.lineTo(L / 2, 62);
      for (let m = 0; m * mm <= L + 0.5; m += 5) {
        const x = -L / 2 + m * mm;
        const tall = m % 20 === 0;
        ctx.moveTo(x, 62); ctx.lineTo(x, 62 + (tall ? 20 : 10));
      }
      ctx.stroke();
      ctx.font = `600 15px "JetBrains Mono", monospace`;
      for (let m = 0; m * mm <= L + 0.5; m += 20) ctx.fillText(String(m), -L / 2 + m * mm, 96);
      ctx.fillText('CAL mm', L / 2 - 40, 118);

      // forward arrow + datum
      ctx.font = `28px ${stencilFont}`;
      ctx.fillText('FWD ▶', L / 2 - 60, -112);
      ctx.beginPath();
      ctx.arc(-L / 2 + 30, -112, 13, 0, TAU);
      ctx.moveTo(-L / 2 + 12, -112); ctx.lineTo(-L / 2 + 48, -112);
      ctx.moveTo(-L / 2 + 30, -130); ctx.lineTo(-L / 2 + 30, -94);
      ctx.stroke();
      ctx.font = `600 15px "JetBrains Mono", monospace`;
      ctx.fillText('CG DATUM', -L / 2 + 100, -112);
      ctx.restore();
    }
  };
  drawBlock(W * 0.5);
  drawBlock(0);
  drawBlock(W);

  // Index triangles at the interface band
  g.fillStyle = '#e6e1d0';
  for (let k = 0; k < 8; k++) {
    const x = (k / 8) * W;
    const y = row(-2.82);
    g.beginPath(); g.moveTo(x - 9, y + 16); g.lineTo(x + 9, y + 16); g.lineTo(x, y + 2); g.fill();
  }

  // Edge wear: chips reveal bare steel (metallic, smoother)
  const chip = (x, y, r) => {
    const pts = 6 + Math.floor(rng() * 5);
    const path = [];
    for (let i = 0; i < pts; i++) {
      const a = (i / pts) * TAU;
      const rr = r * (0.5 + rng() * 0.7);
      path.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.7]);
    }
    for (const [ctx, fill] of [[g, rng() < 0.3 ? '#6d706b' : '#8d908a'], [o, 'rgb(0,85,255)']]) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      path.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      ctx.fill();
    }
  };
  const edges = [[row(BODY_Y0), -1], [row(-2.8), 1], [row(-2.64), -1], [row(BODY_Y1), 1]];
  for (const [ey, dir] of edges) {
    for (let i = 0; i < 170; i++) {
      const off = Math.abs((rng() + rng() + rng() - 1.5) * 26);
      chip(rng() * W, ey + dir * off, 1.5 + rng() * rng() * 7);
    }
  }
  // Handling scratches
  for (let i = 0; i < 70; i++) {
    const x = rng() * W, y = rng() * H, a = rng() * TAU, len = 20 + rng() * 110;
    for (const [ctx, s] of [[g, 'rgba(160,165,158,0.35)'], [o, 'rgba(0,100,200,0.6)']]) {
      ctx.strokeStyle = s;
      ctx.lineWidth = 0.8 + rng();
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len * 0.4); ctx.stroke();
    }
  }
  // Film grain
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rng() - 0.5) * 9;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  const map = toTexture(c, { srgb: true, aniso });
  const orm = toTexture(oc, { aniso });
  map.wrapT = orm.wrapT = THREE.ClampToEdgeWrapping;
  return { map, orm };
}

function createContactShadowTexture() {
  const [c, g] = canvas2d(512, 512);
  const grad = g.createRadialGradient(256, 256, 0, 256, 256, 256);
  grad.addColorStop(0, 'rgba(0,0,0,0.82)');
  grad.addColorStop(0.35, 'rgba(0,0,0,0.5)');
  grad.addColorStop(0.7, 'rgba(0,0,0,0.14)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function createBackdropTexture() {
  const S = 1024;
  const [c, g] = canvas2d(S, S);
  const grad = g.createRadialGradient(S * 0.5, S * 0.4, 0, S * 0.5, S * 0.45, S * 0.78);
  grad.addColorStop(0, '#0c121e');
  grad.addColorStop(0.42, '#060910');
  grad.addColorStop(1, '#020306');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  // dither to kill gradient banding
  const img = g.getImageData(0, 0, S, S);
  const rng = mulberry32(7);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rng() - 0.5) * 3;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ═══════════════════════════ 4 · STUDIO ENVIRONMENT ═══════════════════════════ */

/**
 * 1024×512 half-float equirectangular HDRI built in memory: warm key softbox,
 * overhead strip, cool fill, cold rim kickers and a cyan horizon bounce.
 * Softboxes are evaluated in gnomonic (tangent-plane) coordinates, so they stay
 * rectangular regardless of latitude.
 */
function createStudioHDRI() {
  const W = 1024, H = 512;
  const data = new Uint16Array(W * H * 4);
  const toHalf = THREE.DataUtils.toHalfFloat;

  const softbox = (dir, hw, hh, soft, color, intensity) => {
    const c = new THREE.Vector3(...dir).normalize();
    const up = Math.abs(c.y) > 0.95 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const t1 = new THREE.Vector3().crossVectors(up, c).normalize();
    const t2 = new THREE.Vector3().crossVectors(c, t1);
    return { c, t1, t2, hw, hh, soft, color, intensity };
  };
  const boxes = [
    softbox([0.55, 0.62, 0.55], 0.42, 0.3, 0.1, [1.0, 0.85, 0.68], 15), // warm key
    softbox([0.05, 1.0, 0.2], 0.95, 0.15, 0.08, [1.0, 0.96, 0.92], 6), // overhead strip
    softbox([-0.75, 0.3, 0.55], 0.45, 0.55, 0.22, [0.82, 0.9, 1.0], 1.8), // cool fill
    softbox([-0.45, 0.22, -0.88], 0.1, 0.85, 0.05, [0.6, 0.78, 1.0], 20), // cold rim kicker
    softbox([0.7, 0.15, -0.7], 0.08, 0.6, 0.05, [0.72, 0.86, 1.0], 8), // secondary kicker
  ];

  const d = new THREE.Vector3();
  let k = 0;
  for (let j = 0; j < H; j++) {
    const lat = ((j + 0.5) / H - 0.5) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W - 0.5) * TAU;
      d.set(cl * Math.cos(lon), sl, cl * Math.sin(lon));
      let r, g, b;
      if (sl >= 0) {
        const t = Math.pow(sl, 0.6);
        r = lerp(0.05, 0.016, t); g = lerp(0.056, 0.019, t); b = lerp(0.068, 0.025, t);
      } else {
        const t = Math.min(1, -sl * 3);
        r = lerp(0.042, 0.012, t); g = lerp(0.04, 0.012, t); b = lerp(0.038, 0.013, t);
      }
      // tactical cyan horizon bounce (stronger behind the subject)
      const hb = Math.exp(-(((lat + 0.02) / 0.05) ** 2)) * (0.55 + 0.45 * Math.max(0, -d.z)) * 1.5;
      r += 0.02 * hb; g += 0.72 * hb; b += 0.88 * hb;

      for (const bx of boxes) {
        const z = d.dot(bx.c);
        if (z <= 0.2) continue;
        const sx = d.dot(bx.t1) / z;
        const sy = d.dot(bx.t2) / z;
        const mx = 1 - smoothstep(bx.hw - bx.soft, bx.hw + bx.soft, Math.abs(sx));
        if (mx <= 0) continue;
        const my = 1 - smoothstep(bx.hh - bx.soft, bx.hh + bx.soft, Math.abs(sy));
        if (my <= 0) continue;
        const hot = 0.8 + 0.2 * (1 - Math.min(1, (sx * sx) / (bx.hw * bx.hw) + (sy * sy) / (bx.hh * bx.hh)));
        const e = bx.intensity * mx * my * hot;
        r += bx.color[0] * e; g += bx.color[1] * e; b += bx.color[2] * e;
      }
      data[k++] = toHalf(r);
      data[k++] = toHalf(g);
      data[k++] = toHalf(b);
      data[k++] = toHalf(1);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* ═══════════════════════════ 5 · GEOMETRY KERNELS ═══════════════════════════ */

/**
 * Watertight solid of revolution around +Y.
 * `profile` is a closed loop of [r, y] points (the closing edge is implicit;
 * edges lying on the axis are skipped). Orientation is normalised to CCW so
 * normals always face outward. Hard edges are split at `crease` degrees, so
 * machined chamfers shade crisply while curved runs stay smooth.
 * Partial sweeps (phiLength < 2π) get triangulated end caps.
 * uv.u = φ / 2π; uv.v = arc length in scene units ('arc') or normalised y ('y').
 */
function revolve(profile, opts = {}) {
  const { segments = 128, phiStart = 0, phiLength = TAU, crease = 38, uvMode = 'arc', yRange = null } = opts;
  const pts = profile.map((p) => new THREE.Vector2(Math.max(0, p[0]), p[1]));
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 0) pts.reverse();

  let ymin = Infinity, ymax = -Infinity;
  for (const p of pts) { ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y); }
  if (yRange) [ymin, ymax] = yRange;

  const segs = [];
  let arc = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = a.distanceTo(b);
    if (len < 1e-7) continue;
    segs.push({
      a, b,
      onAxis: a.x < 1e-6 && b.x < 1e-6,
      n: new THREE.Vector2(b.y - a.y, -(b.x - a.x)).divideScalar(len),
      v0: arc, v1: arc + len,
    });
    arc += len;
  }

  const cosCrease = Math.cos(crease * DEG);
  const positions = [], normals = [], uvs = [], indices = [];
  for (let s = 0; s < segs.length; s++) {
    const S = segs[s];
    if (S.onAxis) continue;
    const P = segs[(s - 1 + segs.length) % segs.length];
    const N = segs[(s + 1) % segs.length];
    const n0 = !P.onAxis && P.n.dot(S.n) > cosCrease ? P.n.clone().add(S.n).normalize() : S.n;
    const n1 = !N.onAxis && N.n.dot(S.n) > cosCrease ? N.n.clone().add(S.n).normalize() : S.n;
    const base = positions.length / 3;
    for (let i = 0; i <= segments; i++) {
      const phi = phiStart + (i / segments) * phiLength;
      const sn = Math.sin(phi), cs = Math.cos(phi);
      for (const [p, nn, v] of [[S.a, n0, S.v0], [S.b, n1, S.v1]]) {
        positions.push(p.x * sn, p.y, p.x * cs);
        normals.push(nn.x * sn, nn.y, nn.x * cs);
        uvs.push(phi / TAU, uvMode === 'y' ? (p.y - ymin) / (ymax - ymin) : v);
      }
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2, b = a + 2, d = a + 1, c = a + 3;
      indices.push(a, b, d, b, c, d);
    }
  }

  if (phiLength < TAU - 1e-6) {
    const tris = THREE.ShapeUtils.triangulateShape(pts, []);
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
    for (const [phi, sign] of [[phiStart, -1], [phiStart + phiLength, 1]]) {
      const sn = Math.sin(phi), cs = Math.cos(phi);
      const nrm = new THREE.Vector3(cs * sign, 0, -sn * sign);
      const base = positions.length / 3;
      for (const p of pts) {
        positions.push(p.x * sn, p.y, p.x * cs);
        normals.push(nrm.x, nrm.y, nrm.z);
        uvs.push(p.x, p.y);
      }
      const P = (i) => new THREE.Vector3(pts[i].x * sn, pts[i].y, pts[i].x * cs);
      for (const t of tris) {
        pa.copy(P(t[0])); pb.copy(P(t[1])); pc.copy(P(t[2]));
        const fn = pb.sub(pa).cross(pc.sub(pa));
        if (fn.dot(nrm) >= 0) indices.push(base + t[0], base + t[1], base + t[2]);
        else indices.push(base + t[0], base + t[2], base + t[1]);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/**
 * True helical 60° thread: r(φ, y) = rMinor + depth · tri((y − p·φ/2π) / p),
 * with thread run-out at both ends, closed by annular caps and an inner wall.
 */
function threadGeometry({ rMinor, depth, pitch, y0, y1, rInner, segments = 160, rowsPerPitch = 12, runout = 0.035 }) {
  const rows = Math.ceil(((y1 - y0) / pitch) * rowsPerPitch);
  const pos = [], uv = [], idx = [];
  const radiusAt = (phi, y) => {
    const f = ((((y - (pitch * phi) / TAU) / pitch) % 1) + 1) % 1;
    const tri = 1 - Math.abs(2 * f - 1);
    const h = clamp((tri - 0.1) / 0.8, 0, 1);
    const fade = smoothstep(y0, y0 + runout, y) * (1 - smoothstep(y1 - runout, y1, y));
    return rMinor + depth * h * fade;
  };
  const push = (r, phi, y) => {
    pos.push(r * Math.sin(phi), y, r * Math.cos(phi));
    uv.push(phi / TAU, y);
  };
  for (let j = 0; j <= rows; j++) {
    const y = y0 + ((y1 - y0) * j) / rows;
    for (let i = 0; i < segments; i++) {
      const phi = (i / segments) * TAU;
      push(radiusAt(phi, y), phi, y);
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < segments; i++) {
      const i1 = (i + 1) % segments;
      const a = j * segments + i, b = j * segments + i1;
      const d = (j + 1) * segments + i, c = (j + 1) * segments + i1;
      idx.push(a, b, d, b, c, d);
    }
  }
  const ring = (y, inner) => {
    const start = pos.length / 3;
    for (let i = 0; i < segments; i++) {
      const phi = (i / segments) * TAU;
      push(inner ? rInner : radiusAt(phi, y), phi, y);
    }
    return start;
  };
  const ob = ring(y0, false), ib = ring(y0, true), ot = ring(y1, false), it = ring(y1, true);
  for (let i = 0; i < segments; i++) {
    const i1 = (i + 1) % segments;
    idx.push(ib + i, ob + i1, ob + i, ib + i, ib + i1, ob + i1); // bottom annulus (−Y)
    idx.push(it + i, ot + i, ot + i1, it + i, ot + i1, it + i1); // top annulus (+Y)
    idx.push(ib + i, it + i, ib + i1, ib + i1, it + i, it + i1); // inner wall (inward)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Supersonic double-wedge (diamond) canard, lofted root → tip.
 * Fin frame: x = span (radial), y = chord (LE at y = 0, TE toward −y), z = thickness.
 * Leading/trailing edges carry a small flat chamfer; faceted normals keep the
 * diamond ridge crisp.
 */
function finGeometry({ span = 0.62, rootChord = 0.32, tipChord = 0.14, sweep = 0.2, tRoot = 0.026, tTip = 0.014, edge = 0.0035 } = {}) {
  const section = (c, t) => [[0, edge], [c * 0.5, t], [c, edge], [c, -edge], [c * 0.5, -t], [0, -edge]];
  const root = section(rootChord, tRoot).map(([cp, th]) => new THREE.Vector3(0, -cp, th));
  const tip = section(tipChord, tTip).map(([cp, th]) => new THREE.Vector3(span, -sweep - cp, th));
  const tris = [];
  const n = root.length;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    tris.push([root[k], root[k1], tip[k1]], [root[k], tip[k1], tip[k]]);
  }
  for (let k = 1; k < n - 1; k++) {
    tris.push([root[0], root[k + 1], root[k]]);
    tris.push([tip[0], tip[k], tip[k + 1]]);
  }
  const volume = tris.reduce((acc, [a, b, c]) => acc + a.dot(b.clone().cross(c)), 0);
  if (volume < 0) tris.forEach((t) => t.reverse()); // guarantee outward winding
  const pos = [], uv = [];
  for (const t of tris) for (const v of t) { pos.push(v.x, v.y, v.z); uv.push(v.x * 2, v.y * 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

/** Coil spring: helix of `turns` around the Y axis, swept with a round wire. */
function helixTube(radius, length, turns, wire, tubular = 180) {
  class Helix extends THREE.Curve {
    getPoint(t, target = new THREE.Vector3()) {
      const a = t * turns * TAU;
      return target.set(Math.cos(a) * radius, (t - 0.5) * length, Math.sin(a) * radius);
    }
  }
  return new THREE.TubeGeometry(new Helix(), tubular, wire, 8, false);
}

/** Collar outline: Ø ring with four parallel-walled fin slots and a centre bore. */
function collarShape({ ro, rb, rh, halfWidth, angles, arcSteps = 20 }) {
  const shape = new THREE.Shape();
  const pts = [];
  const delta = Math.asin(halfWidth / ro);
  for (let k = 0; k < angles.length; k++) {
    const th = angles[k];
    const u = new THREE.Vector2(Math.cos(th), Math.sin(th));
    const nrm = new THREE.Vector2(-Math.sin(th), Math.cos(th));
    const tOut = Math.sqrt(ro * ro - halfWidth * halfWidth);
    const tIn = Math.sqrt(rb * rb - halfWidth * halfWidth);
    const P = (t, s) => u.clone().multiplyScalar(t).add(nrm.clone().multiplyScalar(s * halfWidth));
    pts.push(P(tOut, -1), P(tIn, -1), P(tIn, 1), P(tOut, 1));
    const a0 = th + delta;
    const a1 = angles[(k + 1) % angles.length] + (k === angles.length - 1 ? TAU : 0) - delta;
    for (let i = 1; i < arcSteps; i++) {
      const a = lerp(a0, a1, i / arcSteps);
      pts.push(new THREE.Vector2(Math.cos(a) * ro, Math.sin(a) * ro));
    }
  }
  shape.setFromPoints(pts);
  const hole = new THREE.Path();
  hole.absarc(0, 0, rh, 0, TAU, true);
  shape.holes.push(hole);
  return shape;
}

/* ═══════════════════════════════ 6 · MATERIALS ═══════════════════════════════ */

/**
 * Every opaque solid is DoubleSide + clipped by the section plane. Back faces
 * are only ever visible through a cut, so the patch paints them as a hatched
 * CAD section cap — the classic back-face capping trick, no stencil passes.
 */
function makeSectionable(sectionPlane) {
  const capA = new THREE.Vector3(0.78, 0.29, 0.19);
  const capB = new THREE.Vector3(0.36, 0.1, 0.06);
  return (mat, { cap = true } = {}) => {
    mat.clippingPlanes = [sectionPlane];
    mat.clipShadows = true;
    mat.side = THREE.DoubleSide;
    if (cap) {
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uCapA = { value: capA };
        shader.uniforms.uCapB = { value: capB };
        shader.fragmentShader = 'uniform vec3 uCapA;\nuniform vec3 uCapB;\n' + shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
          if (!gl_FrontFacing) {
            float hatch = step(7.0, mod(gl_FragCoord.x + gl_FragCoord.y, 9.0));
            gl_FragColor = vec4(mix(uCapA, uCapB, hatch), 1.0);
          }`,
        );
      };
      mat.customProgramCacheKey = () => 'section-cap-v1';
    }
    return mat;
  };
}

function createMaterials(tex, sectionPlane) {
  const S = makeSectionable(sectionPlane);
  const P = (o) => new THREE.MeshPhysicalMaterial(o);
  const v2 = (s) => new THREE.Vector2(s, s);

  return {
    // Ti-6Al-4V, lathe-turned: circular micro-grooves + anisotropic highlight
    titanium: S(P({
      color: 0xbdb7ae, metalness: 0.92, roughness: 0.22,
      normalMap: tex.lathe, normalScale: v2(0.32),
      anisotropy: 0.6, anisotropyRotation: Math.PI / 2,
    })),
    titaniumMilled: S(P({ color: 0xb3aea6, metalness: 0.92, roughness: 0.27, normalMap: tex.micro, normalScale: v2(0.12) })),
    titaniumFin: S(P({ color: 0xaaa6a0, metalness: 0.9, roughness: 0.3, normalMap: tex.micro, normalScale: v2(0.18) })),

    coating: S(P({
      map: tex.body.map, roughnessMap: tex.body.orm, metalnessMap: tex.body.orm,
      roughness: 1, metalness: 1,
      normalMap: tex.micro, normalScale: v2(0.08),
      clearcoat: 0.12, clearcoatRoughness: 0.55,
    })),
    bronze: S(P({
      color: 0xc58d52, metalness: 1, roughness: 0.3,
      normalMap: tex.brushed, normalScale: v2(0.35),
      anisotropy: 0.85, anisotropyRotation: 0,
    })),
    steel440: S(P({ color: 0xdcdee1, metalness: 1, roughness: 0.09, normalMap: tex.lathe, normalScale: v2(0.08) })),
    steel4340: S(P({ color: 0x70767d, metalness: 1, roughness: 0.3, normalMap: tex.lathe, normalScale: v2(0.2) })),
    knurl: S(P({ color: 0x8e939a, metalness: 1, roughness: 0.34, normalMap: tex.knurl, normalScale: v2(1.1) })),
    anodized: S(P({ color: 0x23272d, metalness: 0.75, roughness: 0.38, normalMap: tex.micro, normalScale: v2(0.1) })),

    // Si3N4: dielectric (n ≈ 2.0), mirror polish, deep slate reflections
    ceramic: S(P({
      color: 0x1a1e23, metalness: 0, roughness: 0, ior: 2.0, specularIntensity: 1,
      clearcoat: 1, clearcoatRoughness: 0,
    })),

    // Shock-potting polyurethane: transmission with amber volumetric absorption
    resin: S(P({
      color: 0xffd3a0, metalness: 0, roughness: 0.06,
      transmission: 1, ior: 1.52, thickness: 1.1,
      attenuationColor: new THREE.Color(0xd9781c), attenuationDistance: 0.85,
      specularIntensity: 1,
    }), { cap: false }),

    // Synthetic sapphire (n = 1.77) with MgF2-like AR coating → thin-film glints + dispersion
    sapphire: S(P({
      color: 0xeef3ff, metalness: 0, roughness: 0,
      transmission: 1, ior: 1.77, thickness: 0.3,
      attenuationColor: new THREE.Color(0xa9c4ff), attenuationDistance: 1.6,
      iridescence: 0.9, iridescenceIOR: 1.38, iridescenceThicknessRange: [180, 420],
      dispersion: 0.35, specularIntensity: 1,
    }), { cap: false }),

    pcbTopA: S(P({ map: tex.pcbA.map, roughnessMap: tex.pcbA.orm, metalnessMap: tex.pcbA.orm, roughness: 1, metalness: 1, clearcoat: 0.5, clearcoatRoughness: 0.2 })),
    pcbTopB: S(P({ map: tex.pcbB.map, roughnessMap: tex.pcbB.orm, metalnessMap: tex.pcbB.orm, roughness: 1, metalness: 1, clearcoat: 0.5, clearcoatRoughness: 0.2 })),
    pcbEdge: S(P({ color: 0x1b3a27, roughness: 0.5 })),
    icBlack: S(P({ color: 0x131416, roughness: 0.42, clearcoat: 0.25, clearcoatRoughness: 0.4 })),
    ceramicPkg: S(P({ color: 0xe6dfcf, roughness: 0.35 })),
    passive: S(P({ color: 0xa88862, roughness: 0.5 })),
    gold: S(P({ color: 0xf2c667, metalness: 1, roughness: 0.18 })),
    tin: S(P({ color: 0xc9cdd2, metalness: 1, roughness: 0.26, normalMap: tex.micro, normalScale: v2(0.05) })),
    brass: S(P({ color: 0xc9a45a, metalness: 1, roughness: 0.26, normalMap: tex.lathe, normalScale: v2(0.2) })),
    copper: S(P({ color: 0xc9713e, metalness: 1, roughness: 0.3 })),
    motorCan: S(P({ color: 0x2f3338, metalness: 0.9, roughness: 0.24 })),
    rubber: S(P({ color: 0x141618, roughness: 0.75 })),
    ventBlack: S(P({ color: 0x050506, roughness: 0.92 })),
    kapton: S(P({ color: 0xc9731e, roughness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.1 })),
    stainless: S(P({ color: 0xc4c7cb, metalness: 1, roughness: 0.2, normalMap: tex.brushed, normalScale: v2(0.25), anisotropy: 0.6 })),
  };
}

/* ═══════════════════════════════ 7 · ASSEMBLY ═══════════════════════════════ */

const PART_ORDER = ['ogive', 'body', 'canards', 'base', 'avionics', 'bearing', 'power']; // explode stagger (outermost first)
const EXPLODE_OFFSET = { ogive: 2.0, canards: 1.3, avionics: 0.7, power: 0.15, bearing: -0.35, base: -0.95, body: -1.7 };
const ASSEMBLED_RANGE = [BODY_Y0, 3.21]; // local Y extents when assembled

const OGIVE = (() => {
  const y0 = 1.55, R = 0.58, L = 1.75;
  const rho = (R * R + L * L) / (2 * R);
  const r = (s) => Math.sqrt(rho * rho - s * s) + R - rho;
  const tipR = 0.16;
  const sTop = Math.sqrt(rho * rho - (tipR - R + rho) ** 2);
  return { y0, R, rho, r, sTop, yTop: y0 + sTop, domeR: 0.15 };
})();

const SHOULDER = { y0: -2.6, R: 1.0, rho: 1.45, len: 1.0 };
const shoulderR = (s) => Math.sqrt(SHOULDER.rho ** 2 - s * s) + SHOULDER.R - SHOULDER.rho;

/** Outer skin radius of the assembled vehicle at local y (used by the flow solver). */
function outerRadiusAt(y) {
  const { y0, r, sTop, yTop, domeR } = OGIVE;
  if (y > yTop + domeR) return 0;
  if (y > yTop) return Math.sqrt(Math.max(0, domeR * domeR - (y - yTop) ** 2));
  if (y > y0) return r(Math.min(y - y0, sTop));
  if (y > -1.6) return 0.58;
  if (y > SHOULDER.y0) return shoulderR(y - SHOULDER.y0);
  return 1.0;
}

const SUBSYSTEMS = {
  ogive: {
    category: 'FORWARD STRUCTURE',
    title: 'Aerodynamic ogive cowling & sapphire dome',
    desc: 'Tangent-ogive nose cowl machined from Ti-6Al-4V. Six radial ram-air intake vents feed the power module turbine. A hemispherical synthetic sapphire dome sits on a polished seat ring and covers the multi-mode proximity radar sensor window.',
    material: 'Ti-6Al-4V cowl · Al₂O₃ sapphire dome',
    finish: 'CNC lathe-turned, Ra ≈ 0.4 µm · AR-coated dome',
    param: 'Dome IOR 1.77 · 6 intake vents',
    fn: 'Aerodynamic fairing, sensor aperture',
    notes: 'Cowl uses an anisotropic PBR shader with a procedural lathe-groove normal map. The dome is a transmission shader (IOR 1.77) with thin-film iridescence and dispersion, which give the blue/violet glints at grazing angles.',
  },
  canards: {
    category: 'FLIGHT CONTROL',
    title: 'Canard actuation assembly (CAA)',
    desc: 'Titanium collar with four recessed fuselage slots. Each double-wedge diamond canard folds flush into its slot and deploys on a spring-loaded hinge pivot. Micro-brushless drive shafts give ±7.5° of pitch about the radial axis.',
    material: 'Ti-6Al-4V collar & fins · 440C hinge pins',
    finish: 'Milled collar · bead-blasted fins, chamfered LE/TE',
    param: '4 fins · ±7.5° deflection',
    fn: 'Trajectory correction control surfaces',
    notes: 'Fin geometry is a faceted loft of a diamond airfoil section, root to tip. Deployment is simulated with an under-damped torsion spring that hits a hard latch stop, so each fin rebounds slightly when it deploys.',
  },
  avionics: {
    category: 'GUIDANCE ELECTRONICS',
    title: 'Shock-encapsulated avionics core',
    desc: 'Three tiered circular PCBs on brass standoffs, fully potted in translucent amber polyurethane. The middle board carries a 6-axis high-g MEMS inertial package directly beneath the RF-shielded satellite receiver can on the top board.',
    material: 'Polyurethane potting · FR-4 PCBs · ENIG pads',
    finish: 'Vacuum-cast resin, conformal-coated boards',
    param: 'Resin IOR 1.52 · 3 boards',
    fn: 'Navigation sensing & computation',
    notes: 'The resin is a MeshPhysicalMaterial with transmission, IOR 1.52 and amber attenuation (internal absorption), so the boards stay visible through the potting and refract naturally.',
  },
  power: {
    category: 'ENERGY',
    title: 'Solid-state power generation module',
    desc: 'Setback-activated reserve battery in an anodized mid-chassis, topped by an 8-blade ram-air turbine impeller behind eight intake slits. The turbine spins up whenever supersonic flow mode is active.',
    material: 'Stainless battery can · Ti impeller · 6061 anodized sleeve',
    finish: 'Type III hard anodize · polished blades',
    param: '8 blades · 8 intake slits',
    fn: 'On-board electrical power',
    notes: 'The intake ring is built from partial revolve sweeps with triangulated end caps, so each slit is a real opening that shows the impeller behind it.',
  },
  bearing: {
    category: 'ROLL DECOUPLING',
    title: 'Ceramic thrust bearing assembly',
    desc: 'Dual-race bearing with polished silicon nitride (Si₃N₄) spheres running in 440C stainless raceways, sealed by dual labyrinth seals. It mechanically isolates the 250 Hz aft-body roll from the stabilized forward guidance section.',
    material: 'Si₃N₄ balls · 440C races · elastomer seals',
    finish: 'Grade 5 balls · lapped raceways',
    param: '14 balls · 250 Hz isolation',
    fn: 'Roll isolation of the forward section',
    notes: 'The balls use a dielectric shader (IOR 2.0, zero roughness, clearcoat) for the deep dark-slate mirror finish. In roll-decoupling mode the inner race spins with the body and the ball set orbits at about 0.42× shaft speed.',
  },
  base: {
    category: 'VEHICLE INTERFACE',
    title: 'Threaded base interface',
    desc: 'Precision-machined 2-inch alloy steel male collar with a true helical thread, relief groove and knurled manual setting collar. Inside the bore is a multi-stage mechanical safety lock: two brass stage discs, three lock pins, a centre post with a compression spring, and detent balls.',
    material: 'AISI 4340 alloy steel · brass lock stages',
    finish: 'Rolled thread · diamond knurl',
    param: '2 in. thread · 2 lock stages',
    fn: 'Mechanical attachment & safety interlock',
    notes: 'The thread is a helicoid surface, not stacked rings: r(φ, y) follows a truncated triangle wave in y − p·φ/2π, with run-out at both ends. The setting collar uses a procedural diamond-knurl normal map.',
  },
  body: {
    category: 'HOST AIRFRAME',
    title: 'Flight vehicle outer body',
    desc: 'Forward section of the host body in an industrial slate-green aerospace coating with calibration stencils, edge wear and a brushed-bronze interface band. The body carries the 250 Hz roll that the bearing isolates.',
    material: 'Steel body · polyurethane aerospace coating',
    finish: 'Matte slate green · stencilled markings',
    param: 'Ø155 mm · 43.5 kg',
    fn: 'Host airframe (context)',
    notes: 'The livery is procedural. Stencils, calibration ruler and chipped paint are drawn to a canvas, with a matching roughness/metalness map so chips show as bare metal.',
  },
};

function buildAssembly(M) {
  const assembly = new THREE.Group();
  assembly.name = 'FP155_Canard_Steering_Assembly';
  assembly.rotation.z = -Math.PI / 2; // local +Y (nose) → world +X

  const groups = {};
  for (const key of Object.keys(EXPLODE_OFFSET)) {
    const g = new THREE.Group();
    g.name = `SUB_${key}`;
    g.userData.part = key;
    groups[key] = g;
    assembly.add(g);
  }

  const mk = (parent, part, geo, mat, name, pos, rot) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.part = part;
    if (pos) m.position.set(pos[0], pos[1], pos[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    parent.add(m);
    return m;
  };
  const cyl = (r, h, seg = 48) => new THREE.CylinderGeometry(r, r, h, seg);

  /* ── Outer body ─────────────────────────────────────────────── */
  {
    const g = groups.body;
    const prof = [[0, BODY_Y0], [0.975, BODY_Y0], [1.0, BODY_Y0 + 0.025], [1.0, SHOULDER.y0]];
    for (let i = 1; i <= 18; i++) {
      const s = (i / 18) * SHOULDER.len;
      prof.push([shoulderR(s), SHOULDER.y0 + s]);
    }
    prof.push([0.37, -1.6], [0.36, -1.61], [0.36, -2.2], [0, -2.2]);
    const body = mk(g, 'body', revolve(prof, { segments: 160, uvMode: 'y', yRange: [BODY_Y0, BODY_Y1] }), M.coating, 'outer_body_coated');
    body.rotation.y = Math.PI; // livery seam to the back
    mk(g, 'body', revolve([[0.99, -2.8], [1.007, -2.8], [1.012, -2.795], [1.012, -2.645], [1.007, -2.64], [0.99, -2.64]], { segments: 160 }), M.bronze, 'bronze_interface_band');
  }

  /* ── Threaded base interface + safety lock ─────────────────── */
  {
    const g = groups.base;
    mk(g, 'base', threadGeometry({ rMinor: 0.295, depth: 0.04, pitch: 0.055, y0: -2.13, y1: -1.74, rInner: 0.283 }), M.steel4340, 'thread_2in_helical');
    mk(g, 'base', revolve([
      [0.2, -2.15], [0.285, -2.15], [0.293, -2.142], [0.293, -1.72], [0.272, -1.7],
      [0.272, -1.645], [0.3, -1.615], [0.3, -1.6], [0.2, -1.6],
    ]), M.steel4340, 'thread_core_relief_groove');
    mk(g, 'base', revolve([[0.2, -1.6], [0.55, -1.6], [0.57, -1.585], [0.57, -1.435], [0.55, -1.42], [0.2, -1.42]]), M.steel4340, 'setting_collar_body');
    mk(g, 'base', revolve([[0.56, -1.575], [0.578, -1.572], [0.578, -1.448], [0.56, -1.445]], { segments: 192 }), M.knurl, 'setting_collar_knurl');

    // Multi-stage mechanical safety lock (inside the bore)
    mk(g, 'base', cyl(0.03, 0.66, 24), M.steel440, 'lock_centre_post', [0, -1.79, 0]);
    mk(g, 'base', revolve([[0.035, -2.105], [0.185, -2.105], [0.185, -2.055], [0.035, -2.055]], { segments: 64 }), M.brass, 'lock_stage1_disc');
    mk(g, 'base', revolve([[0.035, -1.59], [0.185, -1.59], [0.185, -1.53], [0.035, -1.53]], { segments: 64, phiStart: 0.35, phiLength: TAU - 0.7 }), M.brass, 'lock_stage2_rotor');
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU + 0.5;
      mk(g, 'base', cyl(0.019, 0.46, 16), M.steel440, `lock_pin_${k + 1}`, [Math.sin(a) * 0.12, -1.82, Math.cos(a) * 0.12]);
      mk(g, 'base', new THREE.SphereGeometry(0.022, 20, 14), M.steel440, `detent_ball_${k + 1}`, [Math.sin(a + 1) * 0.12, -1.508, Math.cos(a + 1) * 0.12]);
    }
    mk(g, 'base', helixTube(0.062, 0.4, 7, 0.008), M.steel440, 'lock_compression_spring', [0, -1.83, 0]);
  }

  /* ── Ceramic roll-decoupling bearing ──────────────────────── */
  const bearingInner = new THREE.Group();
  const ballCarrier = new THREE.Group();
  {
    const g = groups.bearing;
    g.add(bearingInner, ballCarrier);
    const yc = -1.26, rb = 0.4, gr = 0.058;
    const arc = (from, to, steps = 14) => {
      const out = [];
      for (let i = 0; i <= steps; i++) {
        const a = lerp(from, to, i / steps) * DEG;
        out.push([rb + gr * Math.cos(a), yc + gr * Math.sin(a)]);
      }
      return out;
    };
    const inner = [[0.2, -1.4], [0.365, -1.4], [0.365, -1.3044], ...arc(230, 130), [0.365, -1.12], [0.2, -1.12]];
    mk(bearingInner, 'bearing', revolve(inner, { segments: 128, crease: 30 }), M.steel440, 'inner_race_440C');
    const outer = [[0.437, -1.4], [0.58, -1.4], [0.58, -1.12], [0.437, -1.12], ...arc(50, -50)];
    mk(g, 'bearing', revolve(outer, { segments: 128, crease: 30 }), M.steel440, 'outer_race_440C');

    const ballGeo = new THREE.SphereGeometry(0.055, 40, 28);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      mk(ballCarrier, 'bearing', ballGeo, M.ceramic, `si3n4_ball_${i + 1}`, [Math.sin(a) * rb, yc, Math.cos(a) * rb]);
    }
    for (const y of [-1.195, -1.34]) {
      mk(ballCarrier, 'bearing', revolve([[0.388, y], [0.412, y], [0.412, y + 0.015], [0.388, y + 0.015]], { segments: 96 }), M.brass, 'ball_cage_ring');
    }

    // Dual labyrinth seals (inner lip + outer lip interleave)
    const mirror = (pts) => pts.map(([r, y]) => [r, -2.52 - y]);
    const lipA = [[0.365, -1.4], [0.425, -1.4], [0.425, -1.39], [0.39, -1.39], [0.39, -1.372], [0.365, -1.372]];
    const lipB = [[0.4, -1.386], [0.437, -1.386], [0.437, -1.368], [0.4, -1.368]];
    mk(bearingInner, 'bearing', revolve(lipA, { segments: 96 }), M.rubber, 'labyrinth_seal_aft_inner');
    mk(g, 'bearing', revolve(lipB, { segments: 96 }), M.anodized, 'labyrinth_seal_aft_outer');
    mk(bearingInner, 'bearing', revolve(mirror(lipA), { segments: 96 }), M.rubber, 'labyrinth_seal_fwd_inner');
    mk(g, 'bearing', revolve(mirror(lipB), { segments: 96 }), M.anodized, 'labyrinth_seal_fwd_outer');
  }

  /* ── Power generation module ──────────────────────────────── */
  const impeller = new THREE.Group();
  {
    const g = groups.power;
    mk(g, 'power', revolve([[0.5, -1.12], [0.575, -1.12], [0.58, -1.115], [0.58, -0.625], [0.575, -0.62], [0.5, -0.62]]), M.anodized, 'power_chassis_sleeve');
    mk(g, 'power', revolve([[0, -1.12], [0.5, -1.12], [0.5, -1.095], [0, -1.095]], { segments: 96 }), M.anodized, 'power_floor_deck');
    mk(g, 'power', revolve([[0, -1.09], [0.43, -1.09], [0.45, -1.07], [0.45, -0.73], [0.43, -0.71], [0.05, -0.71], [0.05, -0.69], [0, -0.69]], { segments: 128 }), M.stainless, 'reserve_battery_can');
    mk(g, 'power', revolve([[0.44, -0.98], [0.453, -0.98], [0.453, -0.84], [0.44, -0.84]], { segments: 128 }), M.kapton, 'battery_insulation_band');
    for (let k = 0; k < 2; k++) mk(g, 'power', cyl(0.018, 0.05, 16), M.gold, `battery_terminal_${k + 1}`, [k ? 0.16 : -0.16, -0.69, 0]);
    mk(g, 'power', revolve([[0.12, -0.665], [0.5, -0.665], [0.5, -0.625], [0.12, -0.625]], { segments: 96 }), M.anodized, 'turbine_stator_plate');

    const slits = 8, gap = 0.16;
    for (let k = 0; k < slits; k++) {
      mk(g, 'power', revolve([[0.5, -0.625], [0.58, -0.625], [0.58, -0.37], [0.5, -0.37]], {
        segments: 18, phiStart: (k / slits) * TAU + gap / 2, phiLength: TAU / slits - gap,
      }), M.titanium, `intake_ring_segment_${k + 1}`);
    }
    mk(g, 'power', revolve([[0, -0.37], [0.575, -0.37], [0.58, -0.365], [0.58, -0.35], [0, -0.35]]), M.anodized, 'turbine_top_deck');

    g.add(impeller);
    impeller.position.y = -0.5;
    mk(impeller, 'power', revolve([[0, -0.1], [0.12, -0.1], [0.12, 0.07], [0.06, 0.1], [0, 0.1]], { segments: 64 }), M.titanium, 'impeller_hub');
    const bladeGeo = new THREE.BoxGeometry(0.34, 0.17, 0.014);
    for (let k = 0; k < 8; k++) {
      const holder = new THREE.Group();
      holder.rotation.y = (k / 8) * TAU;
      impeller.add(holder);
      mk(holder, 'power', bladeGeo, M.steel440, `impeller_blade_${k + 1}`, [0.29, 0, 0], [0.62, 0, 0]);
    }
  }

  /* ── Shock-encapsulated avionics core ─────────────────────── */
  {
    const g = groups.avionics;
    mk(g, 'avionics', revolve([[0.3, -0.35], [0.58, -0.35], [0.58, -0.325], [0.3, -0.325]]), M.titanium, 'potting_ring_aft');
    mk(g, 'avionics', revolve([[0.3, 0.725], [0.58, 0.725], [0.58, 0.75], [0.3, 0.75]]), M.titanium, 'potting_ring_fwd');
    const resin = mk(g, 'avionics', revolve([[0, -0.325], [0.572, -0.325], [0.572, 0.725], [0, 0.725]], { segments: 128 }), M.resin, 'polyurethane_potting');
    resin.castShadow = false;

    const rng = mulberry32(42);
    const boards = [
      { y: -0.12, r: 0.5, top: M.pcbTopA, centre: null },
      { y: 0.17, r: 0.46, top: M.pcbTopB, centre: 'imu' },
      { y: 0.45, r: 0.42, top: M.pcbTopA, centre: 'rf' },
    ];
    const postAngles = [45, 135, 225, 315].map((a) => a * DEG);
    for (const post of postAngles) {
      mk(g, 'avionics', cyl(0.022, 0.92, 6), M.brass, 'hex_standoff', [Math.cos(post) * 0.33, 0.16, Math.sin(post) * 0.33]);
    }
    boards.forEach((b, bi) => {
      const T = 0.028;
      mk(g, 'avionics', cyl(b.r, T, 128), [M.pcbEdge, b.top, M.pcbEdge], `pcb_tier_${bi + 1}`, [0, b.y, 0]);
      const topY = b.y + T / 2;
      const pinGeos = [], passiveGeos = [];
      const placed = [];
      const free = (x, z, rad) =>
        Math.hypot(x, z) + rad < b.r - 0.04 &&
        (b.centre ? Math.hypot(x, z) > 0.17 + rad : true) &&
        postAngles.every((a) => Math.hypot(x - Math.cos(a) * 0.33, z - Math.sin(a) * 0.33) > rad + 0.04) &&
        placed.every((p) => Math.hypot(x - p[0], z - p[1]) > rad + p[2] + 0.015);

      for (let n = 0, tries = 0; n < 5 && tries < 200; tries++) {
        const s = 0.06 + rng() * 0.07;
        const rad = s * 0.75;
        const x = (rng() * 2 - 1) * b.r, z = (rng() * 2 - 1) * b.r;
        if (!free(x, z, rad)) continue;
        placed.push([x, z, rad]);
        n++;
        mk(g, 'avionics', new RoundedBoxGeometry(s, 0.018, s, 2, 0.003), M.icBlack, `ic_${bi + 1}_${n}`, [x, topY + 0.009, z]);
        const count = Math.max(3, Math.floor(s / 0.016));
        for (let p = 0; p < count; p++) {
          const off = -s / 2 + (s * (p + 0.5)) / count;
          for (const side of [-1, 1]) {
            pinGeos.push(new THREE.BoxGeometry(0.005, 0.006, 0.016).translate(x + off, topY + 0.003, z + side * (s / 2 + 0.006)));
          }
        }
      }
      for (let n = 0, tries = 0; n < 26 && tries < 400; tries++) {
        const x = (rng() * 2 - 1) * b.r, z = (rng() * 2 - 1) * b.r;
        if (!free(x, z, 0.015)) continue;
        placed.push([x, z, 0.012]);
        n++;
        const rot = rng() < 0.5;
        passiveGeos.push(new THREE.BoxGeometry(rot ? 0.024 : 0.012, 0.01, rot ? 0.012 : 0.024).translate(x, topY + 0.005, z));
      }
      if (pinGeos.length) mk(g, 'avionics', mergeGeometries(pinGeos), M.gold, `ic_leads_${bi + 1}`);
      if (passiveGeos.length) mk(g, 'avionics', mergeGeometries(passiveGeos), M.passive, `passives_${bi + 1}`);

      if (b.centre === 'imu') {
        mk(g, 'avionics', new RoundedBoxGeometry(0.13, 0.034, 0.13, 2, 0.006), M.ceramicPkg, 'mems_imu_6axis_package', [0, topY + 0.017, 0]);
        mk(g, 'avionics', new RoundedBoxGeometry(0.1, 0.006, 0.1, 2, 0.002), M.gold, 'mems_imu_lid', [0, topY + 0.036, 0]);
      }
      if (b.centre === 'rf') {
        mk(g, 'avionics', new RoundedBoxGeometry(0.24, 0.075, 0.24, 3, 0.008), M.tin, 'rf_shield_can_gnss', [0, topY + 0.0375, 0]);
        mk(g, 'avionics', cyl(0.018, 0.02, 20), M.gold, 'ufl_rf_connector', [0.2, topY + 0.01, 0.12]);
      }
    });
  }

  /* ── Canard actuation assembly ───────────────────────────── */
  const fins = [];
  {
    const g = groups.canards;
    const finAngles = [0, 1, 2, 3].map((k) => Math.PI / 4 + (k * Math.PI) / 2);
    const collarGeo = new THREE.ExtrudeGeometry(
      collarShape({ ro: 0.568, rb: 0.22, rh: 0.12, halfWidth: 0.05, angles: finAngles }),
      { depth: 0.75, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 3, curveSegments: 48 },
    );
    collarGeo.rotateX(-Math.PI / 2);
    collarGeo.translate(0, 0.762, 0);
    mk(g, 'canards', collarGeo, M.titaniumMilled, 'caa_titanium_collar');
    mk(g, 'canards', revolve([[0, 1.524], [0.575, 1.524], [0.58, 1.529], [0.58, 1.55], [0, 1.55]]), M.titanium, 'caa_retaining_ring');

    const pivotR = 0.555, pivotY = 1.44;
    const finGeo = finGeometry();
    const linerWall = new THREE.BoxGeometry(0.34, 0.75, 0.003);
    const linerFloor = new THREE.BoxGeometry(0.003, 0.75, 0.073);
    const pinGeo = cyl(0.009, 0.085, 16).rotateX(Math.PI / 2);
    const springGeo = helixTube(0.017, 0.06, 5, 0.0035).rotateX(Math.PI / 2);

    finAngles.forEach((theta, k) => {
      const arm = new THREE.Group();
      arm.rotation.y = theta;
      g.add(arm);
      // dark slot liners (fake ambient occlusion inside the recess)
      for (const zs of [-1, 1]) mk(arm, 'canards', linerWall, M.anodized, `slot_liner_${k + 1}`, [0.385, 1.137, zs * 0.0365]);
      mk(arm, 'canards', linerFloor, M.anodized, `slot_floor_${k + 1}`, [0.214, 1.137, 0]);
      // micro-brushless motor (radial) inside the collar core
      mk(arm, 'canards', cyl(0.045, 0.13, 32).rotateZ(Math.PI / 2), M.motorCan, `bldc_motor_${k + 1}`, [0.14, pivotY, 0]);
      mk(arm, 'canards', cyl(0.047, 0.03, 32).rotateZ(Math.PI / 2), M.copper, `bldc_winding_${k + 1}`, [0.1, pivotY, 0]);

      const pivot = new THREE.Group();
      pivot.position.set(pivotR, pivotY, 0);
      arm.add(pivot);
      const pitch = new THREE.Group();
      pivot.add(pitch);
      mk(pitch, 'canards', cyl(0.016, 0.35, 20).rotateZ(Math.PI / 2), M.steel440, `drive_shaft_${k + 1}`, [-0.175, 0, 0]);
      mk(pitch, 'canards', new RoundedBoxGeometry(0.05, 0.05, 0.078, 2, 0.006), M.steel440, `hinge_clevis_${k + 1}`, [-0.02, 0, 0]);
      mk(pitch, 'canards', pinGeo, M.steel440, `hinge_pin_${k + 1}`);
      mk(pitch, 'canards', springGeo, M.steel440, `torsion_spring_${k + 1}`);
      const fold = new THREE.Group();
      pitch.add(fold);
      const fin = mk(fold, 'canards', finGeo, M.titaniumFin, `canard_fin_${k + 1}`);
      fin.position.x = -0.005;
      fins.push({ pitch, fold, angle: -Math.PI / 2, vel: 0, delta: 0, releaseAt: 0, latched: false });
      fold.rotation.z = -Math.PI / 2; // start stowed
    });
  }

  /* ── Ogive cowling + sapphire dome ───────────────────────── */
  {
    const g = groups.ogive;
    const { y0, r, sTop, yTop, domeR } = OGIVE;
    const prof = [[0.535, y0], [0.58, y0]];
    for (let i = 1; i <= 44; i++) {
      const s = (i / 44) * sTop;
      prof.push([r(s), y0 + s]);
    }
    prof.push([0.135, yTop], [0.135, yTop - 0.03]);
    for (let i = 42; i >= 1; i--) {
      const s = ((i / 44) * sTop);
      if (s > sTop - 0.06) continue;
      prof.push([Math.max(r(s) - 0.045, 0.135), y0 + s]);
    }
    mk(g, 'ogive', revolve(prof, { segments: 160, crease: 30 }), M.titanium, 'ogive_cowl_Ti6Al4V');

    const dome = [[0, yTop - 0.004], [domeR, yTop - 0.004]];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * (Math.PI / 2);
      dome.push([domeR * Math.cos(a), yTop + domeR * Math.sin(a)]);
    }
    const domeMesh = mk(g, 'ogive', revolve(dome, { segments: 96 }), M.sapphire, 'sapphire_sensor_dome');
    domeMesh.castShadow = false;

    // Proximity radar sensor window stack under the dome
    mk(g, 'ogive', cyl(0.11, 0.012, 64), M.pcbEdge, 'radar_board', [0, yTop - 0.05, 0]);
    mk(g, 'ogive', cyl(0.085, 0.006, 64), M.gold, 'radar_patch_antenna', [0, yTop - 0.04, 0]);
    mk(g, 'ogive', new RoundedBoxGeometry(0.05, 0.016, 0.05, 2, 0.003), M.icBlack, 'radar_mmic', [0, yTop - 0.029, 0]);

    // Six radial ram-air intake vents, tangent to the ogive surface
    const sV = 0.55;
    const tilt = Math.atan(sV / Math.sqrt(OGIVE.rho ** 2 - sV * sV)); // surface normal leans toward the nose
    const rounded = (w, h, rad) => {
      const s = new THREE.Shape();
      const x = -w / 2, y = -h / 2;
      s.moveTo(x + rad, y);
      s.lineTo(x + w - rad, y); s.quadraticCurveTo(x + w, y, x + w, y + rad);
      s.lineTo(x + w, y + h - rad); s.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
      s.lineTo(x + rad, y + h); s.quadraticCurveTo(x, y + h, x, y + h - rad);
      s.lineTo(x, y + rad); s.quadraticCurveTo(x, y, x + rad, y);
      return s;
    };
    const lipShape = rounded(0.086, 0.23, 0.035);
    const holeShape = rounded(0.058, 0.2, 0.026);
    lipShape.holes.push(new THREE.Path(holeShape.getPoints(8).reverse()));
    const lipGeo = new THREE.ExtrudeGeometry(lipShape, { depth: 0.008, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2 });
    const slotGeo = new THREE.ExtrudeGeometry(holeShape, { depth: 0.012, bevelEnabled: false });
    for (let k = 0; k < 6; k++) {
      const holder = new THREE.Group();
      holder.rotation.y = (k / 6) * TAU;
      g.add(holder);
      const tiltG = new THREE.Group();
      tiltG.position.set(r(sV), y0 + sV, 0);
      tiltG.rotation.z = tilt;
      holder.add(tiltG);
      mk(tiltG, 'ogive', lipGeo, M.titanium, `ram_air_vent_lip_${k + 1}`, [-0.004, 0, 0], [0, Math.PI / 2, 0]);
      mk(tiltG, 'ogive', slotGeo, M.ventBlack, `ram_air_vent_${k + 1}`, [-0.011, 0, 0], [0, Math.PI / 2, 0]);
    }
  }

  return { assembly, groups, fins, bearingInner, ballCarrier, impeller };
}

/* ═══════════════════════════════ 8 · FLOW FX ═══════════════════════════════ */

const SHOCK_BETA = 31 * DEG; // oblique shock half-angle at M 2.2 (Mach angle ≈ 27°)

function shockMaterial(color, strength) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uOpacity, uStrength; uniform vec3 uColor;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        float along = 1.0 - vUv.y;
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
        float bands = 0.55 + 0.45 * sin(along * 70.0 - uTime * 16.0);
        float fade = smoothstep(0.0, 0.04, along) * (1.0 - smoothstep(0.35, 1.0, along));
        float a = (0.04 + 0.6 * fres) * bands * fade * uOpacity * uStrength;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

function buildFlowFX() {
  const group = new THREE.Group();
  group.name = 'flow_fx';
  group.visible = false;

  const H = 7.5;
  const coneGeo = new THREE.ConeGeometry(H * Math.tan(SHOCK_BETA), H, 128, 1, true);
  coneGeo.translate(0, -H / 2, 0);
  coneGeo.rotateZ(-Math.PI / 2); // apex at origin, opening toward −X
  const bowMat = shockMaterial(0x9ff4ff, 1);
  const bow = new THREE.Mesh(coneGeo, bowMat);
  group.add(bow);

  // Secondary oblique shock off the canard leading-edge station
  const Hs = 2.6, r0 = 0.6, beta2 = 38 * DEG;
  const secGeo = new THREE.CylinderGeometry(r0, r0 + Hs * Math.tan(beta2), Hs, 128, 1, true);
  secGeo.translate(0, -Hs / 2, 0);
  secGeo.rotateZ(-Math.PI / 2);
  const secMat = shockMaterial(0x7fd8ff, 0.55);
  const secondary = new THREE.Mesh(secGeo, secMat);
  group.add(secondary);

  // Streamline particles: 2 vertices per streak, drawn as lines + head points
  const N = 1100;
  const pos = new Float32Array(N * 6);
  const col = new Float32Array(N * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const pointMat = new THREE.PointsMaterial({ vertexColors: true, size: 0.028, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const lines = new THREE.LineSegments(geo, lineMat);
  const points = new THREE.Points(geo, pointMat);
  lines.frustumCulled = points.frustumCulled = false;
  group.add(lines, points);

  const rng = mulberry32(99);
  const particles = Array.from({ length: N }, () => ({ x: 0, r0: 0, th: 0, v: 0, fresh: true }));
  const spawn = (p, xMin, xMax, anywhere) => {
    p.x = anywhere ? lerp(xMin, xMax, rng()) : xMax + rng() * 0.6;
    p.r0 = 0.03 + Math.sqrt(rng()) * 2.6;
    p.th = rng() * TAU;
    p.v = 7 + rng() * 4;
    p.fresh = false;
  };

  const preColor = [0.18, 0.55, 0.8];
  const postCold = [0.55, 0.95, 1.0];
  const postHot = [1.0, 0.7, 0.38];

  function update(dt, time, tipX, finX, bodyOffsetX, fade) {
    bowMat.uniforms.uTime.value = time;
    secMat.uniforms.uTime.value = time;
    bowMat.uniforms.uOpacity.value = fade;
    secMat.uniforms.uOpacity.value = fade;
    bow.position.set(tipX, 0, 0);
    secondary.position.set(finX, 0, 0);

    const xMax = tipX + 2.5, xMin = tipX - 11;
    const tanB = Math.tan(SHOCK_BETA);
    const radiusAt = (p, x) => {
      const xs = tipX - p.r0 / tanB;
      const k = smoothstep(0, 0.3, xs - x);
      const R = outerRadiusAt(x - bodyOffsetX);
      return [Math.sqrt(p.r0 * p.r0 + k * R * R * 1.1) + k * 0.015, k, R];
    };
    for (let i = 0; i < N; i++) {
      const p = particles[i];
      if (p.fresh) spawn(p, xMin, xMax, true);
      p.x -= p.v * dt;
      if (p.x < xMin) spawn(p, xMin, xMax, false);
      const tail = p.x + p.v * 0.05;
      const [rh, k, R] = radiusAt(p, p.x);
      const [rt] = radiusAt(p, tail);
      // swirl disturbance in the canard wake
      const nearFin = Math.exp(-(((p.x - (finX - 0.25)) / 0.35) ** 2)) * Math.exp(-(((rh - 0.9) / 0.35) ** 2));
      const th = p.th + nearFin * 0.08 * Math.sin(time * 30 + i);
      const c = Math.cos(th), s = Math.sin(th);
      const o = i * 6;
      pos[o] = p.x; pos[o + 1] = rh * c; pos[o + 2] = rh * s;
      pos[o + 3] = tail; pos[o + 4] = rt * c; pos[o + 5] = rt * s;
      const heat = k * Math.exp(-Math.max(0, rh - R) * 3.2);
      const b = fade * (0.55 + 0.45 * k + nearFin * 0.8);
      for (let j = 0; j < 3; j++) {
        const post = lerp(postCold[j], postHot[j], heat);
        col[o + j] = lerp(preColor[j], post, k) * b;
        col[o + 3 + j] = 0;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  return { group, update };
}

/* ════════════════════ 8.5 · ARTILLERY CANNON & BALLISTICS SIMULATION ════════════════════ */

const MISSION = {
  apogee: 8340, tApogee: 36.0, range: 28500, tof: 71.4, hob: 5.0, // m, s
  cepGuided: 16.8, r95Guided: 26.4, cepUnguided: 114.2, cepSpec: 30, // m
  runs: 100,
};

const DRAG_K = 1.47;
const UNGUIDED_MISS = -140; // m downrange, the single unguided sample drawn on the profile
const DRIFT_EXAG = 12;

function flightPoint(t) {
  const { range, tof, apogee, tApogee, hob } = MISSION;
  const x = range * (1 - Math.exp(-DRAG_K * t / tof)) / (1 - Math.exp(-DRAG_K));
  const h = t < tApogee
    ? apogee * (1 - ((tApogee - t) / tApogee) ** 2)
    : apogee - (apogee - hob) * ((t - tApogee) / (tof - tApogee)) ** 2;
  const drift = UNGUIDED_MISS * (t / tof) ** 2;
  const atApogee = UNGUIDED_MISS * (tApogee / tof) ** 2;
  const guided = t < tApogee ? drift : atApogee * (1 - smoothstep(tApogee, tof - 3, t));
  return { x, h, drift, guided };
}

const MILESTONES = [
  { t: 0.0, text: 'LAUNCH SHOCK · 16,800 g', at: [1.6, 0.3], align: 'left' },
  { t: 1.2, text: 'ROLL BEARING STABILIZATION', at: [3.4, 1.1], align: 'left' },
  { t: 5.0, text: 'CANARD DEPLOYMENT', at: [5.6, 2.1], align: 'left' },
  { t: 36.0, text: 'APOGEE 8,340 m · GUIDANCE ACTIVATION', at: [19.4, 9.0], align: 'center' },
  { t: 55.0, text: 'TERMINAL STEERING · ±7.5° FIN', at: [23.0, 4.5], align: 'right' },
  { t: 71.4, text: 'TARGET ARRIVAL · HOB 5.0 m', at: [25.0, 2.1], align: 'right' },
];

function buildArtillerySimulation(THREE, tex, sfx) {
  const group = new THREE.Group();
  group.visible = false;

  const steelMat = new THREE.MeshStandardMaterial({
    color: 0x252a32,
    roughness: 0.35,
    metalness: 0.9,
    normalMap: tex?.lathe?.normal || null,
  });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xebf0f8,
    roughness: 0.1,
    metalness: 0.98,
  });
  const oliveMat = new THREE.MeshStandardMaterial({
    color: 0x3d493f,
    roughness: 0.68,
    metalness: 0.22,
  });
  const darkChassisMat = new THREE.MeshStandardMaterial({
    color: 0x12161c,
    roughness: 0.75,
    metalness: 0.45,
  });
  const copperMat = new THREE.MeshStandardMaterial({
    color: 0xc47842,
    roughness: 0.28,
    metalness: 0.92,
  });

  /* ── 1. CANNON CARRIAGE & TURNTABLE ── */
  const carriageGroup = new THREE.Group();
  group.add(carriageGroup);

  const turntable = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.85, 0.4, 32), darkChassisMat);
  turntable.position.y = -0.92;
  turntable.receiveShadow = true;
  carriageGroup.add(turntable);

  const trailGeo = new THREE.BoxGeometry(0.35, 0.4, 5.5);
  const trailL = new THREE.Mesh(trailGeo, oliveMat);
  trailL.position.set(-1.15, -1.0, -2.4);
  trailL.rotation.y = 0.34;
  trailL.rotation.x = 0.08;
  carriageGroup.add(trailL);

  const trailR = new THREE.Mesh(trailGeo, oliveMat);
  trailR.position.set(1.15, -1.0, -2.4);
  trailR.rotation.y = -0.34;
  trailR.rotation.x = 0.08;
  carriageGroup.add(trailR);

  const cheekGeo = new THREE.BoxGeometry(0.38, 1.9, 1.25);
  const cheekL = new THREE.Mesh(cheekGeo, darkChassisMat);
  cheekL.position.set(-0.88, 0.05, 0);
  cheekL.castShadow = true;
  carriageGroup.add(cheekL);

  const cheekR = new THREE.Mesh(cheekGeo, darkChassisMat);
  cheekR.position.set(0.88, 0.05, 0);
  cheekR.castShadow = true;
  carriageGroup.add(cheekR);

  /* ── 2. ELEVATING MASS ── */
  const elevationPivot = new THREE.Group();
  elevationPivot.position.set(0, 0.65, 0);
  carriageGroup.add(elevationPivot);

  const cradle = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.95, 3.2), oliveMat);
  cradle.position.set(0, 0, 0.3);
  cradle.castShadow = true;
  elevationPivot.add(cradle);

  const recoilCylGeo = new THREE.CylinderGeometry(0.12, 0.12, 2.9, 16);
  const recL = new THREE.Mesh(recoilCylGeo, steelMat);
  recL.rotation.x = Math.PI / 2;
  recL.position.set(-0.42, 0.55, 0.3);
  elevationPivot.add(recL);

  const pistonL = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.8, 16), chromeMat);
  pistonL.rotation.x = Math.PI / 2;
  pistonL.position.set(-0.42, 0.55, -0.7);
  elevationPivot.add(pistonL);

  const recR = new THREE.Mesh(recoilCylGeo, steelMat);
  recR.rotation.x = Math.PI / 2;
  recR.position.set(0.42, 0.55, 0.3);
  elevationPivot.add(recR);

  const pistonR = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.8, 16), chromeMat);
  pistonR.rotation.x = Math.PI / 2;
  pistonR.position.set(0.42, 0.55, -0.7);
  elevationPivot.add(pistonR);

  /* ── 3. BARREL RECOIL GROUP ── */
  const barrelRecoilGroup = new THREE.Group();
  elevationPivot.add(barrelRecoilGroup);

  const breech = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.85, 1.4), steelMat);
  breech.position.set(0, 0, -1.2);
  breech.castShadow = true;
  barrelRecoilGroup.add(breech);

  const chamber = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.36, 2.0, 24), steelMat);
  chamber.rotation.x = Math.PI / 2;
  chamber.position.set(0, 0, 0.5);
  chamber.castShadow = true;
  barrelRecoilGroup.add(chamber);

  const midBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.33, 4.2, 24), steelMat);
  midBarrel.rotation.x = Math.PI / 2;
  midBarrel.position.set(0, 0, 3.6);
  midBarrel.castShadow = true;
  barrelRecoilGroup.add(midBarrel);

  const evacuator = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 1.4, 24), oliveMat);
  evacuator.rotation.x = Math.PI / 2;
  evacuator.position.set(0, 0, 4.2);
  evacuator.castShadow = true;
  barrelRecoilGroup.add(evacuator);

  const fwdBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 4.0, 24), steelMat);
  fwdBarrel.rotation.x = Math.PI / 2;
  fwdBarrel.position.set(0, 0, 7.7);
  fwdBarrel.castShadow = true;
  barrelRecoilGroup.add(fwdBarrel);

  const brakeGroup = new THREE.Group();
  brakeGroup.position.set(0, 0, 10.0);
  barrelRecoilGroup.add(brakeGroup);

  const brakeBody = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.52, 1.15), steelMat);
  brakeBody.castShadow = true;
  brakeGroup.add(brakeBody);

  const baffleGeo = new THREE.BoxGeometry(0.12, 0.44, 0.38);
  const bafL1 = new THREE.Mesh(baffleGeo, steelMat);
  bafL1.position.set(-0.36, 0, -0.22);
  bafL1.rotation.y = -0.45;
  brakeGroup.add(bafL1);

  const bafR1 = new THREE.Mesh(baffleGeo, steelMat);
  bafR1.position.set(0.36, 0, -0.22);
  bafR1.rotation.y = 0.45;
  brakeGroup.add(bafR1);

  const bafL2 = new THREE.Mesh(baffleGeo, steelMat);
  bafL2.position.set(-0.36, 0, 0.25);
  bafL2.rotation.y = -0.45;
  brakeGroup.add(bafL2);

  const bafR2 = new THREE.Mesh(baffleGeo, steelMat);
  bafR2.position.set(0.36, 0, 0.25);
  bafR2.rotation.y = 0.45;
  brakeGroup.add(bafR2);

  const MUZZLE_TIP_Z = 10.65;

  /* ── 4. MUZZLE BLAST & SHOCKWAVE VFX ── */
  const flashGroup = new THREE.Group();
  flashGroup.position.set(0, 0, MUZZLE_TIP_Z);
  barrelRecoilGroup.add(flashGroup);
  flashGroup.visible = false;

  const flashLight = new THREE.PointLight(0xff7711, 0, 35);
  flashGroup.add(flashLight);

  const flashCoreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
  const flashOuterMat = new THREE.MeshBasicMaterial({ color: 0xff4500, transparent: true, opacity: 0.85 });
  const jetMat = new THREE.MeshBasicMaterial({ color: 0xffaa22, transparent: true, opacity: 0.9 });

  const flashCore = new THREE.Mesh(new THREE.SphereGeometry(0.65, 16, 16), flashCoreMat);
  flashGroup.add(flashCore);

  const flashOuter = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 16), flashOuterMat);
  flashGroup.add(flashOuter);

  const jetL = new THREE.Mesh(new THREE.ConeGeometry(0.6, 2.2, 12), jetMat);
  jetL.rotation.z = Math.PI / 2;
  jetL.rotation.y = -0.45;
  jetL.position.set(-1.3, 0, -0.2);
  flashGroup.add(jetL);

  const jetR = new THREE.Mesh(new THREE.ConeGeometry(0.6, 2.2, 12), jetMat);
  jetR.rotation.z = -Math.PI / 2;
  jetR.rotation.y = 0.45;
  jetR.position.set(1.3, 0, -0.2);
  flashGroup.add(jetR);

  const blastRingGeo = new THREE.RingGeometry(0.5, 1.2, 32);
  const blastRingMat = new THREE.MeshBasicMaterial({
    color: 0xc4b296,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const blastRing = new THREE.Mesh(blastRingGeo, blastRingMat);
  blastRing.rotation.x = -Math.PI / 2;
  blastRing.position.set(0, -1.09, 6.0);
  carriageGroup.add(blastRing);

  /* ── 5. 155MM PROJECTILE WITH FP-155 GUIDANCE KIT ── */
  const shellGroup = new THREE.Group();
  shellGroup.visible = false;
  group.add(shellGroup);

  const shellAftGroup = new THREE.Group();
  shellGroup.add(shellAftGroup);

  const shellBody = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.72, 24), oliveMat);
  shellBody.rotation.x = Math.PI / 2;
  shellAftGroup.add(shellBody);

  const copperBand = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.08, 24), copperMat);
  copperBand.rotation.x = Math.PI / 2;
  copperBand.position.z = -0.24;
  shellAftGroup.add(copperBand);

  const shellFwdGroup = new THREE.Group();
  shellGroup.add(shellFwdGroup);

  const guidanceOgive = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 24), steelMat);
  guidanceOgive.rotation.x = Math.PI / 2;
  guidanceOgive.position.z = 0.58;
  shellFwdGroup.add(guidanceOgive);

  const sapphireTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 16, 16),
    new THREE.MeshPhysicalMaterial({ color: 0x8cd2ff, transmission: 0.9, roughness: 0.1, ior: 1.77 })
  );
  sapphireTip.position.z = 0.88;
  shellFwdGroup.add(sapphireTip);

  const canardGeo = new THREE.BoxGeometry(0.02, 0.32, 0.14);
  const finMat = new THREE.MeshStandardMaterial({ color: 0x9ec7db, metalness: 0.9, roughness: 0.2 });
  const shellFins = [];
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const finPivot = new THREE.Group();
    finPivot.position.set(0, 0, 0.46);
    finPivot.rotation.z = angle;

    const bladePivot = new THREE.Group();
    bladePivot.rotation.x = -Math.PI / 2; // starts stowed flush
    finPivot.add(bladePivot);

    const blade = new THREE.Mesh(canardGeo, finMat);
    blade.position.set(0, 0.22, 0);
    bladePivot.add(blade);

    shellFwdGroup.add(finPivot);
    shellFins.push({ finPivot, bladePivot, blade });
  }

  /* ── 6. BATTLEFIELD GROUND & TARGET ZONE ── */
  const battlefield = new THREE.Group();
  group.add(battlefield);

  const padGeo = new THREE.PlaneGeometry(12, 12);
  const padMat = new THREE.MeshStandardMaterial({ color: 0x141820, roughness: 0.8, metalness: 0.3 });
  const padMesh = new THREE.Mesh(padGeo, padMat);
  padMesh.rotation.x = -Math.PI / 2;
  padMesh.position.set(0, -1.1, 0);
  padMesh.receiveShadow = true;
  battlefield.add(padMesh);

  const terrainGeo = new THREE.PlaneGeometry(280, 160);
  const terrainMat = new THREE.MeshStandardMaterial({ color: 0x06080e, roughness: 0.95, metalness: 0.1 });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.rotation.x = -Math.PI / 2;
  terrain.position.set(70, -1.12, 0);
  terrain.receiveShadow = true;
  battlefield.add(terrain);

  const TARGET_X = 120;
  const targetPad = new THREE.Group();
  targetPad.position.set(TARGET_X, -1.09, 0);
  battlefield.add(targetPad);

  const tSlab = new THREE.Mesh(new THREE.CylinderGeometry(8, 8.4, 0.2, 32), darkChassisMat);
  tSlab.receiveShadow = true;
  targetPad.add(tSlab);

  const unguidedRing = new THREE.Mesh(
    new THREE.RingGeometry(5.0, 5.2, 48),
    new THREE.MeshBasicMaterial({ color: 0xff453a, side: THREE.DoubleSide })
  );
  unguidedRing.rotation.x = -Math.PI / 2;
  unguidedRing.position.y = 0.11;
  targetPad.add(unguidedRing);

  const guidedRing = new THREE.Mesh(
    new THREE.RingGeometry(1.5, 1.68, 48),
    new THREE.MeshBasicMaterial({ color: 0x00e5ff, side: THREE.DoubleSide })
  );
  guidedRing.rotation.x = -Math.PI / 2;
  guidedRing.position.y = 0.12;
  targetPad.add(guidedRing);

  const beaconMast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.8, 12), steelMat);
  beaconMast.position.set(0, 0.9, 0);
  targetPad.add(beaconMast);

  const beaconLight = new THREE.PointLight(0x00e5ff, 2.5, 12);
  beaconLight.position.set(0, 1.9, 0);
  targetPad.add(beaconLight);

  /* ── 7. 3D TRAJECTORY CURVE LINE ── */
  const N_PTS = 100;
  const trajPoints = [];
  for (let i = 0; i <= N_PTS; i++) {
    const t = (i / N_PTS) * MISSION.tof;
    const pt = flightPoint(t);
    const x = (pt.x / MISSION.range) * TARGET_X;
    const y = -1.1 + (pt.h / MISSION.apogee) * 32;
    const z = (pt.guided / UNGUIDED_MISS) * 4.0;
    trajPoints.push(new THREE.Vector3(x, y, z));
  }
  const trajCurveGeo = new THREE.BufferGeometry().setFromPoints(trajPoints);
  const trajCurve = new THREE.Line(
    trajCurveGeo,
    new THREE.LineBasicMaterial({ color: 0x64d2ff, transparent: true, opacity: 0.6 })
  );
  group.add(trajCurve);

  /* ── 8. TERMINAL AIRBURST EXPLOSION ── */
  const airburstGroup = new THREE.Group();
  airburstGroup.position.set(TARGET_X, 0.6, 0);
  airburstGroup.visible = false;
  group.add(airburstGroup);

  const airburstLight = new THREE.PointLight(0xff6600, 0, 50);
  airburstGroup.add(airburstLight);

  const burstSphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.2, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 })
  );
  airburstGroup.add(burstSphere);

  const burstRing = new THREE.Mesh(
    new THREE.RingGeometry(0.2, 0.8, 32),
    new THREE.MeshBasicMaterial({ color: 0xff8811, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  );
  burstRing.rotation.x = -Math.PI / 2;
  burstRing.position.y = -0.55;
  airburstGroup.add(burstRing);

  /* ── CONTROLLER STATE & METHODS ── */
  let elevationDeg = 50;
  let recoilOffset = 0;
  let recoilVel = 0;
  let flashTimer = 0;
  let blastRingTimer = 0;
  let burstTimer = 0;
  let burstActive = false;

  let simTime = 0;
  let simPlaying = false;
  let simActive = false;
  let simSlowMo = false;
  let simGuidance = true;
  let simCam = 'follow';

  const setElevation = (deg) => {
    elevationDeg = clamp(deg, 30, 65);
    const rad = elevationDeg * DEG;
    elevationPivot.rotation.x = -(rad - Math.PI / 2);
  };
  setElevation(50);

  const fire = () => {
    simActive = true;
    simPlaying = true;
    simTime = 0;
    burstActive = false;
    airburstGroup.visible = false;

    recoilOffset = -0.85;
    recoilVel = -6.0;
    flashTimer = 0.15;
    flashGroup.visible = true;
    flashLight.intensity = 18;

    blastRingTimer = 0.6;
    blastRingMat.opacity = 0.8;
    blastRing.scale.set(1, 1, 1);

    shellGroup.visible = true;
    sfx.cannonFire();
  };

  const reset = () => {
    simActive = false;
    simPlaying = false;
    simTime = 0;
    burstActive = false;
    flashGroup.visible = false;
    airburstGroup.visible = false;
    shellGroup.visible = false;
    recoilOffset = 0;
    barrelRecoilGroup.position.z = 0;
  };

  const seek = (t) => {
    simTime = clamp(t, 0, MISSION.tof);
    simActive = true;
    shellGroup.visible = simTime < MISSION.tof;
  };

  const update = (dt) => {
    if (recoilOffset < -0.001 || Math.abs(recoilVel) > 0.05) {
      const kSpring = 45;
      const kDamp = 11;
      const acc = -kSpring * recoilOffset - kDamp * recoilVel;
      recoilVel += acc * dt;
      recoilOffset += recoilVel * dt;
      if (recoilOffset > 0) { recoilOffset = 0; recoilVel = 0; }
    } else {
      recoilOffset = 0;
    }
    barrelRecoilGroup.position.z = recoilOffset;

    if (flashTimer > 0) {
      flashTimer -= dt;
      const k = Math.max(0, flashTimer / 0.15);
      flashLight.intensity = 18 * k;
      flashOuter.scale.setScalar(1 + (1 - k) * 0.8);
      flashOuterMat.opacity = 0.85 * k;
      flashCoreMat.opacity = 0.95 * k;
      if (flashTimer <= 0) flashGroup.visible = false;
    }

    if (blastRingTimer > 0) {
      blastRingTimer -= dt;
      const k = 1 - Math.max(0, blastRingTimer / 0.6);
      blastRing.scale.setScalar(1 + k * 6.5);
      blastRingMat.opacity = (1 - k) * 0.75;
    }

    if (burstActive && burstTimer > 0) {
      burstTimer -= dt;
      const k = 1 - Math.max(0, burstTimer / 1.1);
      burstSphere.scale.setScalar(1 + k * 4.0);
      burstSphere.material.opacity = (1 - k);
      burstRing.scale.setScalar(1 + k * 8.0);
      burstRing.material.opacity = (1 - k) * 0.9;
      airburstLight.intensity = Math.max(0, (1 - k) * 22);
      if (burstTimer <= 0) airburstGroup.visible = false;
    }

    if (simActive) {
      if (simPlaying) {
        const rate = simSlowMo ? 0.25 : 1.0;
        simTime += dt * rate;
      }
      if (simTime >= MISSION.tof) {
        simTime = MISSION.tof;
        if (!burstActive) {
          burstActive = true;
          burstTimer = 1.1;
          airburstGroup.visible = true;
          shellGroup.visible = false;
          sfx.airburst();
        }
      }

      const pt = flightPoint(simTime);
      const x = (pt.x / MISSION.range) * TARGET_X;
      const y = -1.1 + (pt.h / MISSION.apogee) * 32;
      const zDrift = simGuidance
        ? (pt.guided / UNGUIDED_MISS) * 4.0
        : (pt.drift / UNGUIDED_MISS) * 4.0;
      shellGroup.position.set(x, y, zDrift);

      const nextT = Math.min(MISSION.tof, simTime + 0.1);
      const ptNext = flightPoint(nextT);
      const nx = (ptNext.x / MISSION.range) * TARGET_X;
      const ny = -1.1 + (ptNext.h / MISSION.apogee) * 32;
      const nz = simGuidance
        ? (ptNext.guided / UNGUIDED_MISS) * 4.0
        : (ptNext.drift / UNGUIDED_MISS) * 4.0;

      const dir = new THREE.Vector3(nx - x, ny - y, nz - zDrift).normalize();
      shellGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);

      const aftSpinRate = 28;
      shellAftGroup.rotation.z += aftSpinRate * dt;

      if (simTime < 1.2) {
        shellFwdGroup.rotation.z = shellAftGroup.rotation.z;
      } else {
        shellFwdGroup.rotation.z = Math.sin(simTime * 2.0) * 0.05;
      }

      const finTarget = simTime >= 5.0 ? 0 : -Math.PI / 2;
      shellFins.forEach((f, k) => {
        f.bladePivot.rotation.x = lerp(f.bladePivot.rotation.x, finTarget, 10 * dt);
        if (simTime >= MISSION.tApogee && simGuidance) {
          const steerCmd = Math.sin(simTime * 4.0 + k * 1.5) * (7.5 * DEG);
          f.finPivot.rotation.y = steerCmd;
        } else {
          f.finPivot.rotation.y = 0;
        }
      });
    }
  };

  const getTelemetry = () => {
    const pt = flightPoint(simTime);
    let phase = 'READY';
    let phaseDesc = '155mm howitzer charged. Gun elevated to 50°. Setback battery primed for 16,800 g launch shock.';
    let gLoad = '1.0 g';

    if (simActive) {
      if (simTime < 0.08) {
        phase = 'LAUNCH SHOCK // 16,800 G';
        phaseDesc = 'Muzzle exit setback shock detected. Thermal reserve battery activated instantaneously.';
        gLoad = '16,800 g';
      } else if (simTime < 1.2) {
        phase = 'INTERNAL BORE EXIT // 250 HZ SPIN';
        phaseDesc = 'Projectile released from rifled barrel. Shell spinning at 250 Hz (15,000 RPM).';
        gLoad = '14.2 g';
      } else if (simTime < 5.0) {
        phase = 'ROLL DECOUPLING ACTIVE';
        phaseDesc = 'Ceramic thrust bearing isolates forward guidance collar (< 5 Hz) from 250 Hz body.';
        gLoad = '8.5 g';
      } else if (simTime < MISSION.tApogee) {
        phase = 'CANARDS DEPLOYED // ASCENT';
        phaseDesc = '4 titanium double-wedge fins latched open. Ascending to 8,340 m apogee.';
        gLoad = '4.6 g';
      } else if (simTime < 65.0) {
        phase = 'APN GUIDANCE LOOP // DESCENT';
        phaseDesc = '15-state EKF active. Canards steering ±7.5° to null atmospheric wind drift.';
        gLoad = '6.8 g';
      } else if (simTime < MISSION.tof) {
        phase = 'TERMINAL RADAR HOMING';
        phaseDesc = '24 GHz FMCW radar altimeter acquiring ground. Proximity HOB trigger primed.';
        gLoad = '11.4 g';
      } else {
        phase = 'AIRBURST DETONATION // TARGET INTERCEPT';
        phaseDesc = 'Proximity HOB 5.0 m triggered! Airburst detonation at target CEP ≤ 16.8 m.';
        gLoad = '0.0 g';
      }
    }

    const distKm = (pt.x / 1000).toFixed(2);
    const altM = Math.round(pt.h);
    const speed = simTime < 0.1 ? 892 : Math.round(892 - (350 * (simTime / MISSION.tof)));
    const mach = (speed / 340).toFixed(2);
    const spinStr = simTime < 1.2 ? (simActive ? '250 Hz (15k RPM)' : 'STATIC') : 'AFT 250 Hz // NOSE < 5 Hz';

    return {
      phase,
      phaseDesc,
      distKm,
      altM,
      speed,
      mach,
      gLoad,
      spinStr,
      simTime,
      tof: MISSION.tof,
      active: simActive,
    };
  };

  return {
    group,
    elevationPivot,
    shellGroup,
    fire,
    reset,
    seek,
    setElevation,
    setGuidance: (v) => { simGuidance = v; },
    setCam: (c) => { simCam = c; },
    getCam: () => simCam,
    togglePlay: () => { simPlaying = !simPlaying; return simPlaying; },
    setSlowMo: (v) => { simSlowMo = v; },
    update,
    getTelemetry,
  };
}

/* ═══════════════════════════════ 9 · CONTROLLER ═══════════════════════════════ */

const VIEWS = {
  iso: { pos: [4.6, 2.5, 6.9], target: [0, -0.05, 0] },
  side: { pos: [0.2, 0.15, 9.6], target: [0, 0, 0] },
  nose: { pos: [6.2, 1.5, 2.6], target: [1.9, 0, 0] },
  aft: { pos: [-4.8, 1.9, 4.6], target: [-1.2, 0, 0] },
};

async function startTwin() {
  const $ = (id) => document.getElementById(id);
  const sfx = new SoundFX();
  const state = {
    mode: 'twin',
    explodeTarget: 0, explode: 0,
    deploy: true, steer: true, roll: false, flow: false, cut: false,
    cutOffset: 0, cutConst: 3, spin: 0, impellerSpin: 0, steerAmt: 0, flowFade: 0,
    audio: true, selected: null, time: 0,
  };

  /* Renderer / scene / camera */
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;
  $('viewport').appendChild(renderer.domElement);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.05, 120);
  camera.position.set(...VIEWS.iso.pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...VIEWS.iso.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 1.4;
  controls.maxDistance = 22;
  controls.maxPolarAngle = Math.PI * 0.62;

  setStatus('Synthesizing 1024×512 studio HDRI…', 0.3);
  await nextFrame();
  const hdri = createStudioHDRI();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(hdri).texture;
  hdri.dispose();
  pmrem.dispose();
  scene.background = createBackdropTexture();

  setStatus('Generating procedural PBR maps…', 0.45);
  await nextFrame();
  const tex = createSurfaceTextures(aniso);
  tex.body = createBodyTextures(aniso);
  tex.pcbA = createPCBTextures(11, aniso);
  tex.pcbB = createPCBTextures(23, aniso);

  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), state.cutConst);
  const M = createMaterials(tex, sectionPlane);

  setStatus('Building watertight assembly geometry…', 0.6);
  await nextFrame();
  const rig = buildAssembly(M);
  scene.add(rig.assembly);

  /* Lighting & ground */
  const FLOOR_Y = -1.12;
  const key = new THREE.DirectionalLight(0xfff0dc, 1.6);
  key.position.set(3.2, 7.5, 4.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -7, right: 7, top: 4, bottom: -4, near: 1, far: 20 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd6ff, 0.9);
  rim.position.set(-5, 2, -6);
  scene.add(rim);

  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.32 }));
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = FLOOR_Y;
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: createContactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.9 }),
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = FLOOR_Y + 0.002;
  contact.renderOrder = -1;
  scene.add(contact);

  const flow = buildFlowFX();
  scene.add(flow.group);

  const artillery = buildArtillerySimulation(THREE, tex, sfx);
  scene.add(artillery.group);

  setStatus('Compiling shaders…', 0.8);
  await nextFrame();
  try { await renderer.compileAsync(scene, camera); } catch { /* compiled lazily */ }

  /* ── UI binding ────────────────────────────────────────── */
  const toast = (() => {
    let timer;
    return (msg) => {
      const el = $('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove('show'), 2600);
    };
  })();

  const toggles = {};
  const bindToggle = (id, key, onChange) => {
    const el = $(id);
    const set = (v, silent = false) => {
      state[key] = v;
      el.classList.toggle('active', v);
      el.setAttribute('aria-pressed', String(v));
      if (!silent) onChange?.(v);
    };
    el.addEventListener('click', () => { sfx.click(); set(!state[key]); });
    set(state[key], true);
    toggles[key] = set;
    return set;
  };

  const releaseFins = (deploy) => {
    rig.fins.forEach((f, k) => {
      f.releaseAt = state.time + k * 0.07;
      f.latched = false;
    });
    if (!deploy) sfx.whoosh();
  };
  bindToggle('btnDeploy', 'deploy', releaseFins);
  bindToggle('btnSteer', 'steer');
  bindToggle('btnRoll', 'roll', (v) => toast(v ? 'Aft body spinning at 250 Hz — forward section held roll-stable by the bearing' : 'Body spin-down'));
  bindToggle('btnFlow', 'flow', (v) => {
    if (v && state.explodeTarget > 0) setExplode(0);
    if (v) toast('M 2.2 · oblique bow shock β ≈ 31° · turbine spinning up');
  });
  bindToggle('btnCut', 'cut', (v) => {
    $('cutSlider').disabled = !v;
    if (v && camera.position.z < 0.5) flyTo(VIEWS.side);
  });
  bindToggle('btnAudio', 'audio');
  $('btnAudio').addEventListener('click', () => { sfx.enabled = state.audio; });

  $('cutSlider').addEventListener('input', (e) => {
    state.cutOffset = (Number(e.target.value) / 100) * 1.05;
    $('cutVal').textContent = `${(state.cutOffset * MM_PER_UNIT).toFixed(1)} mm`;
  });

  const setExplode = (v) => {
    state.explodeTarget = clamp(v, 0, 1);
    $('explodeSlider').value = Math.round(state.explodeTarget * 100);
    $('explodeVal').textContent = `${Math.round(state.explodeTarget * 100)}%`;
  };
  $('explodeSlider').addEventListener('input', (e) => setExplode(Number(e.target.value) / 100));
  document.querySelectorAll('[data-explode]').forEach((b) =>
    b.addEventListener('click', () => { sfx.click(); setExplode(Number(b.dataset.explode)); }));

  let camTween = null;
  const flyTo = ({ pos, target }, dur = 1.2) => {
    camTween = {
      t: 0, dur,
      p0: camera.position.clone(), p1: new THREE.Vector3(...pos),
      t0: controls.target.clone(), t1: new THREE.Vector3(...target),
    };
  };
  controls.addEventListener('start', () => { camTween = null; });
  document.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => { sfx.click(); flyTo(VIEWS[b.dataset.view]); }));

  const selectPart = (key, focus = true) => {
    const d = SUBSYSTEMS[key];
    if (!d) return;
    state.selected = key;
    $('partCategory').textContent = d.category;
    $('partTitle').textContent = d.title;
    $('partDesc').textContent = d.desc;
    $('specMaterial').textContent = d.material;
    $('specFinish').textContent = d.finish;
    $('specParam').textContent = d.param;
    $('specFunction').textContent = d.fn;
    $('specNotes').textContent = d.notes;
    document.querySelectorAll('.subsystem-list li').forEach((li) => li.classList.toggle('active', li.dataset.part === key));
    if (focus) {
      const box = new THREE.Box3().setFromObject(rig.groups[key]);
      const centre = box.getCenter(new THREE.Vector3());
      centre.y = clamp(centre.y, -0.3, 0.3);
      const offset = camera.position.clone().sub(controls.target);
      flyTo({ pos: centre.clone().add(offset).toArray(), target: centre.toArray() }, 0.9);
    }
  };
  document.querySelectorAll('.subsystem-list li').forEach((li) => {
    const go = () => { sfx.click(); selectPart(li.dataset.part); };
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });

  $('btnExport').addEventListener('click', () => {
    sfx.click();
    // Export in millimetres, CAD-style (+Y = nose), in the current pose
    const a = rig.assembly;
    const saved = { p: a.position.clone(), r: a.rotation.clone(), s: a.scale.clone() };
    a.position.set(0, 0, 0);
    a.rotation.set(0, 0, 0);
    a.scale.setScalar(MM_PER_UNIT);
    a.updateMatrixWorld(true);
    const obj = new OBJExporter().parse(a);
    a.position.copy(saved.p);
    a.rotation.copy(saved.r);
    a.scale.copy(saved.s);
    a.updateMatrixWorld(true);
    const header = `# FP-155 Canard Steering Assembly — digital twin export\n# Units: millimetres · +Y = nose · exported ${new Date().toISOString()}\n`;
    const url = URL.createObjectURL(new Blob([header + obj], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'FP-155_Canard_Steering_Assembly.obj';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${(obj.length / 1e6).toFixed(1)} MB OBJ (mm, current pose)`);
  });

  /* ── Apple Liquid Glass Sidebar & Drawer Controls ── */
  const toggleSidebar = () => {
    const isCollapsed = $('controlPanel').classList.toggle('collapsed');
    $('btnToggleSidebar')?.classList.toggle('active', !isCollapsed);
    $('panelToggle')?.setAttribute('aria-expanded', String(!isCollapsed));
  };
  $('btnToggleSidebar')?.addEventListener('click', () => { sfx.click(); toggleSidebar(); });
  $('btnCloseSidebar')?.addEventListener('click', () => { sfx.click(); toggleSidebar(); });
  $('btnCloseInfo')?.addEventListener('click', () => {
    sfx.click();
    $('infoPanel')?.classList.toggle('collapsed');
  });

  $('panelToggle').addEventListener('click', () => {
    toggleSidebar();
  });

  /* ── Mode Switcher (Guidance Twin vs Artillery Simulation) ── */
  const setMode = (m) => {
    state.mode = m;
    const isTwin = m === 'twin';
    $('tabTwinMode')?.classList.toggle('active', isTwin);
    $('tabTwinMode')?.setAttribute('aria-selected', String(isTwin));
    $('tabSimMode')?.classList.toggle('active', !isTwin);
    $('tabSimMode')?.setAttribute('aria-selected', String(!isTwin));

    rig.assembly.visible = isTwin;
    shadowCatcher.visible = isTwin;
    contact.visible = isTwin;
    flow.group.visible = isTwin && state.flow;
    artillery.group.visible = !isTwin;

    const grpTwin = $('sectionGroupTwin');
    if (grpTwin) grpTwin.style.display = isTwin ? 'flex' : 'none';
    const grpSim = $('sectionGroupSim');
    if (grpSim) grpSim.style.display = !isTwin ? 'flex' : 'none';

    const tTwin = $('twinTelemetry');
    if (tTwin) tTwin.style.display = isTwin ? 'flex' : 'none';
    const tSim = $('simTelemetry');
    if (tSim) tSim.style.display = !isTwin ? 'flex' : 'none';

    const dockLabel = $('dockModeLabel');
    if (dockLabel) dockLabel.textContent = isTwin ? 'TWIN' : 'SIMULATION';
    const sideCat = $('sidebarCategoryTag');
    if (sideCat) sideCat.textContent = isTwin ? 'DIGITAL TWIN' : 'ARTILLERY SIM';
    const sideTitle = $('sidebarTitle');
    if (sideTitle) sideTitle.textContent = isTwin ? 'Component Controls' : 'Howitzer Controls';

    if (isTwin) {
      flyTo(VIEWS.iso);
    } else {
      const cam = artillery.getCam();
      if (cam === 'gun') flyTo({ pos: [-4.2, 2.2, 6.2], target: [3.5, 4.0, 0] }, 1.0);
      else if (cam === 'tactical') flyTo({ pos: [60, 48, 88], target: [60, 14, 0] }, 1.2);
      else if (cam === 'target') flyTo({ pos: [129, 3.0, 14], target: [120, 1.2, 0] }, 1.2);
      else flyTo({ pos: [-4.2, 2.2, 6.2], target: [3.5, 4.0, 0] }, 1.0);
    }
    toast(isTwin ? 'Mode: Component Twin Inspection' : 'Mode: 155mm Artillery Fire Simulation');
  };
  $('tabTwinMode')?.addEventListener('click', () => { sfx.click(); setMode('twin'); });
  $('tabSimMode')?.addEventListener('click', () => { sfx.click(); setMode('sim'); });

  /* ── Artillery Simulation UI Listeners ── */
  $('btnFireCannon')?.addEventListener('click', () => {
    $('btnFireCannon').classList.add('firing');
    setTimeout(() => $('btnFireCannon').classList.remove('firing'), 500);
    artillery.fire();
    toast('💥 FIRE! 155mm howitzer round discharged downrange');
  });

  $('gunElevationSlider')?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('gunElevationVal').textContent = `${v}°`;
    artillery.setElevation(v);
  });

  $('simRangeSlider')?.addEventListener('input', (e) => {
    $('simRangeVal').textContent = `${Number(e.target.value).toFixed(1)} km`;
  });

  document.querySelectorAll('.charge-grid .btn-charge').forEach((b) => {
    b.addEventListener('click', () => {
      sfx.click();
      document.querySelectorAll('.charge-grid .btn-charge').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      toast(`MACS Propellant Charge Zone ${b.dataset.charge} selected`);
    });
  });

  $('btnSimGuidance')?.addEventListener('click', () => {
    sfx.click();
    const active = $('btnSimGuidance').classList.toggle('active');
    $('btnSimGuidance').setAttribute('aria-pressed', String(active));
    artillery.setGuidance(active);
    const span = $('btnSimGuidance').querySelector('span:last-child');
    if (span) span.textContent = active ? 'Active Canard Homing (CEP 16.8 m)' : 'Unguided Ballistic (CEP 114 m)';
    toast(active ? 'Precision APN Guidance: ACTIVE' : 'Guidance: OFF (Ballistic Drift)');
  });

  document.querySelectorAll('.sim-cam-buttons button').forEach((b) => {
    b.addEventListener('click', () => {
      sfx.click();
      document.querySelectorAll('.sim-cam-buttons button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const cam = b.dataset.simcam;
      artillery.setCam(cam);
      if (cam === 'gun') flyTo({ pos: [-4.2, 2.2, 6.2], target: [3.5, 4.0, 0] }, 0.8);
      else if (cam === 'tactical') flyTo({ pos: [60, 48, 88], target: [60, 14, 0] }, 1.2);
      else if (cam === 'target') flyTo({ pos: [129, 3.0, 14], target: [120, 1.2, 0] }, 1.2);
    });
  });

  $('simScrubber')?.addEventListener('input', (e) => {
    artillery.seek(Number(e.target.value));
  });

  $('btnSimPlay')?.addEventListener('click', () => {
    sfx.click();
    const playing = artillery.togglePlay();
    $('btnSimPlay').textContent = playing ? '⏸ Pause' : '▶ Play';
  });

  $('btnSimReset')?.addEventListener('click', () => {
    sfx.click();
    artillery.reset();
    $('btnSimPlay').textContent = '▶ Play';
    toast('Simulation reset to ready on firing line');
  });

  $('btnSimSlowMo')?.addEventListener('click', () => {
    sfx.click();
    const sm = $('btnSimSlowMo').classList.toggle('active');
    artillery.setSlowMo(sm);
  });

  initTrajectoryModal($, sfx);
  initArchitectureModal($, sfx);
  initAvionics($, sfx, toast);

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey || $('modalTrajectory')?.open || $('modalArchitecture')?.open) return;
    const k = e.key.toLowerCase();
    const flip = (key) => $(`btn${key}`).click();
    if (e.code === 'Tab') {
      e.preventDefault();
      sfx.click();
      toggleSidebar();
    } else if (k === 'm') {
      sfx.click();
      setMode(state.mode === 'twin' ? 'sim' : 'twin');
    } else if (e.code === 'Space') {
      e.preventDefault();
      sfx.click();
      if (state.mode === 'sim') {
        $('btnFireCannon')?.click();
      } else {
        setExplode(state.explodeTarget > 0.4 ? 0 : 1);
      }
    } else if (k === 'c') flip('Cut');
    else if (k === 'd') flip('Deploy');
    else if (k === 's') flip('Steer');
    else if (k === 'r') flip('Roll');
    else if (k === 'f') flip('Flow');
    else if (['1', '2', '3', '4'].includes(k)) {
      if (state.mode === 'sim') {
        const cams = ['follow', 'gun', 'tactical', 'target'];
        const cam = cams[Number(k) - 1];
        const btn = document.querySelector(`.sim-cam-buttons button[data-simcam="${cam}"]`);
        btn?.click();
      } else {
        flyTo(VIEWS[['iso', 'side', 'nose', 'aft'][Number(k) - 1]]);
      }
    }
  });

  /* Picking (ignores geometry that the section plane has clipped away) */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pickables = [];
  rig.assembly.traverse((o) => { if (o.isMesh) pickables.push(o); });
  const pick = (cx, cy) => {
    ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(pickables, false).find((h) => sectionPlane.distanceToPoint(h.point) >= 0) || null;
  };
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const hit = pick(e.clientX, e.clientY);
    if (hit) { sfx.click(); selectPart(hit.object.userData.part, false); }
  });
  let hoverQueued = null;
  renderer.domElement.addEventListener('pointermove', (e) => { hoverQueued = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerleave', () => { hoverQueued = null; $('hoverTag').classList.remove('visible'); });
  const updateHover = () => {
    if (!hoverQueued) return;
    const [x, y] = hoverQueued;
    hoverQueued = null;
    const tag = $('hoverTag');
    const hit = pick(x, y);
    if (!hit) { tag.classList.remove('visible'); renderer.domElement.style.cursor = ''; return; }
    tag.innerHTML = `${hit.object.name.replace(/_/g, ' ')}<small>${SUBSYSTEMS[hit.object.userData.part].title}</small>`;
    tag.style.left = `${x}px`;
    tag.style.top = `${y}px`;
    tag.classList.add('visible');
    renderer.domElement.style.cursor = 'pointer';
  };

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ── Simulation steps ─────────────────────────────────── */
  const partRank = Object.fromEntries(PART_ORDER.map((k, i) => [k, i]));
  const STAGGER = 0.07;
  const span = 1 - STAGGER * (PART_ORDER.length - 1);

  const stepExplode = (dt) => {
    state.explode = damp(state.explode, state.explodeTarget, 6, dt);
    if (Math.abs(state.explode - state.explodeTarget) < 1e-4) state.explode = state.explodeTarget;
    const e = state.explode;
    for (const [key, g] of Object.entries(rig.groups)) {
      const p = clamp((e - partRank[key] * STAGGER) / span, 0, 1);
      g.position.y = EXPLODE_OFFSET[key] * EASE_EXPLODE(p);
    }
    const lo = ASSEMBLED_RANGE[0] + rig.groups.body.position.y;
    const hi = ASSEMBLED_RANGE[1] + rig.groups.ogive.position.y;
    rig.assembly.position.x = -(lo + hi) / 2;
    const len = hi - lo;
    contact.scale.set(len * 1.25, 2.9, 1);
    const zoom = 1 / (1 + 0.42 * EASE_EXPLODE(e));
    if (Math.abs(camera.zoom - zoom) > 1e-4) { camera.zoom = zoom; camera.updateProjectionMatrix(); }
  };

  const STOWED = -Math.PI / 2;
  const stepFins = (dt) => {
    const target = state.deploy ? 0 : STOWED;
    state.steerAmt = damp(state.steerAmt, state.steer ? 1 : 0, 3, dt);
    const t = state.time;
    const amp = 7.5 * DEG * (0.78 + 0.22 * Math.sin(t * 0.37));
    const pitchCmd = Math.sin(t * 3.1);
    const yawCmd = Math.sin(t * 2.3 + 1.1);
    rig.fins.forEach((f, k) => {
      if (t >= f.releaseAt) {
        // under-damped torsion spring when deploying, critically damped when stowing
        const K = state.deploy ? 150 : 60;
        const zeta = state.deploy ? 0.22 : 1.0;
        const sub = 4;
        for (let i = 0; i < sub; i++) {
          const h = dt / sub;
          const acc = K * (target - f.angle) - 2 * zeta * Math.sqrt(K) * f.vel;
          f.vel += acc * h;
          f.angle += f.vel * h;
          if (state.deploy && f.angle > 0) { // hard latch stop
            f.angle = 0;
            f.vel = -f.vel * 0.35;
            if (!f.latched) { f.latched = true; sfx.latch(); }
          }
          if (f.angle < STOWED) { f.angle = STOWED; f.vel = 0; }
        }
      }
      f.fold.rotation.z = f.angle;
      const deployed = clamp(1 - f.angle / STOWED, 0, 1) ** 4;
      const cmd = k % 2 === 0 ? pitchCmd : yawCmd;
      f.delta = amp * cmd * (k < 2 ? 1 : -1) * state.steerAmt * deployed;
      f.pitch.rotation.x = f.delta;
    });
  };

  let rollAngle = 0;
  const VISUAL_SPIN = 24; // rad/s shown on screen (250 Hz is far above the frame rate)
  const stepRoll = (dt) => {
    state.spin = damp(state.spin, state.roll ? VISUAL_SPIN : 0, 1.4, dt);
    rollAngle += state.spin * dt;
    rig.groups.body.rotation.y = rollAngle;
    rig.groups.base.rotation.y = rollAngle;
    rig.bearingInner.rotation.y = rollAngle;
    rig.ballCarrier.rotation.y = rollAngle * 0.42;
    const wobble = (state.spin / VISUAL_SPIN) * 0.6 * DEG * Math.sin(state.time * 1.7);
    for (const k of ['power', 'avionics', 'canards', 'ogive']) rig.groups[k].rotation.y = wobble;
    state.impellerSpin = damp(state.impellerSpin, state.flow ? 38 : 0, 0.9, dt);
    rig.impeller.rotation.y += state.impellerSpin * dt;
  };

  const stepCut = (dt) => {
    state.cutConst = damp(state.cutConst, state.cut ? state.cutOffset : 3, 4.5, dt);
    sectionPlane.constant = state.cutConst;
  };

  const stepFlow = (dt) => {
    state.flowFade = damp(state.flowFade, state.flow ? 1 : 0, 3, dt);
    flow.group.visible = state.flowFade > 0.01;
    if (!flow.group.visible) return;
    const tipX = OGIVE.yTop + OGIVE.domeR + rig.groups.ogive.position.y + rig.assembly.position.x;
    const finX = 1.47 + rig.groups.canards.position.y + rig.assembly.position.x;
    flow.update(dt, state.time, tipX, finX, rig.assembly.position.x, state.flowFade);
  };

  const stepCamera = (dt) => {
    if (!camTween) return;
    camTween.t += dt;
    const k = EASE_CAMERA(Math.min(1, camTween.t / camTween.dur));
    camera.position.lerpVectors(camTween.p0, camTween.p1, k);
    controls.target.lerpVectors(camTween.t0, camTween.t1, k);
    if (camTween.t >= camTween.dur) camTween = null;
  };

  let servoTimer = 0, uiTimer = 0, frames = 0, fpsTimer = 0;
  const updateTelemetry = () => {
    const f = rig.fins;
    const stowedCount = f.filter((x) => x.angle < -0.05).length;
    $('tCanard').textContent = state.deploy ? (stowedCount ? 'DEPLOYING…' : 'DEPLOYED & LATCHED') : (stowedCount === 4 ? 'STOWED (FLUSH)' : 'STOWING…');
    const d = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x / DEG).toFixed(1)}°`;
    $('tDelta').textContent = `${d(f[0].delta)} / ${d(f[1].delta)}`;
    const hz = (state.spin / VISUAL_SPIN) * 250;
    $('tAft').textContent = hz > 1 ? `${hz.toFixed(0)} Hz · ${(hz * 60).toLocaleString('en-US', { maximumFractionDigits: 0 })} RPM` : 'STATIC';
    const fwdHz = (0.6 * DEG * 1.7 * (hz / 250)) / TAU; // peak rate of the residual wobble
    $('tFwd').textContent = hz > 1 ? `≤ ${fwdHz.toFixed(4)} Hz · isolated` : 'STATIC';
    $('tFlow').textContent = state.flow ? 'M 2.20 · β 31°' : 'OFF';
    $('tCut').textContent = state.cut ? `ON · ${(state.cutOffset * MM_PER_UNIT).toFixed(1)} mm` : 'OFF';
  };

  /* Start */
  selectPart('canards', false);
  releaseFins(true);
  rig.fins.forEach((f, k) => { f.releaseAt = 0.5 + k * 0.08; });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 1 / 20);
    state.time += dt;

    if (state.mode === 'twin') {
      stepExplode(dt);
      stepFins(dt);
      stepRoll(dt);
      stepCut(dt);
      stepFlow(dt);
      stepCamera(dt);
      if (state.steer && state.deploy && (servoTimer += dt) > 1.4) { servoTimer = 0; sfx.servo(); }
    } else if (state.mode === 'sim') {
      artillery.update(dt);
      const camMode = artillery.getCam();
      if (camMode === 'follow' && artillery.shellGroup.visible) {
        const sp = artillery.shellGroup.position;
        camera.position.set(sp.x - 4.2, sp.y + 1.8, sp.z + 5.2);
        controls.target.copy(sp);
      } else {
        stepCamera(dt);
      }
    }

    controls.update();
    updateHover();
    renderer.render(scene, camera);

    if ((uiTimer += dt) > 0.08) {
      uiTimer = 0;
      if (state.mode === 'twin') {
        updateTelemetry();
      } else {
        const st = artillery.getTelemetry();
        const elPhase = $('simTelePhase'); if (elPhase) elPhase.textContent = st.phase;
        const elTag = $('simFlightPhaseTag'); if (elTag) elTag.textContent = st.phase;
        const elDesc = $('simPhaseDesc'); if (elDesc) elDesc.textContent = st.phaseDesc;
        const elRange = $('simTeleRange'); if (elRange) elRange.textContent = `${st.distKm} km`;
        const elAlt = $('simTeleAlt'); if (elAlt) elAlt.textContent = `${st.altM} m AGL`;
        const elVel = $('simTeleVel'); if (elVel) elVel.textContent = `${st.speed} m/s`;
        const elMach = $('simTeleMach'); if (elMach) elMach.textContent = `M ${st.mach}`;
        const elG = $('simTeleG'); if (elG) elG.textContent = st.gLoad;
        const elSpin = $('simTeleSpin'); if (elSpin) elSpin.textContent = st.spinStr;
        const elScrub = $('simScrubber'); if (elScrub) elScrub.value = st.simTime;
        const elScrubVal = $('simScrubberVal'); if (elScrubVal) elScrubVal.textContent = `${st.simTime.toFixed(1)} s / ${st.tof.toFixed(1)} s`;
      }
    }
    frames++;
    if ((fpsTimer += dt) > 0.5) { $('tFps').textContent = Math.round(frames / fpsTimer); frames = 0; fpsTimer = 0; }
  });

  setStatus('Ready', 1);
  setTimeout(() => $('loader').classList.add('done'), 250);
  window.__twin = { THREE, scene, camera, controls, renderer, rig, state, toggles, setExplode, flyTo }; // debugging hook
}

/* ═══════════════════════ 10 · MISSION ANALYSIS & AVIONICS ═══════════════════════ */

/** Sizes the backing store to the CSS box and returns a context in logical (w × h) units. */
function fitCanvas(canvas, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || w;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round((cssW * h / w) * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform((dpr * cssW) / w, 0, 0, (dpr * cssW) / w, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function plotPalette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    cyan: v('--cyan'), emerald: v('--emerald'), amber: v('--amber'), red: v('--red'),
    text: v('--text'), dim: v('--text-dim'), muted: v('--text-muted'),
    mono: v('--font-mono'),
  };
}

const TRAJ_W = 760, TRAJ_H = 440;

function drawTrajectory(canvas, C, progress) {
  const ctx = fitCanvas(canvas, TRAJ_W, TRAJ_H);
  const P = { x: 54, y: 18, w: 690, h: 384 };
  const X = (km) => P.x + (km / 30) * P.w;
  const Y = (km) => P.y + P.h - (km / 10) * P.h;
  const font = (px, weight = 400) => `${weight} ${px}px ${C.mono}`;
  const tNow = progress * MISSION.tof;

  /* grid */
  ctx.lineWidth = 1;
  for (let km = 0; km <= 30; km++) {
    const major = km % 5 === 0;
    ctx.strokeStyle = major ? 'rgba(160, 200, 230, 0.16)' : 'rgba(160, 200, 230, 0.05)';
    ctx.beginPath(); ctx.moveTo(X(km) + 0.5, P.y); ctx.lineTo(X(km) + 0.5, P.y + P.h + (major ? 5 : 3)); ctx.stroke();
  }
  for (let i = 0; i <= 20; i++) {
    const major = i % 4 === 0;
    ctx.strokeStyle = major ? 'rgba(160, 200, 230, 0.16)' : 'rgba(160, 200, 230, 0.05)';
    ctx.beginPath(); ctx.moveTo(P.x - (major ? 5 : 3), Y(i / 2) + 0.5); ctx.lineTo(P.x + P.w, Y(i / 2) + 0.5); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(160, 200, 230, 0.4)';
  ctx.strokeRect(P.x + 0.5, P.y + 0.5, P.w, P.h);

  ctx.fillStyle = C.dim;
  ctx.font = font(10);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let km = 0; km <= 30; km += 5) ctx.fillText(String(km), X(km), P.y + P.h + 8);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let km = 0; km <= 10; km += 2) ctx.fillText(String(km), P.x - 9, Y(km));
  ctx.fillStyle = C.muted;
  ctx.font = font(9);
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('GROUND RANGE (km)', P.x + P.w / 2, TRAJ_H - 3);
  ctx.save();
  ctx.translate(12, P.y + P.h / 2); ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'middle';
  ctx.fillText('ALTITUDE AGL (km)', 0, 0);
  ctx.restore();

  /* apogee reference */
  ctx.setLineDash([2, 5]);
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.28)';
  ctx.beginPath(); ctx.moveTo(P.x, Y(MISSION.apogee / 1000)); ctx.lineTo(X(19.4), Y(MISSION.apogee / 1000)); ctx.stroke();
  ctx.setLineDash([]);

  /* curves */
  const N = 260;
  const trace = (key) => {
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * tNow;
      const p = flightPoint(t);
      const px = X((p.x + DRIFT_EXAG * p[key]) / 1000), py = Y(p.h / 1000);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.stroke();
  };
  ctx.lineJoin = 'round';
  ctx.setLineDash([7, 5]);
  ctx.strokeStyle = C.amber; ctx.lineWidth = 1.6;
  trace('drift');
  ctx.setLineDash([]);
  ctx.save();
  ctx.shadowColor = C.cyan; ctx.shadowBlur = 12;
  ctx.strokeStyle = C.cyan; ctx.lineWidth = 2.2;
  trace('guided');
  ctx.restore();

  /* milestones */
  ctx.font = font(9.5, 600);
  ctx.textBaseline = 'middle';
  for (const m of MILESTONES) {
    if (m.t > tNow + 1e-6) continue;
    const p = flightPoint(m.t);
    const px = X((p.x + DRIFT_EXAG * p.guided) / 1000), py = Y(p.h / 1000);
    const label = `T+${m.t.toFixed(1)} s  ${m.text}`;
    const tw = ctx.measureText(label).width;
    const ax = X(m.at[0]), ay = Y(m.at[1]);
    const left = m.align === 'left' ? ax : m.align === 'right' ? ax - tw : ax - tw / 2;
    const hook = m.align === 'left' ? left - 5 : m.align === 'right' ? left + tw + 5 : ax;
    ctx.strokeStyle = 'rgba(238, 243, 248, 0.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(hook, m.align === 'center' ? ay + 8 : ay); ctx.stroke();
    ctx.fillStyle = 'rgba(3, 6, 10, 0.82)';
    ctx.fillRect(left - 4, ay - 8, tw + 8, 16);
    ctx.fillStyle = C.text; ctx.textAlign = 'left';
    ctx.fillText(label, left, ay + 0.5);
    ctx.fillStyle = '#03060a'; ctx.strokeStyle = C.cyan; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(px, py, 3.6, 0, TAU); ctx.fill(); ctx.stroke();
  }

  /* live vehicle marker + clock */
  const now = flightPoint(tNow);
  if (progress < 1) {
    ctx.save();
    ctx.shadowColor = C.cyan; ctx.shadowBlur = 14; ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(X((now.x + DRIFT_EXAG * now.guided) / 1000), Y(now.h / 1000), 3, 0, TAU); ctx.fill();
    ctx.restore();
  }
  ctx.font = font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillStyle = C.dim;
  const num = (v, d) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  ctx.fillText(`T+${tNow.toFixed(1).padStart(4, '0')} s   ALT ${num(now.h, 0).padStart(5)} m   RNG ${num(now.x / 1000, 2).padStart(5)} km`, P.x + P.w - 8, P.y + 7);

  /* true-scale terminal inset: last 300 m of altitude around the target */
  const I = { x: X(0.8), y: Y(9.6), w: 190, h: 150 };
  const S = 0.42; // px per metre
  const gx = (m) => I.x + 150 + (m - MISSION.range) * S;
  const gy = (m) => I.y + I.h - 16 - m * S;
  ctx.fillStyle = 'rgba(3, 6, 10, 0.86)';
  ctx.fillRect(I.x, I.y, I.w, I.h);
  ctx.strokeStyle = 'rgba(160, 200, 230, 0.3)'; ctx.lineWidth = 1;
  ctx.strokeRect(I.x + 0.5, I.y + 0.5, I.w, I.h);
  ctx.font = font(8.5, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = C.dim;
  ctx.fillText('TERMINAL · TRUE SCALE', I.x + 7, I.y + 6);
  ctx.save();
  ctx.beginPath(); ctx.rect(I.x + 1, I.y + 18, I.w - 2, I.h - 19); ctx.clip();
  ctx.strokeStyle = 'rgba(160, 200, 230, 0.4)';
  ctx.beginPath(); ctx.moveTo(I.x, gy(0) + 0.5); ctx.lineTo(I.x + I.w, gy(0) + 0.5); ctx.stroke();
  ctx.strokeStyle = C.cyan; ctx.lineWidth = 3; // ±30 m CEP specification band
  ctx.beginPath(); ctx.moveTo(gx(MISSION.range - MISSION.cepSpec), gy(0)); ctx.lineTo(gx(MISSION.range + MISSION.cepSpec), gy(0)); ctx.stroke();
  const tail = (key) => {
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const t = MISSION.tof - 0.9 + (i / 40) * 0.9;
      if (t > tNow) break;
      const p = flightPoint(t);
      if (i) ctx.lineTo(gx(p.x + p[key]), gy(p.h)); else ctx.moveTo(gx(p.x + p[key]), gy(p.h));
    }
    ctx.stroke();
  };
  ctx.setLineDash([5, 4]); ctx.strokeStyle = C.amber; ctx.lineWidth = 1.4;
  tail('drift');
  ctx.setLineDash([]); ctx.strokeStyle = C.cyan; ctx.lineWidth = 1.8;
  tail('guided');
  ctx.restore();
  ctx.font = font(8.5); ctx.textBaseline = 'top'; ctx.textAlign = 'center';
  ctx.fillStyle = C.cyan;
  ctx.fillText('±30 m', gx(MISSION.range), gy(0) + 4);
  if (progress >= 1) {
    ctx.fillStyle = C.amber;
    ctx.fillText(`${UNGUIDED_MISS} m`.replace('-', '−'), gx(MISSION.range + UNGUIDED_MISS), gy(0) + 4);
  }
}

/**
 * Seeded 100-run impact set. Radii are quantile-stratified so the sample statistics land on
 * the reference CEP / R95 figures; bearings are uniform. Returned in metres, target at origin.
 */
function monteCarloImpacts(seed = 2026) {
  const rand = mulberry32(seed);
  const n = MISSION.runs / 2;
  const draw = (median, shape, uMax) => {
    const scale = median / Math.LN2 ** (1 / shape);
    return Array.from({ length: n }, (_, i) => {
      const r = scale * (-Math.log(1 - Math.min((i + 0.5) / n, uMax))) ** (1 / shape);
      const a = rand() * TAU;
      return { r, x: r * Math.sin(a), y: r * Math.cos(a) };
    });
  };
  // Weibull shape that puts the 95th percentile at R95 when the median is the CEP
  const shape = Math.log(Math.log(20) / Math.LN2) / Math.log(MISSION.r95Guided / MISSION.cepGuided);
  const radii = (pts) => pts.map((p) => p.r).sort((a, b) => a - b);
  const percentile = (pts, q) => radii(pts)[Math.round(q * pts.length) - 1];
  const cep = (pts) => (radii(pts)[n / 2 - 1] + radii(pts)[n / 2]) / 2; // median miss distance
  const guided = draw(MISSION.cepGuided, shape, 0.985);
  const unguided = draw(MISSION.cepUnguided, 2, 0.99); // Rayleigh
  return { guided, unguided, cepGuided: cep(guided), cepUnguided: cep(unguided), r95: percentile(guided, 0.95) };
}

const DISP_SIZE = 440, DISP_RMAX = 300; // logical px, metres at the outer ring

function drawDispersion(canvas, C, mc, progress) {
  const ctx = fitCanvas(canvas, DISP_SIZE, DISP_SIZE);
  const c = DISP_SIZE / 2, R = 196;
  const rp = (m) => R * Math.sqrt(m / DISP_RMAX); // √r keeps the 15 / 30 m rings readable
  const font = (px, weight = 400) => `${weight} ${px}px ${C.mono}`;
  const ring = (m, color, width, dash = []) => {
    ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.arc(c, c, rp(m), 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
  };

  /* reticle */
  ctx.strokeStyle = 'rgba(160, 200, 230, 0.12)'; ctx.lineWidth = 1;
  for (let a = 0; a < 12; a++) {
    const s = Math.sin(a * TAU / 12), k = Math.cos(a * TAU / 12);
    const r0 = a % 3 === 0 ? 0 : rp(30);
    ctx.beginPath(); ctx.moveTo(c + s * r0, c - k * r0); ctx.lineTo(c + s * R, c - k * R); ctx.stroke();
  }
  for (let a = 0; a < 72; a++) {
    const s = Math.sin(a * TAU / 72), k = Math.cos(a * TAU / 72);
    const len = a % 6 === 0 ? 7 : 3;
    ctx.beginPath(); ctx.moveTo(c + s * R, c - k * R); ctx.lineTo(c + s * (R + len), c - k * (R + len)); ctx.stroke();
  }
  ring(300, 'rgba(160, 200, 230, 0.3)', 1);
  ring(200, 'rgba(160, 200, 230, 0.14)', 1, [2, 4]);
  ctx.fillStyle = 'rgba(0, 229, 255, 0.07)';
  ctx.beginPath(); ctx.arc(c, c, rp(30), 0, TAU); ctx.fill();
  ring(100, C.red, 1.3);
  ctx.save();
  ctx.shadowColor = C.cyan; ctx.shadowBlur = 10;
  ring(30, C.cyan, 1.8);
  ctx.restore();
  ring(15, C.emerald, 1.3);

  ctx.font = font(8.5); ctx.fillStyle = C.muted;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('DOWNRANGE +', c, 3);
  ctx.save(); ctx.translate(DISP_SIZE - 9, c); ctx.rotate(Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText('CROSSRANGE +', 0, 0); ctx.restore();

  /* impacts, revealed run by run (unguided and guided interleaved) */
  const shown = Math.floor(progress * MISSION.runs);
  const pos = (p) => {
    const k = p.r > 0 ? rp(p.r) / p.r : 0;
    return [c + p.x * k, c - p.y * k];
  };
  ctx.strokeStyle = C.amber; ctx.lineWidth = 1.2;
  mc.unguided.slice(0, Math.ceil(shown / 2)).forEach((p) => {
    const [x, y] = pos(p);
    ctx.beginPath(); ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3); ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3); ctx.stroke();
  });
  ctx.save();
  ctx.shadowColor = C.cyan; ctx.shadowBlur = 6; ctx.fillStyle = C.cyan;
  mc.guided.slice(0, Math.floor(shown / 2)).forEach((p) => {
    const [x, y] = pos(p);
    ctx.beginPath(); ctx.arc(x, y, 2.2, 0, TAU); ctx.fill();
  });
  ctx.restore();

  /* ring labels along the lower-right diagonal, drawn over the points */
  ctx.font = font(9, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const tag = (m, text, color) => {
    const d = rp(m) * Math.SQRT1_2;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(3, 6, 10, 0.85)';
    ctx.fillRect(c + d + 2, c + d - 2, tw + 6, 13);
    ctx.fillStyle = color;
    ctx.fillText(text, c + d + 5, c + d + 5);
  };
  tag(15, '15 m', C.emerald);
  tag(30, '30 m · CEP SPEC', C.cyan);
  tag(100, '100 m · BASELINE', C.red);
  tag(200, '200 m', C.muted);

  /* legend */
  ctx.font = font(9); ctx.textBaseline = 'middle';
  ctx.strokeStyle = C.amber; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(9, DISP_SIZE - 27); ctx.lineTo(15, DISP_SIZE - 21); ctx.moveTo(15, DISP_SIZE - 27); ctx.lineTo(9, DISP_SIZE - 21); ctx.stroke();
  ctx.fillStyle = C.dim;
  ctx.fillText('UNGUIDED ×50', 22, DISP_SIZE - 23.5);
  ctx.fillStyle = C.cyan;
  ctx.beginPath(); ctx.arc(12, DISP_SIZE - 10, 2.4, 0, TAU); ctx.fill();
  ctx.fillStyle = C.dim;
  ctx.fillText('GUIDED ×50', 22, DISP_SIZE - 9.5);
}

function initTrajectoryModal($, sfx) {
  const modal = $('modalTrajectory');
  const C = plotPalette();
  const mc = monteCarloImpacts();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const DRAW_MS = 1800;
  let raf = 0, progress = 1;

  const pass = mc.cepGuided <= MISSION.cepSpec;
  $('mcRuns').textContent = `${MISSION.runs} Monte Carlo runs`;
  $('mcGuided').innerHTML = `${mc.cepGuided.toFixed(1)} m <span class="${pass ? 'pass' : 'fail'}">(${pass ? 'PASS' : 'FAIL'} ≤ ${MISSION.cepSpec} m)</span>`;
  $('mcUnguided').textContent = `${mc.cepUnguided.toFixed(1)} m`;
  $('mcR95').textContent = `${mc.r95.toFixed(1)} m`;

  const draw = () => {
    drawTrajectory($('cvTrajectory'), C, progress);
    drawDispersion($('cvDispersion'), C, mc, progress);
  };
  const play = () => {
    cancelAnimationFrame(raf);
    if (reduceMotion.matches) { progress = 1; draw(); return; }
    const t0 = performance.now();
    const tick = (now) => {
      progress = clamp((now - t0) / DRAW_MS, 0, 1);
      draw();
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  const openModal = () => {
    try {
      if (typeof modal.showModal === 'function') {
        if (!modal.open) modal.showModal();
      } else {
        modal.setAttribute('open', '');
      }
    } catch {
      modal.setAttribute('open', '');
    }
    play();
  };

  const closeModal = () => {
    try {
      if (typeof modal.close === 'function') {
        if (modal.open) modal.close();
      } else {
        modal.removeAttribute('open');
      }
    } catch {
      modal.removeAttribute('open');
    }
  };

  $('btnTrajectory').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sfx.click();
    openModal();
  });
  $('btnTrajectoryClose').addEventListener('click', (e) => {
    e.preventDefault();
    sfx.click();
    closeModal();
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); }); // backdrop
  modal.addEventListener('close', () => cancelAnimationFrame(raf));
  window.addEventListener('resize', () => { if (modal.open || modal.hasAttribute('open')) draw(); });
}

function initArchitectureModal($, sfx) {
  const modal = $('modalArchitecture');
  if (!modal) return;

  const openModal = () => {
    try {
      if (typeof modal.showModal === 'function') {
        if (!modal.open) modal.showModal();
      } else {
        modal.setAttribute('open', '');
      }
    } catch {
      modal.setAttribute('open', '');
    }
  };

  const closeModal = () => {
    try {
      if (typeof modal.close === 'function') {
        if (modal.open) modal.close();
      } else {
        modal.removeAttribute('open');
      }
    } catch {
      modal.removeAttribute('open');
    }
  };

  $('btnArchitecture')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sfx.click();
    openModal();
  });
  $('btnArchitectureClose')?.addEventListener('click', (e) => {
    e.preventDefault();
    sfx.click();
    closeModal();
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
}

function initAvionics($, sfx, toast) {
  const C_LIGHT = 299792458;
  const FMCW = { bandwidth: 250e6, chirp: 1e-3 }; // 24.00 – 24.25 GHz sweep, 1 ms ramp
  const LINK_STEP_MS = 300; // 4 steps → 1.2 s
  const GATE_T = [null, 0.0, 1.2, 36.0, 55.0]; // s after launch; SAFE has no time
  const IMPACT_DELAY_MS = 25;
  const cfg = { mode: 'prox', hob: 5.0, timerMs: 71350, impact: 'inst', locked: false, busy: false, gate: 0 };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const linkSteps = [...$('linkSteps').children];
  const gateEls = [...$('gates').children];
  const gateSegs = [...$('gateBar').children];

  const summary = () => ({
    prox: `PROXIMITY · HOB ${cfg.hob.toFixed(1)} m`,
    time: `TIME DELAY · ${(cfg.timerMs / 1000).toFixed(3)} s`,
    impact: `IMPACT · ${cfg.impact === 'inst' ? 'INSTANTANEOUS' : `DELAY ${IMPACT_DELAY_MS} ms`}`,
  })[cfg.mode];

  const setGate = (i) => {
    cfg.gate = i;
    [gateEls, gateSegs].forEach((els) => els.forEach((el, k) => {
      el.classList.toggle('passed', k < i);
      el.classList.toggle('active', k === i);
    }));
    $('missionClock').textContent = i === 0 ? 'T−' : `T+${GATE_T[i].toFixed(1)} s`;
  };

  const setLocked = (locked) => {
    cfg.locked = locked;
    $('cfgBadge').textContent = locked ? 'LOCKED' : 'NO CONFIG';
    $('cfgBadge').classList.toggle('locked', locked);
    $('btnSequence').disabled = !locked;
    $('btnSequence').textContent = '▶ Simulate flight sequence';
    if (!locked) {
      linkSteps.forEach((li) => { li.className = ''; });
      $('linkBar').style.width = '0';
    }
    setGate(0);
  };

  const render = () => {
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === cfg.mode)));
    document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== cfg.mode; });
    document.querySelectorAll('[data-impact]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.impact === cfg.impact)));
    $('hobVal').textContent = `${cfg.hob.toFixed(1)} m AGL`;
    $('fmcwRes').textContent = `${(C_LIGHT / (2 * FMCW.bandwidth)).toFixed(2)} m`;
    $('fmcwBeat').textContent = `${((2 * cfg.hob * FMCW.bandwidth) / (C_LIGHT * FMCW.chirp) / 1000).toFixed(2)} kHz`;
    $('fmcwDelay').textContent = `${((2 * cfg.hob) / C_LIGHT * 1e9).toFixed(1)} ns`;
    $('timerVal').textContent = `T+${(cfg.timerMs / 1000).toFixed(3)} s`;
    $('impactVal').textContent = cfg.impact === 'inst' ? '0 ms · instantaneous' : `${IMPACT_DELAY_MS} ms · delayed`;
  };

  // any edit after programming invalidates the stored configuration and drops back to SAFE
  const change = (patch) => {
    Object.assign(cfg, patch);
    if (cfg.locked) { setLocked(false); toast('Configuration changed — inductive re-programming required'); }
    render();
  };

  document.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => { sfx.click(); change({ mode: b.dataset.mode }); }));
  document.querySelectorAll('[data-impact]').forEach((b) =>
    b.addEventListener('click', () => { sfx.click(); change({ impact: b.dataset.impact }); }));
  $('hobSlider').addEventListener('input', (e) => change({ hob: Number(e.target.value) }));
  $('timerInput').addEventListener('input', (e) => {
    const ms = Math.round(Number(e.target.value));
    if (Number.isFinite(ms)) change({ timerMs: clamp(ms, 0, 199999) });
  });
  $('timerInput').addEventListener('change', (e) => { e.target.value = cfg.timerMs; });

  $('btnInductive').addEventListener('click', async () => {
    if (cfg.busy) return;
    cfg.busy = true;
    setLocked(false);
    $('btnInductive').disabled = true;
    $('avConfig').disabled = true;
    for (let i = 0; i < linkSteps.length; i++) {
      linkSteps[i].className = 'run';
      $('linkBar').style.width = `${((i + 1) / linkSteps.length) * 100}%`;
      sfx.servo();
      await wait(LINK_STEP_MS);
      linkSteps[i].className = 'ok';
    }
    cfg.busy = false;
    $('btnInductive').disabled = false;
    $('avConfig').disabled = false;
    setLocked(true);
    sfx.latch();
    toast(`Inductive link OK · ${summary()} locked`);
  });

  $('btnSequence').addEventListener('click', async () => {
    if (cfg.busy || !cfg.locked) return;
    sfx.click();
    if (cfg.gate > 0) { setGate(0); $('btnSequence').textContent = '▶ Simulate flight sequence'; return; }
    cfg.busy = true;
    $('btnSequence').disabled = true;
    $('btnInductive').disabled = true;
    $('avConfig').disabled = true;
    for (let i = 1; i < gateEls.length; i++) {
      await wait(700);
      setGate(i);
      sfx.servo();
    }
    cfg.busy = false;
    $('btnSequence').disabled = false;
    $('btnInductive').disabled = false;
    $('avConfig').disabled = false;
    $('btnSequence').textContent = '↺ Reset to SAFE';
    toast(`Terminal ready · ${summary()}`);
  });

  render();
  setGate(0);
}

boot();
