(() => {
const $ = (s) => document.querySelector(s);
const canvas = $('#c');
const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
const fail = () => { $('#nogl').hidden = false; };
if (!gl || !gl.getExtension('EXT_color_buffer_float')) { fail(); return; }
const hasFloatBlend = !!gl.getExtension('EXT_float_blend');
const ACCUM_FORMAT = hasFloatBlend ? gl.RGBA32F : gl.RGBA16F;
const MAX_SIDE = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
const BAND_PIXELS = 700000;           // pixels shaded per animation frame (keeps the GPU watchdog happy)

// ---------- GL helpers ----------
function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}
function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const cache = {};
  p.u = (n) => (n in cache ? cache[n] : (cache[n] = gl.getUniformLocation(p, n)));
  return p;
}
const traceProg = program(VERT, FRAG_TRACE);
const dispProg = program(VERT, FRAG_DISPLAY);
const vao = gl.createVertexArray();

// ---------- State ----------
const FORMULAS = [
  { name: 'Apollonian (sphere packing)', iter: 9, steps: 220,
    params: [{ label: 'Inversion scale', min: 0.9, max: 1.5, step: 0.001, def: 1.1 }],
    cam: { yaw: 0.6, pitch: 0.25, dist: 3.0, target: [0, 0, 0] } },
  { name: 'Kleinian (box fold + inversion)', iter: 12, steps: 300,
    params: [
      { label: 'Inversion size', min: 0.6, max: 1.4, step: 0.001, def: 1.0 },
      { label: 'Box fold X/Z', min: 0.5, max: 1.2, step: 0.0005, def: 0.92436 },
      { label: 'Box fold Y', min: 0.5, max: 1.2, step: 0.0005, def: 0.90756 },
      { label: 'Cylinder radius', min: 1.0, max: 2.4, step: 0.001, def: 1.94 },
    ],
    cam: { yaw: 0.3, pitch: 0.3, dist: 0.15, target: [0, 0, 0] } },
];
const LOOK_DEFAULT = {
  fov: 55, aperture: 0.03, focus: 1.0,
  ao: 1.0, aoRad: 0.04, fog: 0.6, light: 1.6, shadow: 1.0, lightYaw: 40, lightPitch: 50,
  colA: '#8a3340', colB: '#ffc24a', colC: '#3f7fd0', bgTop: '#e8b8b8', bgBot: '#2d62a8',
  exposure: 1.4, grain: 0.6, vignette: 0.5, sat: 1.1,
  speed: 1.5, autofocus: true,
};
const s = { formula: 1, p: [], iter: 12, steps: 300, ...LOOK_DEFAULT, res: 1, target: 400 };
// Free-flight camera (ship): position + orthonormal fwd/up. `dist` is a length scale that follows the
// distance estimate at the ship so fog / AO / DOF keep their look when you dive in. `hit` = distance to the
// surface in the middle of the screen (used for auto-focus).
const cam = { pos: [0, 0, 1], fwd: [0, 0, -1], up: [0, 1, 0], dist: 1, dist0: 1, de0: 1, de: 1, hit: 1, home: null };

