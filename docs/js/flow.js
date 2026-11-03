/*
 * Reallocation flow: WebGL2 view of the suggested budget transfers.
 *   left column   = lines with releasable surplus (teal); the part being moved out fades to an outline
 *   right column  = lines forecast to overrun; the gap (coral) fills up with teal as transfers arrive,
 *                   so whatever coral is left at the end is the gap that still needs extra budget
 *   ribbons       = one per transfer, width by amount, amber when it crosses expense categories
 * setPhase(0..1) moves from "before" to "after". Horizontal drag turns the view (shared orbit control).
 */
(function (root) {
  'use strict';
  const { M4, compile, boxGeometry, orbit } = root.FPAField;

  const BVS = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aNormal;
  layout(location=2) in vec4 aInst;   // x, z, y0, y1
  layout(location=3) in vec4 aColor;  // rgb, bar index
  uniform mat4 uVP; uniform float uW, uHover;
  out vec3 vN; out vec3 vCol; out float vHot;
  void main(){
    float h = max(aInst.w - aInst.z, 0.002);
    vec3 p = vec3(aPos.x * uW + aInst.x, aInst.z + aPos.y * h, aPos.z * uW + aInst.y);
    vN = aNormal; vCol = aColor.rgb;
    vHot = uHover < -0.5 ? 0.0 : (abs(aColor.a - uHover) < 0.5 ? 1.0 : -1.0);
    gl_Position = uVP * vec4(p, 1.0);
  }`;
  const BFS = `#version 300 es
  precision highp float;
  in vec3 vN; in vec3 vCol; in float vHot;
  uniform float uAlpha;
  out vec4 o;
  void main(){
    vec3 n = normalize(vN);
    float diff = max(dot(n, normalize(vec3(-0.45, 0.85, 0.35))), 0.0);
    vec3 c = vCol * (0.45 + 0.55 * diff) + step(0.5, n.y) * 0.08 + max(vHot, 0.0) * 0.2;
    o = vec4(c * (vHot < -0.5 ? 0.45 : 1.0), uAlpha * (vHot < -0.5 ? 0.55 : 1.0));
  }`;

  const RVS = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec4 aMeta;   // u along path, from bar, to bar, cross
  uniform mat4 uVP;
  out float vU; out float vCross; out float vHot;
  uniform float uHover;
  void main(){
    vU = aMeta.x; vCross = aMeta.w;
    vHot = uHover < -0.5 ? 0.0 : ((abs(aMeta.y - uHover) < 0.5 || abs(aMeta.z - uHover) < 0.5) ? 1.0 : -1.0);
    gl_Position = uVP * vec4(aPos, 1.0);
  }`;
  const RFS = `#version 300 es
  precision highp float;
  in float vU; in float vCross; in float vHot;
  uniform float uReveal;
  out vec4 o;
  void main(){
    if (vU > uReveal) discard;
    vec3 teal = vec3(0.24, 0.78, 0.66), amber = vec3(0.98, 0.76, 0.33);
    vec3 c = mix(teal, amber, vCross);
    float edge = smoothstep(uReveal, uReveal - 0.04, vU);
    float a = (vHot < -0.5 ? 0.07 : vHot > 0.5 ? 0.8 : 0.5) * edge;
    o = vec4(c, a);
  }`;

  const PVS = `#version 300 es
  layout(location=0) in vec4 aP;   // xyz, size
  layout(location=1) in float aC;  // cross
  uniform mat4 uVP; uniform float uScale;
  out float vC;
  void main(){ vC = aC; gl_Position = uVP * vec4(aP.xyz, 1.0); gl_PointSize = clamp(aP.w * uScale / gl_Position.w, 2.0, 14.0); }`;
  const PFS = `#version 300 es
  precision highp float;
  in float vC; out vec4 o;
  void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
    vec3 c = mix(vec3(0.70, 1.0, 0.92), vec3(1.0, 0.90, 0.62), vC); o = vec4(c, smoothstep(0.5, 0.1, d) * 0.95); }`;

  const LVS = `#version 300 es
  layout(location=0) in vec3 aPos; uniform mat4 uVP; void main(){ gl_Position = uVP * vec4(aPos, 1.0); }`;
  const LFS = `#version 300 es
  precision highp float; uniform vec4 uColor; out vec4 o; void main(){ o = uColor; }`;

  const TEAL = [0.21, 0.70, 0.60], CORAL = [0.94, 0.36, 0.30];
  const W = 0.62, XS = 4.2, ZS = 1.15;

  function bez(a, c, b, t) {
    const s = 1 - t;
    return [s * s * a[0] + 2 * s * t * c[0] + t * t * b[0], s * s * a[1] + 2 * s * t * c[1] + t * t * b[1], s * s * a[2] + 2 * s * t * c[2] + t * t * b[2]];
  }

  function create(canvas, labelLayer, opts = {}) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) return null;
    const bp = compile(gl, BVS, BFS), rp = compile(gl, RVS, RFS), pp = compile(gl, PVS, PFS), lp = compile(gl, LVS, LFS);
    const U = (p, n) => gl.getUniformLocation(p, n);
    const bu = { vp: U(bp, 'uVP'), w: U(bp, 'uW'), hover: U(bp, 'uHover'), alpha: U(bp, 'uAlpha') };
    const ru = { vp: U(rp, 'uVP'), reveal: U(rp, 'uReveal'), hover: U(rp, 'uHover') };
    const pu = { vp: U(pp, 'uVP'), scale: U(pp, 'uScale') };
    const lu = { vp: U(lp, 'uVP'), color: U(lp, 'uColor') };

    // bars: box geometry + per-instance (x, z, y0, y1) and (rgb, index)
    const bvao = gl.createVertexArray(); gl.bindVertexArray(bvao);
    const box = boxGeometry(), bg = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bg); gl.bufferData(gl.ARRAY_BUFFER, box, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const binst = gl.createBuffer(), bcol = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, binst); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, bcol); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    const boxCount = box.length / 6;

    const rvao = gl.createVertexArray(), rbuf = gl.createBuffer();
    gl.bindVertexArray(rvao); gl.bindBuffer(gl.ARRAY_BUFFER, rbuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
    const pvao = gl.createVertexArray(), pbuf = gl.createBuffer();
    gl.bindVertexArray(pvao); gl.bindBuffer(gl.ARRAY_BUFFER, pbuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 16);
    gl.bindVertexArray(null);
    const lvao = gl.createVertexArray(), lbuf = gl.createBuffer();
    gl.bindVertexArray(lvao); gl.bindBuffer(gl.ARRAY_BUFFER, lbuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const st = {
      bars: [], moves: [], phase: 0, hover: -1, w: 1, h: 1, vp: null, visible: true, raf: 0,
      reduced: !!opts.reducedMotion, t0: performance.now(), ribbonVerts: 0, lineVerts: 0, fitPts: [], yaw: 0,
    };

    function setData(d) {
      // d = { donors: [{ key, name, sub, cap, used }], receivers: [{ key, name, sub, need, got }], moves: [{ from, to, amount, cross }] }
      const max = Math.max(1, ...d.donors.map((x) => x.cap), ...d.receivers.map((x) => x.need));
      const H = (v) => v / max * 3.0;
      const bars = [], idx = new Map();
      const place = (list, side) => list.forEach((x, i) => {
        const z = (i - (list.length - 1) / 2) * ZS, b = { ...x, side, x: side * XS, z, i: bars.length };
        b.full = H(side < 0 ? x.cap : x.need); b.part = H(side < 0 ? x.used : x.got);
        idx.set(x.key, b); bars.push(b);
      });
      place(d.donors, -1); place(d.receivers, 1);
      st.bars = bars;

      const maxAmt = Math.max(1, ...d.moves.map((m) => m.amount));
      // where each transfer leaves / lands: stack the ribbons on the bar so they look like slices of it
      const outAt = new Map(), inAt = new Map();
      st.moves = d.moves.map((m) => {
        const a = idx.get(m.from), b = idx.get(m.to);
        if (!a || !b) return null;
        const ya = a.full - (outAt.get(a.i) || 0) - H(m.amount) / 2; outAt.set(a.i, (outAt.get(a.i) || 0) + H(m.amount));
        const yb = (inAt.get(b.i) || 0) + H(m.amount) / 2; inAt.set(b.i, (inAt.get(b.i) || 0) + H(m.amount));
        const p0 = [a.x + W / 2, ya, a.z], p2 = [b.x - W / 2, yb, b.z];
        const span = Math.hypot(p2[0] - p0[0], p2[2] - p0[2]);
        const c = [(p0[0] + p2[0]) / 2, Math.max(ya, yb) + 1.0 + span * 0.18, (p0[2] + p2[2]) / 2];
        return { ...m, a: a.i, b: b.i, p0, c, p2, width: Math.max(0.05, H(m.amount)), n: Math.round(3 + 9 * m.amount / maxAmt) };
      }).filter(Boolean);

      // ribbons: a vertical band along the curve, as thick as the slice of the bar it carries (same scale)
      const R = [];
      const SEG = 48;
      for (const m of st.moves) {
        const meta = (u) => [u, m.a, m.b, m.cross ? 1 : 0];
        let prev = null;
        for (let k = 0; k <= SEG; k++) {
          const u = k / SEG, p = bez(m.p0, m.c, m.p2, u);
          const half = m.width / 2, L = [p[0], p[1] + half, p[2]], Rr = [p[0], p[1] - half, p[2]];
          if (prev) {
            R.push(...prev.L, ...meta(prev.u), ...prev.R, ...meta(prev.u), ...Rr, ...meta(u));
            R.push(...prev.L, ...meta(prev.u), ...Rr, ...meta(u), ...L, ...meta(u));
          }
          prev = { L, R: Rr, u };
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, rbuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(R), gl.STATIC_DRAW);
      st.ribbonVerts = R.length / 7;

      // floor: one tray under each column
      const Lf = [];
      const tray = (side, n) => {
        if (!n) return;
        const x0 = side * XS - 0.7, x1 = side * XS + 0.7, z0 = -(n / 2) * ZS - 0.1, z1 = (n / 2) * ZS + 0.1;
        Lf.push(x0, 0, z0, x1, 0, z0, x1, 0, z0, x1, 0, z1, x1, 0, z1, x0, 0, z1, x0, 0, z1, x0, 0, z0);
        for (let i = 1; i < n; i++) { const z = z0 + 0.1 + i * ZS; Lf.push(x0, 0, z, x1, 0, z); }
      };
      tray(-1, d.donors.length); tray(1, d.receivers.length);
      gl.bindBuffer(gl.ARRAY_BUFFER, lbuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(Lf), gl.STATIC_DRAW);
      st.lineVerts = Lf.length / 3;

      const fit = [];
      for (const b of bars) for (const dz of [-W / 2, W / 2]) fit.push([b.x - W / 2, 0, b.z + dz], [b.x + W / 2, b.full, b.z + dz]);
      for (const m of st.moves) { const a = bez(m.p0, m.c, m.p2, 0.5); fit.push([a[0], a[1] + m.width / 2 + 0.1, a[2]]); }
      fit.push([-XS, 0, (d.donors.length / 2) * ZS + 0.8], [XS, 0, (d.receivers.length / 2) * ZS + 0.8]);
      st.fitPts = fit;
      buildLabels(d);
      updateBars();
    }

    function updateBars() {
      const I = [], C = [];
      const ph = st.phase;
      // bars linked to the hovered one share its index, so the shader lights them together
      const rel = new Set();
      if (st.hover >= 0) { rel.add(st.hover); for (const m of st.moves) if (m.a === st.hover || m.b === st.hover) { rel.add(m.a); rel.add(m.b); } }
      const id = (b) => (rel.has(b.i) ? st.hover : b.i);
      for (const b of st.bars) {
        if (b.side < 0) {           // donor: what stays (solid) + what leaves (ghost, drawn separately)
          I.push(b.x, b.z, 0, b.full - b.part * ph); C.push(...TEAL, id(b));
        } else {                    // receiver: arrived money (teal) under the remaining gap (coral)
          const got = b.part * ph;
          if (got > 0.002) { I.push(b.x, b.z, 0, got); C.push(...TEAL, id(b)); }
          I.push(b.x, b.z, got, b.full); C.push(...CORAL, id(b));
        }
      }
      st.solidN = I.length / 4;
      for (const b of st.bars) if (b.side < 0 && b.part * ph > 0.002) { I.push(b.x, b.z, b.full - b.part * ph, b.full); C.push(...TEAL, id(b)); }
      st.ghostN = I.length / 4 - st.solidN;
      gl.bindBuffer(gl.ARRAY_BUFFER, binst); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(I), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bcol); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(C), gl.DYNAMIC_DRAW);
      labels.forEach((l) => { if (l.bar !== undefined) l.el.classList.toggle('dim', st.hover >= 0 && !rel.has(l.bar)); });
    }

    let labels = [];
    function buildLabels(d) {
      if (!labelLayer) return;
      labelLayer.innerHTML = ''; labels = [];
      for (const b of st.bars) {
        const el = document.createElement('span'); el.className = 'fw-bar ' + (b.side < 0 ? 'l' : 'r');
        el.innerHTML = `<b></b><i></i>`; el.firstChild.textContent = b.name; el.lastChild.textContent = b.sub;
        labelLayer.appendChild(el);
        labels.push({ el, p: [b.x + b.side * (W / 2 + 0.5), 0, b.z], align: b.side < 0 ? 'right' : 'left', bar: b.i });
      }
      const head = (txt, side, n, cls) => {
        if (!n) return;
        const el = document.createElement('span'); el.className = 'fw-head ' + cls; el.textContent = txt;
        labelLayer.appendChild(el); labels.push({ el, p: [side * XS, 0, (n / 2) * ZS + 0.8], align: 'center' });
      };
      head('可釋出餘額', -1, d.donors.length, 'l'); head('預計超支缺口', 1, d.receivers.length, 'r');
      measure();
    }
    /** Narrow screens hide the per-bar labels (tap a bar instead) so the scene keeps its width. */
    function measure() {
      const compact = (canvas.clientWidth || st.w) < 560;
      if (labelLayer) labelLayer.classList.toggle('compact', compact);
      const wOf = (al) => (compact ? 34 : Math.max(0, ...labels.filter((l) => l.align === al).map((l) => l.el.offsetWidth)));
      st.labelL = wOf('right'); st.labelR = wOf('left');
    }

    function camera() {
      const aspect = st.w / st.h, fov = 30 * Math.PI / 180, narrow = aspect < 1.1;
      const phi = narrow ? 0.8 : 0.5, theta = st.yaw;
      const target = [0, 0.8, 0], dist = 30;
      const eye = [dist * Math.cos(phi) * Math.sin(theta), target[1] + dist * Math.sin(phi), dist * Math.cos(phi) * Math.cos(theta)];
      const vp0 = M4.mul(M4.persp(fov, aspect, 0.5, 300), M4.lookAt(eye, target, [0, 1, 0]));
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const c of st.fitPts) {
        const q = M4.apply(vp0, c), x = q[0] / q[3], y = q[1] / q[3];
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (!Number.isFinite(x0)) { x0 = y0 = -1; x1 = y1 = 1; }
      // leave room for the HTML labels on both sides and the column headings at the top
      const R = { x0: -1 + 2 * ((st.labelL || 0) + 14) / st.w, x1: 1 - 2 * ((st.labelR || 0) + 14) / st.w, y0: -1 + 2 * 30 / st.h, y1: 0.95 };
      if (R.x1 - R.x0 < 0.4) { R.x0 = -0.2; R.x1 = 0.2; }
      const xr = (R.x1 - R.x0) / (x1 - x0), yr = (R.y1 - R.y0) / (y1 - y0), k = Math.min(xr, yr);
      const kx = Math.min(xr, k * 1.35), ky = Math.min(yr, k * 1.35);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, tx = (R.x0 + R.x1) / 2, ty = (R.y0 + R.y1) / 2;
      st.vp = M4.mul([kx, 0, 0, 0, 0, ky, 0, 0, 0, 0, 1, 0, tx - kx * cx, ty - ky * cy, 0, 1], vp0);
      st.scale = Math.min(kx, ky) * st.h * 1.6;
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

    function draw(now) {
      camera();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(lp); gl.uniformMatrix4fv(lu.vp, false, st.vp); gl.uniform4f(lu.color, 0.62, 0.70, 0.82, 0.22);
      gl.bindVertexArray(lvao); gl.depthMask(false); gl.drawArrays(gl.LINES, 0, st.lineVerts);

      gl.useProgram(bp); gl.uniformMatrix4fv(bu.vp, false, st.vp); gl.uniform1f(bu.w, W); gl.uniform1f(bu.hover, st.hover);
      gl.bindVertexArray(bvao);
      gl.depthMask(true); gl.uniform1f(bu.alpha, 1);
      if (st.solidN) gl.drawArraysInstanced(gl.TRIANGLES, 0, boxCount, st.solidN);
      if (st.ghostN) {
        // the released slice: drawn as a translucent ghost on top of what stays (instance offset via a second pointer)
        gl.depthMask(false); gl.uniform1f(bu.alpha, 0.18);
        gl.bindBuffer(gl.ARRAY_BUFFER, binst); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, st.solidN * 16);
        gl.bindBuffer(gl.ARRAY_BUFFER, bcol); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, st.solidN * 16);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, boxCount, st.ghostN);
        gl.bindBuffer(gl.ARRAY_BUFFER, binst); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bcol); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
      }

      // ribbons appear from the donor end as the phase advances
      const reveal = Math.min(1.05, st.phase * 1.25);
      gl.useProgram(rp); gl.uniformMatrix4fv(ru.vp, false, st.vp); gl.uniform1f(ru.reveal, reveal); gl.uniform1f(ru.hover, st.hover);
      gl.bindVertexArray(rvao); gl.depthMask(false); gl.disable(gl.CULL_FACE);
      gl.drawArrays(gl.TRIANGLES, 0, st.ribbonVerts);

      // particles travelling along each ribbon (frozen when reduced motion is on)
      if (st.phase > 0.02) {
        const t = st.reduced ? 0.35 : (now - st.t0) / 2600, P = [];
        for (const m of st.moves) {
          if (st.hover >= 0 && m.a !== st.hover && m.b !== st.hover) continue;
          for (let k = 0; k < m.n; k++) {
            const u = (t + k / m.n) % 1;
            if (u > reveal) continue;
            const p = bez(m.p0, m.c, m.p2, u);
            P.push(p[0], p[1], p[2], 14 + 20 * Math.min(1, m.width), m.cross ? 1 : 0);
          }
        }
        if (P.length) {
          gl.useProgram(pp); gl.uniformMatrix4fv(pu.vp, false, st.vp); gl.uniform1f(pu.scale, st.scale / 80);
          gl.bindVertexArray(pvao); gl.bindBuffer(gl.ARRAY_BUFFER, pbuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(P), gl.STREAM_DRAW);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.drawArrays(gl.POINTS, 0, P.length / 5); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        }
      }
      gl.depthMask(true); gl.bindVertexArray(null);

      for (const l of labels) {
        const [x, y, w] = project(l.p);
        const vis = w > 0 && x > -200 && x < st.w + 200;
        l.el.style.opacity = vis ? '1' : '0';
        const dx = l.align === 'right' ? '-100%' : l.align === 'center' ? '-50%' : '0';
        l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${dx}, -50%)`;
      }
    }

    let lastT = 0, spin = null;
    function frame(now) {
      st.raf = 0;
      if (spin) spin(Math.min(64, now - (lastT || now))); lastT = now;
      draw(now);
      // keep running while particles move; otherwise only redraw on demand
      const live = (!st.reduced && st.phase > 0.02 && st.moves.length) || st.dragging || Math.abs(st.vel) > 2e-5;
      if (live && st.visible && !document.hidden) st.raf = requestAnimationFrame(frame);
    }
    const start = () => { if (!st.raf) st.raf = requestAnimationFrame(frame); };

    function pick(px, py) {
      if (!st.vp) return -1;
      let best = -1, bestW = Infinity;
      for (const b of st.bars) {
        const a = project([b.x, 0, b.z]), t = project([b.x, b.full, b.z]), s = project([b.x + W / 2, 0, b.z]);
        const half = Math.max(7, Math.abs(s[0] - a[0]) * 1.2);
        const vx = t[0] - a[0], vy = t[1] - a[1], L2 = vx * vx + vy * vy || 1;
        const u = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / L2));
        const d = Math.hypot(px - (a[0] + u * vx), py - (a[1] + u * vy));
        if (d < half && a[2] < bestW) { best = b.i; bestW = a[2]; }
      }
      return best;
    }
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const k = st.dragging ? -1 : pick(px, py);
      if (k !== st.hover) { st.hover = k; updateBars(); start(); }
      if (opts.onHover) opts.onHover(k >= 0 ? st.bars[k] : null, px, py);
    });
    canvas.addEventListener('pointerleave', () => { st.hover = -1; updateBars(); if (opts.onHover) opts.onHover(null); start(); });
    canvas.addEventListener('click', (e) => {          // tap = hover on touch screens
      if (st.dragged) { st.dragged = false; return; }
      const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, k = pick(px, py);
      st.hover = k; updateBars(); start(); if (opts.onHover) opts.onHover(k >= 0 ? st.bars[k] : null, px, py);
    });
    spin = orbit(canvas, st, start, 1.0);

    new ResizeObserver(() => { resize(); measure(); start(); }).observe(canvas);
    new IntersectionObserver((es) => { st.visible = es[0].isIntersecting; if (st.visible) start(); }).observe(canvas);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
    resize();

    return {
      setData(d) { setData(d); start(); },
      setPhase(p) { st.phase = Math.max(0, Math.min(1, p)); updateBars(); start(); },
      relabel() { resize(); measure(); start(); },
      get state() { return st; },
    };
  }

  root.FPAFlow = { create };
})(window);
