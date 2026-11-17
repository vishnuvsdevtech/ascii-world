/* ASCII World — a glyph-grid renderer.
 *
 * Three ideas do all the work:
 *
 * 1. GRASS IS A FUNCTION, NOT DATA. A blade is a hash of (column, index), so the
 *    world costs no memory and has no edge: the field you walk through is
 *    evaluated only for the columns on screen. Nothing is stored, nothing is
 *    simulated off-camera, and the world can be arbitrarily wide.
 *
 * 2. DRAW PER ROW, NOT PER CELL. A monospace grid means a row is a single
 *    string. Cells are bucketed by brightness into a few levels and each
 *    contiguous run is one fillText call — hundreds of calls instead of
 *    thousands of glyph blits.
 *
 * 3. HAIR IS VERLET. Twelve strands, four segments each, integrated against
 *    gravity plus wind plus the walk cycle. Same integrator a grass tuft would
 *    use, which is exactly why "a few hairs" cost nothing next to the field.
 */
(() => {
  const canvas = document.getElementById('world');
  const ctx = canvas.getContext('2d', { alpha: false });
  const screenEl = document.getElementById('screen');

  const RAMP = [' ', '·', ':', ';', '*', 'o', 'O', '#', '@'];
  const LEVELS = RAMP.length;

  const state = {
    cols: 150, rows: 56, cellW: 8, cellH: 14, fs: 13,
    camX: 0, epaper: false, paused: false,
    fps: 60, frames: 0, lastFps: 0,
    runs: 0, cells: 0,
    wind: 0,
  };

  const world = {
    width: 16384,          // columns
    bladesPerCol: 24,      // capacity, evaluated lazily
    ground: 0,             // rows from bottom, set per grid size
  };

  const player = {
    x: 1200, vx: 0, speed: 7.2, run: 1,
    anim: 0, facing: 1, bob: 0,
  };

  /* ------------------------------------------------------------ hash noise */
  function hash(n) {
    let x = Math.sin(n * 127.1) * 43758.5453;
    return x - Math.floor(x);
  }
  function hash2(x, y) {
    let n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return n - Math.floor(n);
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function valueNoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi);
    const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
  }
  function fbm(x, y, oct = 4) {
    let v = 0, amp = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { v += valueNoise(x * f, y * f) * amp; amp *= 0.5; f *= 2; }
    return v;
  }

  /* ---------------------------------------------------------------- sizing */
  function measureFont() {
    ctx.font = '100px ui-monospace, monospace';
    const w = ctx.measureText('M').width || 60;
    return w / 100;
  }
  const RATIO = measureFont();

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = screenEl.getBoundingClientRect();
    canvas.width = Math.floor(r.width * dpr);
    canvas.height = Math.floor(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (state.epaper) {
      // a 2.9" 296x128 panel at 6x8 px per glyph
      state.cols = 49; state.rows = 16;
      state.cellW = r.width / state.cols;
      state.cellH = r.height / state.rows;
    } else {
      state.cellW = 8.5;
      state.cellH = 14;
      state.cols = Math.max(40, Math.floor(r.width / state.cellW));
      state.rows = Math.max(14, Math.floor(r.height / state.cellH));
      state.cellW = r.width / state.cols;
      state.cellH = r.height / state.rows;
    }
    state.fs = state.cellW / RATIO;
    world.ground = state.rows - Math.max(2, Math.round(state.rows * 0.18));
    ctx.textBaseline = 'top';
    ctx.font = `${state.fs}px ui-monospace, monospace`;
    if (state.epaper) { drawEpaperOnce(); }
  }

  addEventListener('resize', resize, { passive: true });

  /* ---------------------------------------------------------------- palette */
  function levelStyle(level, total) {
    if (state.epaper) {
      // 1-bit: no alpha ramp, so brightness becomes ink density
      return level > total * 0.45 ? '#15170f' : (level > total * 0.2 ? 'rgba(21,23,15,.55)' : 'rgba(21,23,15,.28)');
    }
    const a = 0.18 + (level / total) * 0.82;
    return `rgba(124,232,164,${a.toFixed(3)})`;
  }

  /* ------------------------------------------------------------------ hair */
  const HAIR = { strands: 12, segs: 4, nodes: [] };

  function initHair(px, py) {
    HAIR.nodes = [];
    for (let s = 0; s < HAIR.strands; s++) {
      const strand = [];
      for (let i = 0; i < HAIR.segs; i++) {
        strand.push({
          x: px + (s - HAIR.strands / 2) * 0.22 - i * 0.18,
          y: py + 0.4 + i * 0.55,
          ox: px, oy: py, vx: 0, vy: 0,
        });
      }
      HAIR.nodes.push(strand);
    }
  }

  function stepHair(px, py, dt, t) {
    const wind = Math.sin(t * 1.6) * 0.6 + Math.sin(t * 0.7 + 1.3) * 0.35;
    for (let s = 0; s < HAIR.nodes.length; s++) {
      const strand = HAIR.nodes[s];
      const anchorX = px + (s / (HAIR.strands - 1) - 0.5) * 1.5;
      const anchorY = py - 0.15;
      strand[0].x = anchorX; strand[0].y = anchorY;
      for (let i = 1; i < strand.length; i++) {
        const n = strand[i];
        const vx = (n.x - n.ox) * 0.92;
        const vy = (n.y - n.oy) * 0.92;
        n.ox = n.x; n.oy = n.y;
        n.x += vx + (wind * 0.02 + player.vx * 0.012) * i;
        n.y += vy + 0.028 + Math.sin(t * 3 + i) * 0.004;
        // keep the segment length honest so hair does not stretch
        const px2 = strand[i - 1].x, py2 = strand[i - 1].y;
        const dx = n.x - px2, dy = n.y - py2;
        const d = Math.hypot(dx, dy) || 1;
        const want = 0.55;
        n.x = px2 + (dx / d) * want;
        n.y = py2 + (dy / d) * want;
      }
    }
  }

  /* -------------------------------------------------------------- the world */
  function buildGrid(t) {
    const { cols, rows, camX } = state;
    const ground = world.ground;
    const levels = new Uint8Array(cols * rows);
    const chars = new Uint8Array(cols * rows);   // index into RAMP

    const put = (x, y, level, ch) => {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return;
      const i = y * cols + x;
      if (level >= levels[i]) { levels[i] = level; chars[i] = ch; }
    };

    // distant hills: low-density glyphs, parallax at 0.3
    for (let x = 0; x < cols; x++) {
      const wx = (camX * 0.3 + x) * 0.012;
      const h = fbm(wx, 0.7, 3);
      const top = Math.max(1, Math.floor(ground - h * rows * 0.42));
      for (let y = top; y < ground; y++) {
        const d = (y - top) / Math.max(1, ground - top);
        put(x, y, Math.max(1, Math.floor((1 - d) * 2.2)), 1);
      }
    }

    // the near field: every visible column is a tuft, evaluated, never stored
    for (let x = 0; x < cols; x++) {
      const wx = camX + x;
      const density = fbm(wx * 0.055, 0.3, 4);
      const tuft = Math.max(0, Math.floor(fbm(wx * 0.09, 5.2, 3) * 5.2));
      const sway = Math.sin(t * 2.1 + wx * 0.09) * 0.6 + Math.sin(t * 0.9 + wx * 0.03) * 0.4;

      for (let b = 0; b < tuft; b++) {
        const jitter = hash(wx * 3.1 + b * 7.7);
        const hgt = 1 + Math.floor(jitter * 3 * density + 1);
        const lean = sway * (0.6 + jitter) + (jitter - 0.5) * 0.8;
        const gx = x + Math.round(lean * (hgt / 3));
        const gy = ground - hgt;
        const lvl = Math.min(LEVELS - 1, 2 + Math.floor(density * 4 + jitter * 2));
        put(gx, gy, lvl, Math.abs(lean) < 0.45 ? 2 : (lean > 0 ? 3 : 4));
        if (hgt > 2) put(gx, gy + 1, Math.max(1, lvl - 2), 2);
      }

      // soil
      put(x, ground, 6, 7);
      if (hash(wx * 1.7) > 0.72) put(x, ground + 1, 3, 7);

      // the occasional flower catches the light
      if (hash(wx * 9.13) > 0.993) {
        put(x, ground - 2, LEVELS - 1, 8);
        put(x, ground - 1, 3, 2);
      }
    }

    state.cells = cols * rows;
    return { levels, chars };
  }

  /* --------------------------------------------------------------- drawing */
  function drawGrid(grid) {
    const { cols, rows, cellW, cellH, fs } = state;
    const baseY = Math.round((cellH - fs) / 2);
    let runs = 0;

    for (let y = 0; y < rows; y++) {
      let runLevel = -1;
      let runStart = 0;
      let run = '';
      const flush = () => {
        if (!run) return;
        ctx.fillStyle = levelStyle(runLevel, LEVELS - 1);
        ctx.fillText(run, runStart * cellW, y * cellH + baseY);
        runs++;
      };
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const lvl = grid.levels[i];
        const ch = RAMP[grid.chars[i]] || ' ';
        if (lvl !== runLevel) { flush(); runLevel = lvl; runStart = x; run = ch; }
        else run += ch;
      }
      flush();
    }
    state.runs = runs;
  }

  function drawPlayer(t) {
    const { cols, cellW, cellH, fs } = state;
    const ground = world.ground;
    const px = Math.floor(cols * 0.38 - state.camX % 1);
    const bob = Math.sin(t * 9) * (Math.abs(player.vx) > 0.4 ? 0.35 : 0.1);
    const py = ground - 4 + bob;
    const ink = state.epaper ? '#15170f' : 'rgba(210,255,225,.96)';
    ctx.fillStyle = ink;

    const stamp = (gx, gy, ch) => {
      if (gx < 0 || gx >= cols) return;
      ctx.fillText(ch, gx * cellW, gy * cellH + Math.round((cellH - fs) / 2));
    };

    const f = player.facing;
    // head
    stamp(px, py, 'o');
    // body
    stamp(px, py + 1, f > 0 ? '/' : '\\');
    stamp(px + 1, py + 1, f > 0 ? '|' : '|');
    // arms swing with the walk cycle
    const swing = Math.sin(player.anim) > 0 ? 1 : -1;
    stamp(px - 1, py + 1, swing > 0 ? '/' : '\\');
    // legs
    const step = Math.sin(player.anim) > 0;
    stamp(px, py + 2, step ? '/' : '|');
    stamp(px + 1, py + 2, step ? '|' : '\\');
    stamp(px, py + 3, step ? '|' : '/');
    stamp(px + 1, py + 3, step ? '\\' : '|');

    // hair, drawn last so it sits over the body
    stepHair(px, py, 1 / 60, t);
    ctx.fillStyle = state.epaper ? 'rgba(21,23,15,.75)' : 'rgba(190,240,210,.85)';
    for (const strand of HAIR.nodes) {
      for (let i = 1; i < strand.length; i++) {
        const n = strand[i];
        const gx = Math.round(n.x), gy = Math.round(n.y);
        stamp(gx, gy, i % 2 ? '`' : "'");
      }
    }
  }

  /* ------------------------------------------------------------------ loop */
  let last = 0, acc = 0;

  function frame(now) {
    if (!last) last = now;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    const t = now / 1000;
    state.wind = Math.sin(t * 1.6);

    // movement
    if (!state.paused) {
      const accel = keys.left ? -1 : keys.right ? 1 : 0;
      player.vx += (accel * player.speed * (keys.shift ? 1.9 : 1) - player.vx) * Math.min(1, dt * 8);
      if (Math.abs(player.vx) > 0.05) {
        player.x += player.vx * dt * 60;
        player.anim += dt * 9;
        if (accel !== 0) player.facing = accel;
      }
      state.camX = Math.max(0, Math.min(world.width - state.cols, player.x - state.cols * 0.38));
    }

    if (!state.epaper) {
      ctx.fillStyle = '#040906';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const grid = buildGrid(t);
      drawGrid(grid);
      drawPlayer(t);
      state.frames++;
    }

    // fps + hud
    if (now - state.lastFps > 500) {
      state.fps = Math.round((state.frames * 1000) / (now - state.lastFps || 1));
      state.frames = 0; state.lastFps = now;
      updateHud();
    }

    const interval = state.epaper ? 1000 / 3 : 0;   // panel refresh limit
    if (state.epaper) {
      if (!frame.next) frame.next = now + interval;
      if (now >= frame.next) { frame.next = now + interval; drawEpaperOnce(); }
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------- e-paper */
  function drawEpaperOnce() {
    const t = performance.now() / 1000;
    ctx.fillStyle = '#efe9d8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const grid = buildGrid(t);
    ctx.font = `${state.fs}px ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    drawGrid(grid);
    drawPlayer(t);
    const el = document.getElementById('cells');
    if (el) el.textContent = state.cells;
  }

  /* ------------------------------------------------------------------ input */
  const keys = { left: false, right: false, shift: false };
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.left = true;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.right = true;
    if (e.key === 'Shift') keys.shift = true;
  });
  addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.right = false;
    if (e.key === 'Shift') keys.shift = false;
  });

  const epaperBtn = document.getElementById('epaperBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  epaperBtn.addEventListener('click', () => {
    state.epaper = !state.epaper;
    document.body.classList.toggle('epaper', state.epaper);
    epaperBtn.setAttribute('aria-pressed', String(state.epaper));
    epaperBtn.textContent = state.epaper ? '296×128 panel' : 'e-paper 296×128';
    resize();
  });
  pauseBtn.addEventListener('click', () => {
    state.paused = !state.paused;
    pauseBtn.setAttribute('aria-pressed', String(state.paused));
    pauseBtn.textContent = state.paused ? 'paused' : 'pause';
  });

  function updateHud() {
    document.getElementById('fps').textContent = state.fps;
    document.getElementById('cells').textContent = state.cells;
    document.getElementById('runs').textContent = state.runs;
    const blades = (world.width * world.bladesPerCol) / 1000;
    document.getElementById('worldInfo').textContent =
      `world ${world.width} cols · ${blades.toFixed(0)}k blades · ground ${world.ground}`;
  }

  /* ------------------------------------------------------------------ boot */
  resize();
  initHair(state.cols * 0.38, world.ground - 4);
  updateHud();
  requestAnimationFrame(frame);
})();