// A preset = formula + optional param/iter/steps/camera overrides + "look" overrides on top of LOOK_DEFAULT.
const PRESETS = [
  { name: 'Default: Rust & Azure', formula: 1 },
  { name: 'Golden Lace', formula: 1, iter: 13,
    cam: { yaw: 1.2, pitch: 0.1, dist: 0.25 },
    look: { colA: '#5a2a12', colB: '#ffd98a', colC: '#ff9c3a', bgTop: '#f4d9a8', bgBot: '#7a3a1a', lightYaw: -60, lightPitch: 35, exposure: 1.5, aperture: 0.02 } },
  { name: 'Ice Cathedral', formula: 1, iter: 14, p: [1.0, 0.9, 0.9, 1.9],
    cam: { yaw: -0.8, pitch: 0.5, dist: 0.3 },
    look: { colA: '#4b6a9c', colB: '#eaf6ff', colC: '#7fd2ff', bgTop: '#e4f2ff', bgBot: '#0c2a58', lightYaw: 120, lightPitch: 60, exposure: 1.3, sat: 0.9, aperture: 0.02 } },
  { name: 'Deep Sea Coral', formula: 1, p: [0.95, 0.93, 0.91, 1.96],
    cam: { yaw: 1.2, pitch: 0.1, dist: 0.25 },
    look: { colA: '#1b5f60', colB: '#ff9068', colC: '#30e6c4', bgTop: '#6fd6c9', bgBot: '#04222c', fog: 0.8, aperture: 0.03, exposure: 1.6 } },
  { name: 'Far Reach (overview)', formula: 1, iter: 14, steps: 400,
    cam: { yaw: 0.6, pitch: 0.35, dist: 1.2 },
    look: { aperture: 0, fog: 0.4, aoRad: 0.02, exposure: 1.2, bgTop: '#c9b3e0' } },
  { name: 'Night Macro', formula: 1,
    cam: { yaw: -0.8, pitch: 0.5, dist: 0.3 },
    look: { colA: '#3a1f4f', colB: '#ff6fa8', colC: '#4c7dff', bgTop: '#2a1740', bgBot: '#050510', aperture: 0.05, focus: 1.0, exposure: 2.4, light: 2.6, vignette: 0.9, grain: 0.9 } },
  { name: 'Sphere Lattice (Apollonian)', formula: 0 },
  { name: 'Apollonian Gold', formula: 0, p: [1.18], iter: 10,
    cam: { yaw: 2.0, pitch: 0.1, dist: 2.2 },
    look: { colA: '#6a3a1c', colB: '#ffd27a', colC: '#c9885a', bgTop: '#f7e2bd', bgBot: '#8b4f2c', exposure: 1.3, aperture: 0.05 } },
];
let currentPreset = 0;

// ---------- UI ----------
const refs = {};
function slider(group, label, key, min, max, step, opts = {}) {
  const row = document.createElement('div'); row.className = 'row';
  const get = opts.get || (() => s[key]);
  const set = opts.set || ((v) => { s[key] = v; });
  row.innerHTML = `<label></label><input type="range"><span class="v"></span>`;
  row.firstChild.textContent = label;
  const inp = row.children[1], val = row.children[2];
  inp.min = min; inp.max = max; inp.step = step; inp.value = get();
  const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
  val.textContent = fmt(+inp.value);
  inp.addEventListener('input', () => { const v = +inp.value; set(v); val.textContent = fmt(v); (opts.display ? needDisplay() : markDirty()); });
  group.appendChild(row);
  return { inp, val };
}
function select(group, label, options, get, set) {
  const row = document.createElement('div'); row.className = 'row sel';
  row.innerHTML = `<label></label><select></select>`;
  row.firstChild.textContent = label;
  const sel = row.children[1];
  options.forEach((o, i) => { const op = document.createElement('option'); op.value = o.value ?? i; op.textContent = o.label; sel.appendChild(op); });
  sel.value = get();
  sel.addEventListener('change', () => { set(sel.value); sel.blur(); });
  group.appendChild(row);
}
function toggle(group, label, key) {
  const row = document.createElement('div'); row.className = 'row sel';
  row.innerHTML = `<label></label><input type="checkbox">`;
  row.firstChild.textContent = label;
  const inp = row.children[1]; inp.checked = !!s[key];
  inp.addEventListener('change', () => { s[key] = inp.checked; inp.blur(); markDirty(); });
  group.appendChild(row);
}
function color(group, label, key) {
  const row = document.createElement('div'); row.className = 'row sel';
  row.innerHTML = `<label></label><input type="color">`;
  row.firstChild.textContent = label;
  const inp = row.children[1]; inp.value = s[key];
  inp.addEventListener('input', () => { s[key] = inp.value; markDirty(); });
  group.appendChild(row);
  refs[key] = inp;
}

const gFractal = $('#g-fractal');
const gParams = document.createElement('div');
function buildFractalUI() {
  gFractal.innerHTML = '';
  select(gFractal, 'Formula', FORMULAS.map((f, i) => ({ label: f.name, value: i })), () => s.formula, (v) => setFormula(+v));
  slider(gFractal, 'Iterations', 'iter', 2, 20, 1);
  gParams.innerHTML = '';
  FORMULAS[s.formula].params.forEach((q, i) =>
    slider(gParams, q.label, null, q.min, q.max, q.step, { get: () => s.p[i], set: (v) => { s.p[i] = v; } }));
  gFractal.appendChild(gParams);
  slider(gFractal, 'Max steps', 'steps', 50, 800, 10);
}
function setFormula(i) {   // manual formula switch from the dropdown: keeps the current look
  s.formula = i;
  const f = FORMULAS[i];
  s.p = f.params.map((q) => q.def); s.iter = f.iter; s.steps = f.steps;
  setCamFromOrbit(f.cam);
  buildFractalUI(); markDirty();
}

