/* ASCII World — a layered glyph renderer.
 *
 * The scene is built back-to-front in parallax layers, each with its own
 * brightness band and glyph language. That is what makes a text landscape read
 * as depth instead of as texture: distant things are sparse and dim, near things
 * are dense and bright, and the horizon is a silhouette against empty sky.
 *
 * Rendering stays cheap: cells are written into two typed arrays, then each row
 * is emitted as contiguous runs per brightness level — a few hundred fillText
 * calls for several thousand cells.
 */
(() => {
  const canvas = document.getElementById('world');
  const ctx = canvas.getContext('2d', { alpha: false });
  const screenEl = document.getElementById('screen');

  const MAXL = 15;

  const state = {
    cols: 150, rows: 56, cellW: 8.5, cellH: 14, fs: 13,
    camX: 0, epaper: false, paused: false,
    seed: 1337, tod: 'night',
    fps: 60, frames: 0, lastFps: 0,
    runs: 0, cells: 0, entities: 0,
  };

  const world = { width: 16384, bladesPerCol: 24, ground: 0, horizon: 0 };

  const player = { x: 1200, vx: 0, speed: 7.4, anim: 0, facing: 1 };

  /* ------------------------------------------------------------ hash + noise */
  function hash(n) { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); }
  function hash2(x, y) { const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return n - Math.floor(n); }
  const smooth = (t) => t * t * (3 - 2 * t);
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi);
    const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
  }
  function fbm(x, y, oct = 4) {
    let v = 0, amp = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { v += vnoise(x * f, y * f) * amp; amp *= 0.5; f *= 2; }
    return v;
  }

  /* ---------------------------------------------------------------- palette */
  const TOD = {
    night: { hue: 145, sat: 62, sky: 1, stars: 1.0, fireflies: 1.0, clouds: 0.35, moon: 1, label: 'night' },
    dawn:  { hue: 96,  sat: 48, sky: 2, stars: 0.25, fireflies: 0.25, clouds: 0.7, moon: 0.4, label: 'dawn' },
    day:   { hue: 138, sat: 38, sky: 3, stars: 0, fireflies: 0, clouds: 1.0, moon: 0, label: 'day' },
    dusk:  { hue: 178, sat: 55, sky: 2, stars: 0.5, fireflies: 0.7, clouds: 0.6, moon: 0.7, label: 'dusk' },
  };
  const tod = () => TOD[state.tod] || TOD.night;

  function style(level, maxLevel = MAXL) {
    if (state.epaper) {
      const ink = level > maxLevel * 0.5 ? '#15170f' : level > maxLevel * 0.25 ? 'rgba(21,23,15,.6)' : 'rgba(21,23,15,.3)';
      return ink;
    }
    const p = tod();
    const a = 0.16 + (level / maxLevel) * 0.84;
    const light = 34 + (level / maxLevel) * 42;
    return `hsla(${p.hue}, ${p.sat}%, ${light}%, ${a.toFixed(3)})`;
  }

  /* ------------------------------------------------------------------ grid */
  let GW = 0, GH = 0;
  let gCh = null, gLv = null;

  function clearGrid() {
    gLv.fill(0);
    gCh.fill(32);
  }

  function put(x, y, ch, lvl) {
    if (x < 0 || y < 0 || x >= GW || y >= GH) return;
    const i = y * GW + x;
    if (lvl >= gLv[i]) { gLv[i] = Math.min(MAXL, lvl); gCh[i] = ch.charCodeAt ? ch.charCodeAt(0) : ch; }
  }

  /* ----------------------------------------------------------------- font */
  function fontRatio() {
    ctx.font = '100px ui-monospace, monospace';
    return (ctx.measureText('M').width || 60) / 100;
  }
  const RATIO = fontRatio();

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = screenEl.getBoundingClientRect();
    canvas.width = Math.floor(r.width * dpr);
    canvas.height = Math.floor(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (state.epaper) {
      state.cols = 49; state.rows = 16;
      state.cellW = r.width / state.cols;
      state.cellH = r.height / state.rows;
    } else {
      state.cellW = 8.6; state.cellH = 14;
      state.cols = Math.max(40, Math.floor(r.width / state.cellW));
      state.rows = Math.max(16, Math.floor(r.height / state.cellH));
      state.cellW = r.width / state.cols;
      state.cellH = r.height / state.rows;
    }
    state.fs = state.cellW / RATIO;

    GW = state.cols; GH = state.rows;
    gCh = new Uint16Array(GW * GH);
    gLv = new Uint8Array(GW * GH);

    world.horizon = Math.round(GH * (state.epaper ? 0.58 : 0.62));
    world.ground = world.horizon;
    state.cells = GW * GH;

    ctx.textBaseline = 'top';
    ctx.font = `${state.fs}px ui-monospace, monospace`;
    if (state.epaper) drawScene(performance.now() / 1000);
  }

  /* ------------------------------------------------------------- sky layers */
  function drawStars(t) {
    const p = tod();
    if (p.stars <= 0.01) return;
    const n = Math.floor(GW * 0.9 * p.stars);
    for (let s = 0; s < n; s++) {
      const x = Math.floor(hash(s * 3.77 + state.seed) * GW);
      const y = Math.floor(hash(s * 9.13 + state.seed) * (world.horizon - 2));
      const tw = 0.5 + 0.5 * Math.sin(t * (0.6 + hash(s) * 1.8) + s);
      if (tw < 0.35) continue;
      const lvl = tw > 0.8 ? 4 : tw > 0.55 ? 3 : 2;
      put(x, y, tw > 0.85 ? '*' : '·', Math.round(lvl * p.stars));
    }
  }

  function drawMoon(t) {
    const p = tod();
    if (p.moon <= 0.05) return;
    const mx = Math.floor(GW * 0.79 - (state.camX * 0.01) % GW);
    const my = Math.floor(world.horizon * 0.26);
    const r = state.epaper ? 1 : 3;
    for (let dy = -r - 2; dy <= r + 2; dy++) {
      for (let dx = -r - 2; dx <= r + 2; dx++) {
        const d = Math.hypot(dx, dy);
        if (d <= r) put(mx + dx, my + dy, d < r - 0.6 ? 'O' : 'o', Math.round(9 * p.moon));
        else if (d <= r + 2.2 && hash2(dx * 3 + mx, dy * 3 + my) > 0.45) put(mx + dx, my + dy, '·', Math.round(2 * p.moon));
      }
    }
  }

  function drawClouds(t) {
    const p = tod();
    if (p.clouds <= 0.05 || state.epaper) return;
    for (let b = 0; b < 5; b++) {
      const bandY = Math.floor(world.horizon * (0.12 + b * 0.13));
      const drift = (t * (2.2 + b * 0.9) + state.camX * 0.04 * (b + 1)) % (GW + 60);
      const startX = Math.floor(-30 + drift);
      const len = 14 + Math.floor(hash(b * 7.7 + state.seed) * 22);
      const n = fbm(b * 3.1 + state.seed, 0.4, 2);
      if (n < 0.42) continue;
      for (let i = 0; i < len; i++) {
        const x = startX + i;
        const edge = Math.sin((i / len) * Math.PI);
        if (edge < 0.25) continue;
        const lvl = Math.round((1.6 + edge * 2.4) * p.clouds);
        put(x, bandY, i % 3 === 0 ? '~' : '-', lvl);
        if (edge > 0.6 && hash(i * 1.7 + b) > 0.6) put(x, bandY + 1, '~', Math.max(1, lvl - 1));
      }
    }
  }

  function drawBirds(t) {
    if (state.epaper) return;
    for (let f = 0; f < 3; f++) {
      const speed = 5 + f * 2.5;
      const baseX = ((t * speed + f * 220 + state.seed) % (GW + 80)) - 40;
      const baseY = Math.floor(world.horizon * (0.18 + f * 0.09));
      for (let b = 0; b < 5; b++) {
        const off = Math.sin(t * 1.4 + b) * 2 + b * 3 - 6;
        const flap = Math.sin(t * 7 + b * 1.2) > 0;
        const x = Math.floor(baseX + off);
        const y = baseY + Math.round(Math.cos(b * 0.9) * 2);
        put(x, y, flap ? '/' : '-', 3);
        put(x + 1, y, flap ? '\\' : '-', 3);
      }
    }
  }

  /* --------------------------------------------------------- land silhouettes */
  function ridge(par, freq, base, amp, chBody, chRidge, lvlBody, lvlRidge) {
    const offset = state.camX * par;
    for (let x = 0; x < GW; x++) {
      const wx = (offset + x) * freq + state.seed * 0.01;
      const h = fbm(wx, 0.6, 4);
      const height = Math.max(1, Math.floor((base + h * amp) * world.horizon));
      const top = Math.max(1, world.horizon - height);
      for (let y = top; y < world.horizon; y++) {
        const d = (y - top) / Math.max(1, world.horizon - top);
        // sparse below the ridge: a solid wall of glyphs reads as noise
        const sparse = hash2(x * 1.7, y * 2.3 + state.seed) > 0.42 - d * 0.3;
        if (!sparse) continue;
        const lvl = Math.round(lvlBody + d * 3);
        const glyph = d < 0.35 ? chRidge : chBody;
        put(x, y, glyph, lvl);
      }
      put(x, top, chRidge, lvlRidge);
      if (hash(x * 0.37 + state.seed) > 0.86) put(x, top + 1, '*', lvlRidge);
    }
  }

  function drawForest(t) {
    const par = 0.55;
    const offset = state.camX * par;
    for (let x = -6; x < GW + 6; x += 2) {
      const wx = offset + x;
      const grove = fbm(wx * 0.012, 9.1, 3);
      if (grove < 0.52) continue;
      const h = 4 + Math.floor(hash(wx * 0.71) * 7);
      const top = world.horizon - h;
      // trunk
      for (let y = top + 2; y < world.horizon; y++) put(x, y, '|', 3);
      // canopy: a soft blob, brighter at the top
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const d = Math.hypot(dx, dy * 1.5);
          if (d > 2.4) continue;
          if (hash2((x + dx) * 3.1, (top + dy) * 5.7) > 0.35) {
            put(x + dx, top + dy, d < 1.2 ? 'o' : '*', Math.round(4 + (2 - d)));
          }
        }
      }
    }
  }

  function drawVillage(t) {
    if (state.epaper) return;
    const par = 0.55;
    const offset = state.camX * par;
    for (let k = 0; k < Math.floor(GW / 26); k++) {
      const cx = Math.floor(((hash(k * 4.3 + state.seed) * GW * 1.4 - offset * 0.2) % (GW + 40)) - 20);
      if (fbm((offset + cx) * 0.02, 3.3, 2) < 0.5) continue;
      const w = 3 + Math.floor(hash(k * 8.1) * 3);
      const hgt = 2 + Math.floor(hash(k * 2.9) * 2);
      const baseY = world.horizon - 1;
      for (let i = 0; i < w; i++) {
        put(cx + i, baseY, '_', 5);
        for (let j = 1; j <= hgt; j++) put(cx + i, baseY - j, '|', 4);
      }
      // roof
      for (let i = 0; i <= w; i++) put(cx + i - 1, baseY - hgt - 1, '/', 4);
      put(cx + w, baseY - hgt - 1, '\\', 4);
      // a lit window
      const flick = 0.7 + 0.3 * Math.sin(t * 3 + k);
      put(cx + 1, baseY - 1, '#', Math.round(7 * flick));
      if (w > 3) put(cx + w - 1, baseY - 1, '#', Math.round(6 * flick));
    }
  }

  /* ------------------------------------------------------------- the ground */
  function drawGround(t) {
    const g = world.horizon;
    for (let x = 0; x < GW; x++) {
      const wx = state.camX + x;
      // surface crest
      const bump = Math.floor(fbm(wx * 0.09, 2.2, 2) * 2);
      const surf = g + bump;
      for (let y = surf; y < GH; y++) {
        const d = y - surf;
        let ch = '#', lvl = 6 - Math.min(4, Math.floor(d * 0.7));
        if (d === 0) { ch = '_'; lvl = 7; }
        else if (d === 1) { ch = '#'; lvl = 6; }
        else if ((y + Math.floor(wx / 7)) % 5 === 0) { ch = '-'; lvl = 3; }   // strata
        else if (hash2(wx * 0.9, y * 1.7) > 0.86) { ch = 'O'; lvl = 5; }      // rock
        else if (hash2(wx * 2.1, y * 0.7) > 0.94) { ch = ':', lvl = 3; }      // grit
        put(x, y, ch, lvl);
      }
      // roots
      if (hash(wx * 0.31 + state.seed) > 0.9) {
        put(x, surf + 1, '\\', 4);
        put(x + 1, surf + 2, '\\', 3);
      }
    }
  }

  /* ---------------------------------------------------------------- foliage */
  function blade(x, y, height, level, lean) {
    const stem = Math.abs(lean) < 0.35 ? '|' : lean > 0 ? '/' : '\\';
    for (let i = 0; i < height; i++) {
      const lx = x + Math.round(lean * (i / 2.2));
      put(lx, y - i, i === height - 1 ? (height > 5 ? '*' : stem) : stem, level - (i < height / 2 ? 0 : 1));
    }
  }

  function drawGrass(t) {
    const g = world.horizon;
    for (let x = 0; x < GW; x++) {
      const wx = state.camX + x;
      const density = fbm(wx * 0.05, 0.3, 4);
      const wave = Math.sin(t * 1.7 + wx * 0.06) * 0.8 + Math.sin(t * 0.8 + wx * 0.021) * 0.5;

      // back pass: short, dim, every column
      if (hash(wx * 5.1) > 0.35) {
        const hh = 1 + Math.floor(hash(wx * 2.3) * 2);
        blade(x, g - 1, hh, 3, wave * 0.4);
      }
      // mid pass: clustered tufts
      if (density > 0.42) {
        const n = 1 + Math.floor(hash(wx * 7.7) * 2);
        for (let b = 0; b < n; b++) {
          const j = hash(wx * 3.1 + b * 7.7);
          const hh = 2 + Math.floor(j * 4 * density + 1);
          blade(x + (b - 1), g, hh, 5 + Math.floor(density * 3), wave * (0.7 + j));
        }
      }
      // foreground pass: tall bold blades framing the bottom
      if (hash(wx * 1.13 + state.seed) > 0.955) {
        const hh = 4 + Math.floor(hash(wx * 0.7) * 5);
        blade(x, GH - 1, hh, 3, wave * 1.4);
      }
      // flowers and mushrooms at the crest
      if (hash(wx * 9.13 + state.seed) > 0.988) {
        put(x, g - 3, '*', 8); put(x, g - 2, '|', 4); put(x, g - 1, '|', 3);
        put(x + 1, g - 2, '/', 5);
      }
      if (hash(wx * 4.41) > 0.991) {
        put(x, g, 'o', 6); put(x, g - 1, 'o', 7); put(x, g - 2, '=', 5);
      }
    }
  }

  /* ------------------------------------------------------------------ life */
  const flies = Array.from({ length: 26 }, (_, i) => ({
    x: hash(i * 1.3) * 2000, y: hash(i * 7.7), ph: hash(i * 3.3) * 6.28, sp: 0.4 + hash(i) * 0.9,
  }));

  function drawFireflies(t) {
    const p = tod();
    if (p.fireflies <= 0.02 || state.epaper) return;
    state.entities = 0;
    for (const f of flies) {
      const fx = ((f.x - state.camX * 0.9) % (GW + 20) + GW + 20) % (GW + 20) - 10;
      if (fx < 0 || fx >= GW) continue;
      const fy = world.horizon - 2 - Math.floor(f.y * (GH - world.horizon - 4) * 0.5
        + Math.sin(t * f.sp + f.ph) * 2.5);
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.2 * f.sp + f.ph);
      if (pulse < 0.35) continue;
      const lvl = Math.round((6 + pulse * 8) * p.fireflies);
      put(fx, fy, pulse > 0.8 ? '*' : '·', lvl);
      if (pulse > 0.9) put(fx + 1, fy, '·', Math.round(lvl * 0.6));
      state.entities++;
    }
  }

  function drawMist(t) {
    if (state.epaper) return;
    const y = world.horizon - 1;
    for (let x = 0; x < GW; x++) {
      const wx = state.camX * 0.8 + x;
      const n = Math.sin(wx * 0.09 + t * 0.5) * 0.5 + Math.sin(wx * 0.031 - t * 0.3) * 0.5;
      if (n > 0.55 && hash(x * 1.7 + Math.floor(t)) > 0.6) put(x, y, '~', 2);
    }
  }

  /* -------------------------------------------------------------- character */
  const HAIR = { strands: 14, segs: 3, nodes: [] };
  function initHair(px, py) {
    HAIR.nodes = [];
    for (let s = 0; s < HAIR.strands; s++) {
      const strand = [];
      for (let i = 0; i < HAIR.segs; i++) {
        strand.push({ x: px + (s / (HAIR.strands - 1) - 0.5) * 2.6 - i * 0.2, y: py + i * 0.6, ox: 0, oy: 0, vx: 0, vy: 0 });
      }
      HAIR.nodes.push(strand);
    }
  }

  function stepHair(px, py, t) {
    const wind = Math.sin(t * 1.6) * 0.7 + Math.sin(t * 0.7 + 1.3) * 0.4;
    for (let s = 0; s < HAIR.nodes.length; s++) {
      const strand = HAIR.nodes[s];
      strand[0].x = px + (s / (HAIR.strands - 1) - 0.5) * 2.6;
      strand[0].y = py - 0.2;
      for (let i = 1; i < strand.length; i++) {
        const n = strand[i];
        const vx = (n.x - n.ox) * 0.9, vy = (n.y - n.oy) * 0.9;
        n.ox = n.x; n.oy = n.y;
        n.x += vx + (wind * 0.03 + player.vx * 0.02) * i;
        n.y += vy + 0.02 + Math.sin(t * 3 + i * 1.7) * 0.004;
        const p = strand[i - 1];
        const dx = n.x - p.x, dy = n.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        n.x = p.x + (dx / d) * 0.62;
        n.y = p.y + (dy / d) * 0.62;
      }
    }
  }

  function drawPlayer(t) {
    const px = Math.floor(GW * 0.42);
    const ground = world.horizon;
    const moving = Math.abs(player.vx) > 0.4;
    const bob = moving ? Math.sin(player.anim * 2) * 0.4 : Math.sin(t * 1.8) * 0.12;
    const py = ground - 6 + bob;
    const f = player.facing;
    const ink = state.epaper ? 14 : 15;

    const stamp = (gx, gy, ch) => put(gx, gy, ch, ink);
    // hair sits behind the head
    stamp(px, py - 1, '@');
    stamp(px, py, 'o');
    // shoulders and body
    stamp(px - 1, py + 1, '/'); stamp(px, py + 1, '|'); stamp(px + 1, py + 1, f > 0 ? '\\' : '/');
    stamp(px, py + 2, '|'); stamp(px, py + 3, '|');
    // arms swing
    const swing = Math.sin(player.anim) > 0 ? 1 : -1;
    stamp(px - 2, py + 2, swing > 0 ? '/' : '|');
    stamp(px + 2, py + 2, swing > 0 ? '|' : '\\');
    // legs alternate
    const step = Math.sin(player.anim) > 0;
    stamp(px, py + 4, step ? '/' : '|');
    stamp(px + 1, py + 4, step ? '|' : '\\');
    stamp(px, py + 5, step ? '|' : '/');
    stamp(px + 1, py + 5, step ? '\\' : '|');

    stepHair(px, py, t);
    for (const strand of HAIR.nodes) {
      for (let i = 1; i < strand.length; i++) {
        const n = strand[i];
        put(Math.round(n.x), Math.round(n.y), i % 2 ? '`' : "'", 13);
      }
    }
  }

  /* ---------------------------------------------------------------- compose */
  function buildScene(t) {
    clearGrid();
    drawStars(t);
    drawMoon(t);
    drawClouds(t);
    drawBirds(t);
    ridge(0.05, 0.006, 0.26, 0.5, ':', '+', 1, 4);      // far range
    ridge(0.16, 0.012, 0.16, 0.42, ';', '*', 2, 5);     // mid range
    ridge(0.34, 0.02, 0.08, 0.3, ',', '*', 3, 6);       // near ridge
    drawForest(t);
    drawVillage(t);
    drawGround(t);
    drawGrass(t);
    drawMist(t);
    drawFireflies(t);
    drawPlayer(t);
    return { ch: gCh, lv: gLv };
  }

  function drawGrid() {
    const { cols, rows, cellW, cellH, fs } = state;
    const baseY = Math.round((cellH - fs) / 2);
    let runs = 0;
    for (let y = 0; y < rows; y++) {
      let runLvl = -1, runStart = 0, run = '';
      const flush = () => {
        if (!run) return;
        ctx.fillStyle = style(runLvl);
        ctx.fillText(run, runStart * cellW, y * cellH + baseY);
        runs++;
        run = '';
      };
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const lvl = gLv[i];
        const ch = String.fromCharCode(gCh[i] || 32);
        if (lvl !== runLvl) { flush(); runLvl = lvl; runStart = x; run = ch; }
        else run += ch;
      }
      flush();
    }
    state.runs = runs;
  }

  function drawScene(t) {
    ctx.fillStyle = state.epaper ? '#efe9d8' : '#04070a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${state.fs}px ui-monospace, monospace`;
    buildScene(t);
    drawGrid();
  }

  /* ------------------------------------------------------------------ loop */
  const keys = { left: false, right: false, shift: false };
  let last = 0, epaperNext = 0;

  function frame(now) {
    if (!last) last = now;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const t = now / 1000;

    if (!state.paused) {
      const acc = keys.left ? -1 : keys.right ? 1 : 0;
      player.vx += (acc * player.speed * (keys.shift ? 2 : 1) - player.vx) * Math.min(1, dt * 9);
      if (Math.abs(player.vx) > 0.03) {
        player.x += player.vx * dt * 60;
        player.anim += dt * (keys.shift ? 13 : 9);
        if (acc) player.facing = acc;
      }
      state.camX = Math.max(0, Math.min(world.width - GW, player.x - GW * 0.42));
    }

    if (state.epaper) {
      if (now >= epaperNext) { epaperNext = now + 1000 / 3; drawScene(t); }
    } else {
      drawScene(t);
      state.frames++;
    }

    if (now - state.lastFps > 500) {
      state.fps = state.epaper ? 3 : Math.round((state.frames * 1000) / (now - state.lastFps || 1));
      state.frames = 0; state.lastFps = now;
      hud();
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------- hud */
  function hud() {
    const el = (id) => document.getElementById(id);
    if (el('fps')) el('fps').textContent = state.fps;
    if (el('cells')) el('cells').textContent = state.cells;
    if (el('runs')) el('runs').textContent = state.runs;
    if (el('worldInfo')) el('worldInfo').textContent =
      `world ${world.width} cols · ${(world.width * world.bladesPerCol / 1000).toFixed(0)}k blades · ${tod().label}`;
    if (el('entities')) el('entities').textContent = state.entities;
  }

  /* ----------------------------------------------------------------- input */
  addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) keys.left = true;
    if (['ArrowRight', 'd', 'D'].includes(e.key)) keys.right = true;
    if (e.key === 'Shift') keys.shift = true;
  });
  addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) keys.left = false;
    if (['ArrowRight', 'd', 'D'].includes(e.key)) keys.right = false;
    if (e.key === 'Shift') keys.shift = false;
  });

  const epaperBtn = document.getElementById('epaperBtn');
  epaperBtn.addEventListener('click', () => {
    state.epaper = !state.epaper;
    document.body.classList.toggle('epaper', state.epaper);
    epaperBtn.setAttribute('aria-pressed', String(state.epaper));
    epaperBtn.textContent = state.epaper ? '296×128 panel' : 'e-paper 296×128';
    resize();
  });
  document.getElementById('pauseBtn').addEventListener('click', (e) => {
    state.paused = !state.paused;
    e.currentTarget.setAttribute('aria-pressed', String(state.paused));
    e.currentTarget.textContent = state.paused ? 'paused' : 'pause';
  });
  const todSel = document.getElementById('tod');
  if (todSel) todSel.addEventListener('change', () => { state.tod = todSel.value; });
  const reseed = document.getElementById('reseed');
  if (reseed) reseed.addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 100000);
    world.width = 8192 + Math.floor(Math.random() * 16000);
    hud();
  });

  /* ------------------------------------------------------------------ boot */
  resize();
  initHair(GW * 0.42, world.horizon - 6);
  hud();
  requestAnimationFrame(frame);
})();
