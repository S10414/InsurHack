/*
 * Budget field: WebGL2 view of every department x month.
 *   bar height  = spend that month (actual, or forecast for open months), relative to the department's average monthly budget
 *   thin plate  = that month's budget, at the same scale
 *   colour      = spend vs budget (teal under, slate on budget, coral over); forecast bars are translucent and hatched
 * The camera tilts from an oblique view to a near top-down "heat map" as setTilt(0..1) is driven by scroll.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ tiny mat4 helpers (column-major)
  const M4 = {
    persp(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
    },
    lookAt(e, c, up) {
      let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
      let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
      let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
      l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
        -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
    },
    mul(a, b) {
      const o = new Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
      return o;
    },
    apply(m, v) {
      const x = v[0], y = v[1], z = v[2];
      return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15]];
    },
  };

  // ------------------------------------------------------------------ shaders
  const VS = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aNormal;
  layout(location=2) in vec4 aInst;   // x, z, height, delay
  layout(location=3) in vec4 aColor;  // rgb, index
  uniform mat4 uVP;
  uniform float uGrow, uWidth, uHover, uMode;
  out vec3 vN; out vec3 vCol; out vec3 vW; out float vHover; out float vTop;
  void main(){
    float g = clamp((uGrow - aInst.w) / 0.55, 0.0, 1.0);
    g = 1.0 - pow(1.0 - g, 3.0);
    vec3 p;
    if (uMode > 1.5) {               // budget plate: flat square at budget height
      p = vec3(aPos.x * uWidth * 1.22 + aInst.x, aInst.z * g + 0.004, aPos.z * uWidth * 1.22 + aInst.y);
    } else {
      float h = max(aInst.z * g, 0.003);
      p = vec3(aPos.x * uWidth + aInst.x, aPos.y * h, aPos.z * uWidth + aInst.y);
    }
    vN = aNormal; vCol = aColor.rgb; vW = p; vTop = aPos.y;
    vHover = abs(aColor.a - uHover) < 0.5 ? 1.0 : 0.0;
    gl_Position = uVP * vec4(p, 1.0);
  }`;

  const FS = `#version 300 es
  precision highp float;
  in vec3 vN; in vec3 vCol; in vec3 vW; in float vHover; in float vTop;
  uniform float uMode;      // 0 actual, 1 forecast, 2 plate
  uniform vec3 uBg, uEye;
  uniform float uFogNear, uFogFar;
  out vec4 o;
  void main(){
    vec3 n = normalize(vN);
    vec3 L = normalize(vec3(-0.45, 0.85, 0.35));
    float diff = max(dot(n, L), 0.0);
    float top = step(0.5, n.y);
    vec3 c;
    float a = 1.0;
    if (uMode > 1.5) {
      c = vec3(0.93, 0.96, 1.0); a = 0.30 + 0.35 * vHover;
    } else {
      c = vCol * (0.42 + 0.58 * diff) + top * 0.10;
      if (uMode > 0.5) {                 // forecast: translucent with diagonal hatching on the sides
        float hatch = step(0.55, fract((vW.y + vW.x + vW.z) * 7.0));
        c = mix(c, vCol * 1.15, 0.35 * hatch * (1.0 - top));
        a = 0.46;
      }
      c += vHover * 0.22;
    }
    float d = distance(vW, uEye);
    float fog = smoothstep(uFogNear, uFogFar, d);
    o = vec4(mix(c, uBg, fog * 0.85), a * (1.0 - fog * 0.6));
  }`;

  const LVS = `#version 300 es
  layout(location=0) in vec3 aPos;
  uniform mat4 uVP;
  out vec3 vW;
  void main(){ vW = aPos; gl_Position = uVP * vec4(aPos, 1.0); }`;
  const LFS = `#version 300 es
  precision highp float;
  in vec3 vW; uniform vec4 uColor; uniform vec3 uEye; uniform float uFogFar;
  out vec4 o;
  void main(){ float f = smoothstep(uFogFar * 0.55, uFogFar, distance(vW, uEye)); o = vec4(uColor.rgb, uColor.a * (1.0 - f)); }`;

  function compile(gl, vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  // unit box: x,z in [-0.5,0.5], y in [0,1]; with normals
  function boxGeometry() {
    const f = [ // [normal, 4 corners]
      [[0, 1, 0], [[-.5, 1, -.5], [.5, 1, -.5], [.5, 1, .5], [-.5, 1, .5]]],
      [[0, 0, 1], [[-.5, 0, .5], [.5, 0, .5], [.5, 1, .5], [-.5, 1, .5]]],
      [[0, 0, -1], [[.5, 0, -.5], [-.5, 0, -.5], [-.5, 1, -.5], [.5, 1, -.5]]],
      [[1, 0, 0], [[.5, 0, .5], [.5, 0, -.5], [.5, 1, -.5], [.5, 1, .5]]],
      [[-1, 0, 0], [[-.5, 0, -.5], [-.5, 0, .5], [-.5, 1, .5], [-.5, 1, -.5]]],
    ];
    const out = [];
    for (const [n, q] of f) for (const i of [0, 1, 2, 0, 2, 3]) out.push(...q[i], ...n);
    return new Float32Array(out);
  }
  const plateGeometry = () => new Float32Array([
    -.5, 0, -.5, 0, 1, 0, .5, 0, -.5, 0, 1, 0, .5, 0, .5, 0, 1, 0,
    -.5, 0, -.5, 0, 1, 0, .5, 0, .5, 0, 1, 0, -.5, 0, .5, 0, 1, 0]);

  // ------------------------------------------------------------------ colour scale
  const UNDER = [0.20, 0.72, 0.60], MID = [0.40, 0.48, 0.60], OVER = [0.95, 0.35, 0.29];
  function colorFor(ratio) {
    if (!Number.isFinite(ratio)) return MID;
    const t = Math.max(-1, Math.min(1, (ratio - 1) / 0.25));
    const [a, b, u] = t < 0 ? [MID, UNDER, -t] : [MID, OVER, t];
    const e = Math.pow(u, 0.8);
    return a.map((x, i) => x + (b[i] - x) * e);
  }

  // ------------------------------------------------------------------ field
  function create(canvas, labelLayer, opts = {}) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) return null;
    const prog = compile(gl, VS, FS), lprog = compile(gl, LVS, LFS);
    const U = (p, n) => gl.getUniformLocation(p, n);
    const u = { vp: U(prog, 'uVP'), grow: U(prog, 'uGrow'), width: U(prog, 'uWidth'), hover: U(prog, 'uHover'), mode: U(prog, 'uMode'),
      bg: U(prog, 'uBg'), eye: U(prog, 'uEye'), fn: U(prog, 'uFogNear'), ff: U(prog, 'uFogFar') };
    const lu = { vp: U(lprog, 'uVP'), color: U(lprog, 'uColor'), eye: U(lprog, 'uEye'), ff: U(lprog, 'uFogFar') };

    function geoVAO(data) {
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      const inst = gl.createBuffer(), col = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, inst); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(2, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, col); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(3, 1);
      gl.bindVertexArray(null);
      return { vao, inst, col, count: data.length / 6, n: 0 };
    }
    const box = boxGeometry();
    const sets = { actual: geoVAO(box), forecast: geoVAO(box), plate: geoVAO(plateGeometry()) };
    const lineVao = gl.createVertexArray(), lineBuf = gl.createBuffer();
    let lineCount = 0;

    const st = {
      cells: [], rows: [], months: 12, closed: 12, grow: 1, tilt: 0, hover: -1, sway: 0, mx: 0, my: 0,
      w: 1, h: 1, vp: null, eye: [0, 0, 0], visible: true, raf: 0, onHover: opts.onHover, onPick: opts.onPick,
      reduced: !!opts.reducedMotion, t0: performance.now(),
    };
    const SP = 1.0, WIDTH = 0.62;

    function setData(d) {
      // d = { rows: [{ name, months: [{ value, budget, forecast }] }], closed }
      st.rows = d.rows; st.closed = d.closed;
      const nR = d.rows.length;
      const A = [], AC = [], Fc = [], FC = [], P = [], PC = [];
      st.cells = [];
      d.rows.forEach((row, r) => {
        const meanB = row.months.reduce((a, m) => a + m.budget, 0) / 12 || 1;
        row.months.forEach((m, i) => {
          const x = (i - 5.5) * SP, z = (r - (nR - 1) / 2) * SP * 1.08;
          const h = Math.min(m.value / meanB, 3.2) * 1.15, bh = Math.min(m.budget / meanB, 3.2) * 1.15;
          const delay = i * 0.07 + r * 0.015 + (m.forecast ? 0.25 : 0);
          const idx = st.cells.length;
          const col = colorFor(m.value / m.budget);
          (m.forecast ? Fc : A).push(x, z, h, delay);
          (m.forecast ? FC : AC).push(...col, idx);
          P.push(x, z, bh, delay + 0.15); PC.push(1, 1, 1, idx);
          st.cells.push({ r, i, x, z, h, bh, row: row.name, ...m });
        });
      });
      // points the camera must keep in view: every bar top, the floor corners and the HTML labels
      // (row labels are right-aligned left of the grid, month labels in front of it, "預測" behind it)
      const zEdge = nR / 2 * SP * 1.08, fit = [];
      for (const c of st.cells) fit.push([c.x - WIDTH / 2, Math.max(c.h, c.bh), c.z - WIDTH / 2], [c.x + WIDTH / 2, Math.max(c.h, c.bh), c.z + WIDTH / 2]);
      for (const x of [-6 * SP, 6 * SP]) for (const z of [-zEdge, zEdge]) fit.push([x, 0, z]);
      for (let r = 0; r < nR; r++) fit.push([-6 * SP - 0.35, 0, (r - (nR - 1) / 2) * SP * 1.08]);   // row-label anchors
      for (let i = 0; i < 12; i++) fit.push([(i - 5.5) * SP, 0, zEdge + 0.95]);
      fit.push([-6 * SP + d.closed * SP + 1.1, 0, -zEdge - 0.95]);
      st.fitPts = fit;
      const up = (s, inst, col) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, s.inst); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(inst), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, s.col); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(col), gl.STATIC_DRAW);
        s.n = inst.length / 4;
      };
      up(sets.actual, A, AC); up(sets.forecast, Fc, FC); up(sets.plate, P, PC);

      // floor grid + the "today" line between the last closed and first forecast month
      const L = [], x0 = -6 * SP, x1 = 6 * SP, z0 = -nR / 2 * SP * 1.08, z1 = nR / 2 * SP * 1.08;
      for (let r = 0; r <= nR; r++) { const z = z0 + r * SP * 1.08; L.push(x0, 0, z, x1, 0, z); }
      for (let i = 0; i <= 12; i++) { const x = x0 + i * SP; L.push(x, 0, z0, x, 0, z1); }
      const tx = x0 + d.closed * SP;
      L.push(tx, 0.002, z0 - 0.6, tx, 0.002, z1 + 0.6);
      gl.bindVertexArray(lineVao); gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(L), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0); gl.bindVertexArray(null);
      lineCount = L.length / 3;
      st.extent = { z0, z1, tx };
      buildLabels();
    }

    // HTML labels that follow the projection
    let labels = [];
    function buildLabels() {
      if (!labelLayer) return;
      labelLayer.innerHTML = '';
      labels = [];
      const nR = st.rows.length;
      st.rows.forEach((row, r) => {
        const el = document.createElement('span'); el.className = 'fl-row'; el.textContent = row.name;
        labelLayer.appendChild(el); labels.push({ el, p: [-6 * SP - 0.35, 0, (r - (nR - 1) / 2) * SP * 1.08], align: 'right' });
      });
      for (let i = 0; i < 12; i++) {
        const el = document.createElement('span'); el.className = 'fl-month' + (i >= st.closed ? ' f' : ''); el.textContent = (i + 1) + '月';
        labelLayer.appendChild(el); labels.push({ el, p: [(i - 5.5) * SP, 0, st.extent.z1 + 0.55], align: 'center' });
      }
      const el = document.createElement('span'); el.className = 'fl-today'; el.textContent = '預測 →';
      labelLayer.appendChild(el); labels.push({ el, p: [st.extent.tx + 0.15, 0, st.extent.z0 - 0.7], align: 'left' });
      // row labels are right-aligned at their anchor and have a fixed pixel size: reserve that width
      st.labelW = Math.max(0, ...labels.filter((l) => l.align === 'right').map((l) => l.el.offsetWidth));
    }

    function camera() {
      const nR = st.rows.length || 10;
      const aspect = st.w / st.h, fov = 30 * Math.PI / 180;
      const hx = 6 * SP + 0.6, hz = nR / 2 * SP * 1.08 + 0.6, top = 2.2 * (1 - st.tilt) + 0.3;
      const narrow = aspect < 1.1;                               // phones: steeper, straighter start so 12 months stay legible
      const phi0 = narrow ? 0.95 : 0.62;
      const phi = phi0 + st.tilt * (1.48 - phi0);                // elevation: oblique -> near top-down
      const theta = (narrow ? -0.22 : -0.50) * (1 - st.tilt) + st.sway + st.mx * 0.04 * (1 - st.tilt);
      const target = [0, 0.5 * (1 - st.tilt), 0];
      const up = st.tilt > 0.97 ? [0, 0, -1] : [0, 1, 0];
      const proj = M4.persp(fov, aspect, 0.5, 300);
      let corners = st.fitPts;
      if (!corners || !corners.length) {
        corners = [];
        for (const x of [-hx - 1.6, hx]) for (const z of [-hz, hz]) for (const y of [0, top]) corners.push([x, y, z]);
      }
      // fixed distance for a calm perspective, then pan + zoom in clip space (a lens shift) so the
      // whole grid, including the row labels on the left, fills the stage
      const dist = 30;
      const eye = [target[0] + dist * Math.cos(phi) * Math.sin(theta), target[1] + dist * Math.sin(phi),
        target[2] + dist * Math.cos(phi) * Math.cos(theta)];
      const vp0 = M4.mul(proj, M4.lookAt(eye, target, up));
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const c of corners) {
        const q = M4.apply(vp0, c), x = q[0] / q[3], y = q[1] / q[3];
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      // target rectangle in clip space: the field has its own box below the headline, beside the legend.
      // Fit uniformly, then stretch into the free direction (wider on desktop, taller on phones) so the
      // box is filled instead of leaving empty margins; anchor left, leaving room for the department labels.
      const STRETCH_X = 1.8, STRETCH_Y = 1.8;
      const R = { x0: Math.min(-1 + 2 * ((st.labelW || 0) + 8) / st.w, 0), x1: 0.95, y0: -0.95, y1: 0.95 };
      const xr = (R.x1 - R.x0) / (x1 - x0), yr = (R.y1 - R.y0) / (y1 - y0), k = Math.min(xr, yr);
      const kx = Math.min(xr, k * STRETCH_X), ky = Math.min(yr, k * STRETCH_Y);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const tx = R.x0 + kx * (x1 - x0) / 2, ty = (R.y0 + R.y1) / 2;
      const post = [kx, 0, 0, 0, 0, ky, 0, 0, 0, 0, 1, 0, tx - kx * cx, ty - ky * cy, 0, 1];
      st.eye = eye; st.vp = M4.mul(post, vp0); st.dist = dist;
    }

    function project(p) {
      const c = M4.apply(st.vp, p);
      return [(c[0] / c[3] * 0.5 + 0.5) * st.w, (1 - (c[1] / c[3] * 0.5 + 0.5)) * st.h, c[3]];
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2), r = canvas.getBoundingClientRect();
      st.w = Math.max(1, r.width); st.h = Math.max(1, r.height);
      canvas.width = Math.round(st.w * dpr); canvas.height = Math.round(st.h * dpr);
    }

    const BG = opts.bg || [0.055, 0.10, 0.17];
    function draw() {
      camera();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      // grid
      gl.useProgram(lprog); gl.uniformMatrix4fv(lu.vp, false, st.vp); gl.uniform3fv(lu.eye, st.eye); gl.uniform1f(lu.ff, st.dist * 1.9);
      gl.bindVertexArray(lineVao); gl.depthMask(false);
      gl.uniform4f(lu.color, 0.55, 0.65, 0.80, 0.16); gl.drawArrays(gl.LINES, 0, lineCount - 2);
      gl.uniform4f(lu.color, 0.95, 0.80, 0.45, 0.65 * Math.min(1, st.grow / 1.2)); gl.drawArrays(gl.LINES, lineCount - 2, 2);

      gl.useProgram(prog);
      gl.uniformMatrix4fv(u.vp, false, st.vp); gl.uniform1f(u.grow, st.grow); gl.uniform1f(u.width, WIDTH);
      gl.uniform1f(u.hover, st.hover); gl.uniform3fv(u.bg, BG); gl.uniform3fv(u.eye, st.eye);
      gl.uniform1f(u.fn, st.dist * 0.9); gl.uniform1f(u.ff, st.dist * 1.9);
      const run = (s, mode, depthWrite) => {
        if (!s.n) return;
        gl.uniform1f(u.mode, mode); gl.depthMask(depthWrite); gl.bindVertexArray(s.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, s.count, s.n);
      };
      run(sets.actual, 0, true);
      run(sets.forecast, 1, false);
      run(sets.plate, 2, false);
      gl.depthMask(true); gl.bindVertexArray(null);

      for (const l of labels) {
        const [x, y, w] = project(l.p);
        const vis = w > 0 && x > -80 && x < st.w + 80 && y > -20 && y < st.h + 20;
        l.el.style.opacity = vis ? String(Math.min(1, st.grow * 1.5)) : '0';
        const dx = l.align === 'right' ? '-100%' : l.align === 'center' ? '-50%' : '0';
        l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${dx}, -50%)`;
      }
    }

    function frame(now) {
      st.raf = 0;
      if (!st.reduced) st.sway = Math.sin((now - st.t0) / 7000) * 0.07 * (1 - st.tilt);
      draw();
      if (st.visible && !document.hidden) st.raf = requestAnimationFrame(frame);
    }
    const start = () => { if (!st.raf) st.raf = requestAnimationFrame(frame); };

    // hover picking on the CPU: distance from the pointer to each bar's projected axis
    function pick(px, py) {
      if (!st.vp) return -1;
      let best = -1, bestW = Infinity;
      for (let k = 0; k < st.cells.length; k++) {
        const c = st.cells[k];
        const top = Math.max(c.h, c.bh) * Math.min(1, st.grow);
        const a = project([c.x, 0, c.z]), b = project([c.x, top, c.z]), s = project([c.x + WIDTH / 2, 0, c.z]);
        const half = Math.max(5, Math.abs(s[0] - a[0]) * 1.1);
        const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / L2));
        const d = Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
        if (d < half && a[2] < bestW) { best = k; bestW = a[2]; }
      }
      return best;
    }

    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      st.mx = px / r.width * 2 - 1; st.my = py / r.height * 2 - 1;
      const k = pick(px, py);
      if (k !== st.hover) { st.hover = k; canvas.style.cursor = k >= 0 ? 'pointer' : ''; }
      if (st.onHover) st.onHover(k >= 0 ? st.cells[k] : null, px, py);
      start();
    });
    canvas.addEventListener('pointerleave', () => { st.hover = -1; st.mx = st.my = 0; if (st.onHover) st.onHover(null); start(); });
    canvas.addEventListener('click', () => { if (st.hover >= 0 && st.onPick) st.onPick(st.cells[st.hover]); });

    new ResizeObserver(() => { resize(); start(); }).observe(canvas);
    new IntersectionObserver((es) => { st.visible = es[0].isIntersecting; if (st.visible) start(); }).observe(canvas);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
    resize();

    return {
      setData(d) { setData(d); start(); },
      setGrow(g) { st.grow = g; start(); },
      setTilt(t) { st.tilt = Math.max(0, Math.min(1, t)); start(); },
      get state() { return st; },
      redraw: start,
    };
  }

  root.FPAField = { create, colorFor };
})(window);