function applyPreset(i, full) {
  const pr = PRESETS[i], f = FORMULAS[pr.formula];
  Object.assign(s, LOOK_DEFAULT, pr.look || {});
  if (full) { s.res = 1; s.target = 400; }
  s.formula = pr.formula;
  s.p = pr.p ? [...pr.p] : f.params.map((q) => q.def);
  s.iter = pr.iter ?? f.iter; s.steps = pr.steps ?? f.steps;
  setCamFromOrbit({ ...f.cam, ...(pr.cam || {}) });
  currentPreset = i;
  buildUI(); markDirty();
}

const gPresets = $('#g-presets');
function buildPresetUI() {
  gPresets.innerHTML = '';
  select(gPresets, 'Preset', PRESETS.map((p, i) => ({ label: p.name, value: i })), () => currentPreset, (v) => applyPreset(+v, false));
  const row = document.createElement('div'); row.className = 'row buttons';
  row.innerHTML = '<button>Reset to default</button>';
  row.firstChild.onclick = () => applyPreset(0, true);
  gPresets.appendChild(row);
}

function buildUI() {
buildPresetUI();
buildFractalUI();

const gCam = $('#g-camera'); gCam.innerHTML = '';
refs.speed = slider(gCam, 'Fly speed', 'speed', 0.05, 8, 0.01, { display: true });
slider(gCam, 'Field of view', 'fov', 15, 110, 1);
slider(gCam, 'Aperture (DOF)', 'aperture', 0, 1, 0.002);
toggle(gCam, 'Auto-focus', 'autofocus');
slider(gCam, 'Focus (×)', 'focus', 0.05, 3, 0.005);

const gLight = $('#g-light'); gLight.innerHTML = '';
slider(gLight, 'Key light', 'light', 0, 3, 0.01);
slider(gLight, 'Light azimuth', 'lightYaw', -180, 180, 1);
slider(gLight, 'Light height', 'lightPitch', 0, 90, 1);
slider(gLight, 'Shadows', 'shadow', 0, 1, 0.01);
slider(gLight, 'Occlusion', 'ao', 0, 2, 0.01);
slider(gLight, 'Occl. radius', 'aoRad', 0.002, 0.3, 0.001);
slider(gLight, 'Fog', 'fog', 0, 4, 0.01);
color(gLight, 'Body', 'colA'); color(gLight, 'Rim / gold', 'colB'); color(gLight, 'Accent', 'colC');
color(gLight, 'Sky top', 'bgTop'); color(gLight, 'Sky bottom', 'bgBot');

const gFilm = $('#g-film'); gFilm.innerHTML = '';
slider(gFilm, 'Exposure', 'exposure', 0.2, 3, 0.01, { display: true });
slider(gFilm, 'Saturation', 'sat', 0, 1.8, 0.01, { display: true });
slider(gFilm, 'Grain', 'grain', 0, 2, 0.01, { display: true });
slider(gFilm, 'Vignette', 'vignette', 0, 1.5, 0.01, { display: true });

const gRender = $('#g-render'); gRender.innerHTML = '';
select(gRender, 'Resolution', [{ label: '1× window', value: 1 }, { label: '1.5×', value: 1.5 }, { label: '2×', value: 2 }, { label: '3×', value: 3 }, { label: '4×', value: 4 }],
  () => s.res, (v) => { s.res = +v; markDirty(); });
slider(gRender, 'Target samples', 'target', 1, 4000, 1, { display: true });
}

$('#collapse').onclick = () => $('#panel').classList.toggle('min');
$('#reset-cam').onclick = (e) => {
  e.currentTarget.blur();
  const h = cam.home; if (!h) return;
  Object.assign(cam, { pos: [...h.pos], fwd: [...h.fwd], up: [...h.up], dist0: h.dist0, dist: h.dist0, hit0: h.hit0, hit: h.hit0 });
  markDirty();
};
$('#save').onclick = () => {
  draw(true);
  canvas.toBlob((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `fractal-${canvas.width}x${canvas.height}-${pass}spp.png`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
};

// ---------- Render targets ----------
let tex = null, fbo = null, tw = 0, th = 0, outW = 0, outH = 0;
let pass = 0, band = 0, dirty = true, redraw = true, lastInteract = -1e9, curScale = 1;

function allocTarget(w, h) {
  if (tex) { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); }
  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, ACCUM_FORMAT, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  tw = w; th = h;
}
function fitSizes(scale) {
  const dpr = window.devicePixelRatio || 1;
  let w = Math.max(16, Math.floor(innerWidth * dpr * s.res));
  let h = Math.max(16, Math.floor(innerHeight * dpr * s.res));
  const k = Math.min(1, MAX_SIDE / Math.max(w, h)); w = Math.floor(w * k); h = Math.floor(h * k);
  if (w !== outW || h !== outH) { canvas.width = outW = w; canvas.height = outH = h; }
  const w2 = Math.max(16, Math.floor(w * scale)), h2 = Math.max(16, Math.floor(h * scale));
  if (w2 !== tw || h2 !== th) { allocTarget(w2, h2); return true; }
  return false;
}

function markDirty() { dirty = true; redraw = true; lastInteract = performance.now(); }
function needDisplay() { redraw = true; }
window.addEventListener('resize', markDirty);

// ---------- Camera: free flight ----------
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const rot = (v, ax, ang) => {   // Rodrigues rotation of v around unit axis ax
  const c = Math.cos(ang), sn = Math.sin(ang), d = dot(ax, v), cr = cross(ax, v);
  return v.map((x, i) => x * c + cr[i] * sn + ax[i] * d * (1 - c));
};
const fr = (x) => x - Math.floor(x);

// CPU copy of the shader's distance estimator (distance only, no orbit trap).
function de(p) {
  let x = p[0], y = p[1], z = p[2], sc = 1;
  const n = s.iter, q = s.p;
  if (s.formula === 0) {
    for (let i = 0; i < n; i++) {
      x = -1 + 2 * fr(0.5 * x + 0.5); y = -1 + 2 * fr(0.5 * y + 0.5); z = -1 + 2 * fr(0.5 * z + 0.5);
      const k = q[0] / Math.max(x * x + y * y + z * z, 1e-30);
      x *= k; y *= k; z *= k; sc *= k;
    }
    return 0.25 * Math.abs(y) / sc;
  }
  const cx = q[1], cy = q[2];
  for (let i = 0; i < n; i++) {
    x = 2 * Math.max(-cx, Math.min(cx, x)) - x;
    y = 2 * Math.max(-cy, Math.min(cy, y)) - y;
    z = 2 * Math.max(-cx, Math.min(cx, z)) - z;
    const k = Math.max(q[0] / Math.max(x * x + y * y + z * z, 1e-30), 1);
    x *= k; y *= k; z *= k; sc *= k;
  }
  const rxy = Math.hypot(x, y);
  return 0.7 * Math.max(rxy - q[3], Math.abs(rxy * z) / (Math.hypot(x, y, z) || 1)) / sc;
}

function setCamFromOrbit(c) {   // presets are authored as orbit cameras; convert to a ship pose
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch), t = c.target || [0, 0, 0];
  cam.pos = [t[0] + c.dist * cp * Math.sin(c.yaw), t[1] + c.dist * sp, t[2] + c.dist * cp * Math.cos(c.yaw)];
  cam.fwd = norm(t.map((v, i) => v - cam.pos[i]));
  cam.up = cross(norm(cross(cam.fwd, [0, 1, 0])), cam.fwd);
  cam.dist0 = cam.dist = c.dist;
  const h = rayDist(cam.pos, cam.fwd, 50);
  cam.hit = cam.hit0 = h > 0 ? h : c.dist;
  cam.home = { pos: [...cam.pos], fwd: [...cam.fwd], up: [...cam.up], dist0: cam.dist0, hit0: cam.hit0 };
}

// Sphere-trace from `pos` along `dir`; returns the distance to the surface, or -1 if nothing within maxT.
function rayDist(pos, dir, maxT) {
  const f = 0.5 / Math.tan((s.fov * Math.PI / 180) / 2);
  const pix = 1 / (Math.max(outH, 64) * f);
  let t = 0;
  for (let i = 0; i < 300; i++) {
    const d = de([pos[0] + dir[0] * t, pos[1] + dir[1] * t, pos[2] + dir[2] * t]);
    if (d < t * pix * 0.5 + 1e-7) return t;
    t += d * 0.95;
    if (t > maxT) break;
  }
  return -1;
}

function updateCamInfo() {
  cam.de = Math.max(de(cam.pos), 1e-7);
  const h = rayDist(cam.pos, cam.fwd, 50);
  cam.hit = h > 0 ? h : cam.hit;          // looking at the sky: keep the last focus distance
  // length scale for fog / AO / DOF: follows how far the surface under the crosshair is, relative to the preset's view
  cam.dist = Math.max(1e-6, cam.dist0 * cam.hit / cam.hit0);
}

function basis() { return { pos: cam.pos, fwd: cam.fwd, up: cam.up, right: norm(cross(cam.fwd, cam.up)) }; }

function turn(yaw, pitch, roll) {
  if (yaw) cam.fwd = rot(cam.fwd, cam.up, yaw);
  if (pitch) {
    const right = norm(cross(cam.fwd, cam.up));
    cam.fwd = rot(cam.fwd, right, pitch); cam.up = rot(cam.up, right, pitch);
  }
  if (roll) cam.up = rot(cam.up, cam.fwd, roll);
  cam.fwd = norm(cam.fwd);
  cam.up = norm(cam.up.map((x, i) => x - cam.fwd[i] * dot(cam.up, cam.fwd)));
}
function levelHorizon() {
  const w = [0, 1, 0];
  const u = w.map((x, i) => x - cam.fwd[i] * dot(w, cam.fwd));
  if (Math.hypot(...u) > 1e-4) cam.up = norm(u);
}

const keys = new Set();
const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC', 'KeyX', 'Space',
  'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
addEventListener('keydown', (e) => {
  if (!FLY_KEYS.has(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
  const inForm = ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(e.target.tagName);
  if (inForm && (e.code === 'Space' || e.code.startsWith('Arrow'))) return;   // let widgets keep those
  e.preventDefault();
  if (e.code === 'KeyX' && !e.repeat) { levelHorizon(); markDirty(); }
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function stepFly(dt) {
  const k = (c) => (keys.has(c) ? 1 : 0);
  const yaw = k('ArrowLeft') - k('ArrowRight'), pitch = k('ArrowUp') - k('ArrowDown'), roll = k('KeyQ') - k('KeyE');
  const mf = k('KeyW') - k('KeyS'), mr = k('KeyD') - k('KeyA'), mu = k('Space') - k('KeyC');
  if (!(yaw || pitch || roll || mf || mr || mu)) return false;

  const turnRate = 1.3 * dt * (s.fov / 55);
  turn(yaw * turnRate, pitch * turnRate, roll * 1.4 * dt);

  if (mf || mr || mu) {
    const b = basis();
    const dir = norm([0, 1, 2].map((i) => b.fwd[i] * mf + b.right[i] * mr + b.up[i] * mu));
    const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
    // Speed is proportional to the free distance in the direction of travel, so you can dive forever
    // without crashing; a step never exceeds 40% of that distance, so you can't tunnel through geometry.
    let ahead = rayDist(cam.pos, dir, 3);
    if (ahead < 0) ahead = 3;
    const step = Math.min(s.speed * boost * ahead * dt, 0.4 * ahead);
    if (ahead > 2e-6) for (let i = 0; i < 3; i++) cam.pos[i] += dir[i] * step;
  }
  return true;
}

// Mouse: drag to look. Wheel changes fly speed.
let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY }; document.activeElement?.blur?.(); });
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  const sens = 0.0025 * (s.fov / 55);
  turn(-dx * sens, -dy * sens, 0);
  markDirty();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  s.speed = Math.max(0.05, Math.min(8, s.speed * Math.exp(-e.deltaY * 0.001)));
  if (refs.speed) { refs.speed.inp.value = s.speed; refs.speed.val.textContent = s.speed.toFixed(2); }
}, { passive: false });

const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.pow(v / 255, 2.2)); };

// ---------- Rendering ----------
function renderBand(preview) {
  const bands = Math.max(1, Math.ceil((tw * th) / BAND_PIXELS));
  if (band >= bands) band = 0;
  const bh = Math.ceil(th / bands);
  const b = basis();
  const f = 0.5 / Math.tan((s.fov * Math.PI / 180) / 2);
  const ly = s.lightYaw * Math.PI / 180, lp = s.lightPitch * Math.PI / 180;

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, tw, th);
  gl.enable(gl.SCISSOR_TEST); gl.scissor(0, band * bh, tw, bh);
  gl.enable(gl.BLEND);
  gl.blendColor(0, 0, 0, 1 / (pass + 1));
  gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);

  const P = traceProg; gl.useProgram(P);
  gl.uniform2f(P.u('u_res'), tw, th);
  gl.uniform1i(P.u('u_frame'), pass);
  gl.uniform1i(P.u('u_formula'), s.formula);
  gl.uniform1i(P.u('u_iter'), s.iter);
  gl.uniform1i(P.u('u_steps'), preview ? Math.min(s.steps, 140) : s.steps);
  gl.uniform1i(P.u('u_preview'), preview ? 1 : 0);
  const pp = [...s.p, 0, 0, 0, 0].slice(0, 4);
  gl.uniform4f(P.u('u_p'), pp[0], pp[1], pp[2], pp[3]);
  gl.uniform3fv(P.u('u_ro'), b.pos); gl.uniform3fv(P.u('u_right'), b.right);
  gl.uniform3fv(P.u('u_up'), b.up); gl.uniform3fv(P.u('u_fwd'), b.fwd);
  gl.uniform1f(P.u('u_f'), f);
  gl.uniform1f(P.u('u_pix'), 1 / (th * f));
  gl.uniform1f(P.u('u_aperture'), s.aperture * cam.dist * 0.04);
  gl.uniform1f(P.u('u_focus'), s.focus * (s.autofocus ? cam.hit : cam.dist));
  gl.uniform1f(P.u('u_dist'), cam.dist);
  gl.uniform1f(P.u('u_ao'), s.ao);
  gl.uniform1f(P.u('u_aoRad'), s.aoRad * cam.dist);
  gl.uniform1f(P.u('u_fog'), s.fog);
  gl.uniform1f(P.u('u_light'), s.light);
  gl.uniform1f(P.u('u_shadow'), s.shadow);
  gl.uniform3f(P.u('u_lightDir'), Math.cos(lp) * Math.sin(ly), Math.sin(lp), Math.cos(lp) * Math.cos(ly));
  gl.uniform3fv(P.u('u_colA'), hex(s.colA)); gl.uniform3fv(P.u('u_colB'), hex(s.colB)); gl.uniform3fv(P.u('u_colC'), hex(s.colC));
  gl.uniform3fv(P.u('u_bgTop'), hex(s.bgTop)); gl.uniform3fv(P.u('u_bgBot'), hex(s.bgBot));
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);

  if (++band >= bands) { band = 0; pass++; }
}

function draw() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, outW, outH);
  gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
  const P = dispProg; gl.useProgram(P);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(P.u('u_tex'), 0);
  gl.uniform2f(P.u('u_out'), outW, outH);
  gl.uniform1f(P.u('u_exposure'), s.exposure);
  gl.uniform1f(P.u('u_grain'), s.grain);
  gl.uniform1f(P.u('u_vignette'), s.vignette);
  gl.uniform1f(P.u('u_sat'), s.sat);
  gl.uniform1f(P.u('u_seed'), 0);
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

const status = $('#status');
let lastT = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  if (stepFly(dt)) markDirty();
  const interacting = now - lastInteract < 180;
  const scale = interacting ? 0.35 : 1;
  if (fitSizes(scale)) dirty = true;
  if (dirty) { updateCamInfo(); pass = 0; band = 0; dirty = false; }
  if (interacting || pass < s.target) { renderBand(interacting); redraw = true; }
  if (redraw) { draw(); redraw = false; }
  const info = interacting ? 'moving' : `${Math.min(pass, s.target)} / ${s.target} samples`;
  status.textContent = `${outW}×${outH}${hasFloatBlend ? '' : ' (16-bit accum)'} · ${info} · focus ${cam.hit.toExponential(1)}${cam.hit < 3e-6 ? ' (precision limit)' : ''}`;
}
applyPreset(0, true);   // default: Kleinian, closest to the reference image
requestAnimationFrame(loop);
})();
