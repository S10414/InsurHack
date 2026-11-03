/*
 * Small WebGL2 scene used by the variance and year-end forecast views.
 *   boxes  : instanced cuboids from y0 to y1 (y0 < y1, so bars can hang below the floor)
 *   tris   : free triangles with per-vertex RGBA (walls, bands)
 *   lines  : GL lines with per-vertex RGBA
 *   labels : HTML labels that follow the projection
 * Everything carries a group id; hovering a pick target lights its group and dims the rest.
 * uGrow scales heights from the floor (y = 0); uReveal hides geometry right of a world x.
 * The camera fits the actual content points into the canvas (lens shift + independent X/Y stretch),
 * reserving the pixel width of the side labels.
 */
(function (root) {
  'use strict';
  const { M4, compile, boxGeometry } = root.FPAField;

  const BVS = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aNormal;
  layout(location=2) in vec4 aInst;   // x, z, y0, y1
  layout(location=3) in vec4 aSize;   // w, d, id, alpha
  layout(location=4) in vec3 aColor;
  uniform mat4 uVP; uniform float uGrow;
  out vec3 vN; out vec3 vCol; out float vId; out float vA; out float vX;
  void main(){
    vec3 p = vec3(aPos.x * aSize.x + aInst.x, mix(aInst.z, aInst.w, aPos.y) * uGrow, aPos.z * aSize.y + aInst.y);
    vN = aNormal; vCol = aColor; vId = aSize.z; vA = aSize.w; vX = p.x;
    gl_Position = uVP * vec4(p, 1.0);
  }`;
  const BFS = `#version 300 es
  precision highp float;
  in vec3 vN; in vec3 vCol; in float vId; in float vA; in float vX;
  uniform float uHover, uReveal;
  out vec4 o;
  void main(){
    if (vX > uReveal) discard;
    vec3 n = normalize(vN);
    float diff = max(dot(n, normalize(vec3(-0.45, 0.85, 0.35))), 0.0);
    vec3 c = vCol * (0.45 + 0.55 * diff) + step(0.5, abs(n.y)) * 0.07;
    float hot = uHover < -0.5 ? 0.0 : (abs(vId - uHover) < 0.5 ? 1.0 : -1.0);
    c = hot > 0.5 ? c + 0.12 : hot < -0.5 ? c * 0.5 : c;
    o = vec4(c, vA * (hot < -0.5 ? 0.6 : 1.0));
  }`;
  const TVS = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec4 aColor;
  layout(location=2) in float aId;
  uniform mat4 uVP; uniform float uGrow;
  out vec4 vCol; out float vId; out float vX;
  void main(){ vec3 p = vec3(aPos.x, aPos.y * uGrow, aPos.z); vCol = aColor; vId = aId; vX = p.x; gl_Position = uVP * vec4(p, 1.0); }`;
  const TFS = `#version 300 es
  precision highp float;
  in vec4 vCol; in float vId; in float vX;
  uniform float uHover, uReveal;
  out vec4 o;
  void main(){
    if (vX > uReveal) discard;
    float hot = uHover < -0.5 || vId < -0.5 ? 0.0 : (abs(vId - uHover) < 0.5 ? 1.0 : -1.0);
    vec3 c = hot > 0.5 ? vCol.rgb + 0.1 : hot < -0.5 ? vCol.rgb * 0.55 : vCol.rgb;
    o = vec4(c, vCol.a * (hot > 0.5 ? 1.25 : hot < -0.5 ? 0.45 : 1.0));
  }`;

  function create(canvas, labelLayer, opts = {}) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) return null;
    const bp = compile(gl, BVS, BFS), tp = compile(gl, TVS, TFS);
    const U = (p, n) => gl.getUniformLocation(p, n);
    const bu = { vp: U(bp, 'uVP'), grow: U(bp, 'uGrow'), hover: U(bp, 'uHover'), reveal: U(bp, 'uReveal') };
    const tu = { vp: U(tp, 'uVP'), grow: U(tp, 'uGrow'), hover: U(tp, 'uHover'), reveal: U(tp, 'uReveal') };

    const box = boxGeometry(), boxCount = box.length / 6;
    // full box (with bottom face so bars hanging below the floor look closed)
    const bottom = [[-.5, 0, .5], [.5, 0, .5], [.5, 0, -.5], [-.5, 0, -.5]];
    const full = [...box];
    for (const i of [0, 1, 2, 0, 2, 3]) full.push(...bottom[i], 0, -1, 0);
    const fullArr = new Float32Array(full), fullCount = fullArr.length / 6;
    function boxSet() {
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const g = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, g); gl.bufferData(gl.ARRAY_BUFFER, fullArr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      const ib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ib);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 44, 0); gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 44, 16); gl.vertexAttribDivisor(3, 1);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 3, gl.FLOAT, false, 44, 32); gl.vertexAttribDivisor(4, 1);
      gl.bindVertexArray(null);
      return { vao, ib, n: 0 };
    }
    function vertSet() {
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 28);
      gl.bindVertexArray(null);
      return { vao, b, n: 0 };
    }
    const S = { solid: boxSet(), glass: boxSet(), tris: vertSet(), lines: vertSet() };
    void boxCount;

    const st = { w: 1, h: 1, vp: null, grow: 1, reveal: 1e9, hover: -1, picks: [], fit: [], labels: [], visible: true, raf: 0,
      cam: Object.assign({ phi: 0.6, theta: -0.35, phiNarrow: 0.85, thetaNarrow: -0.15, sx: 1.8, sy: 1.8, top: 6, bottom: 6 }, opts.camera || {}) };

    function setData(d) {
      const up = (set, arr, per) => { gl.bindBuffer(gl.ARRAY_BUFFER, set.ib || set.b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW); set.n = arr.length / per; };
      const solid = [], glass = [];
      for (const b of d.boxes || []) {
        const a = b.alpha ?? 1;
        (a < 1 ? glass : solid).push(b.x, b.z, Math.min(b.y0, b.y1), Math.max(b.y0, b.y1), b.w ?? 0.6, b.d ?? 0.6, b.id ?? -1, a, ...b.color);
      }
      up(S.solid, solid, 11); up(S.glass, glass, 11);
      const T = [];
      for (const t of d.tris || []) for (const v of t.v) T.push(v[0], v[1], v[2], ...(v[3] || t.color), t.id ?? -1);
      up(S.tris, T, 8);
      const L = [];
      for (const l of d.lines || []) for (const v of [l.a, l.b]) L.push(v[0], v[1], v[2], ...l.color, l.id ?? -1);
      up(S.lines, L, 8);
      st.fit = d.fit || [];
      st.picks = d.picks || [];
      buildLabels(d.labels || []);
      start();
    }

    function buildLabels(list) {
      if (!labelLayer) return;
      labelLayer.innerHTML = '';
      st.labels = list.map((l) => {
        const el = document.createElement('span'); el.className = 'sc-l ' + (l.cls || '');
        if (l.html) el.innerHTML = l.html; else el.textContent = l.text;
        labelLayer.appendChild(el);
        return { ...l, el };
      });
      measure();
    }
    function measure() {
      if (labelLayer) labelLayer.classList.toggle('compact', (canvas.clientWidth || st.w) < 560);
      const wOf = (al) => Math.max(0, ...st.labels.filter((l) => l.align === al && l.reserve !== false).map((l) => l.el.offsetWidth));
      st.labelL = wOf('right'); st.labelR = wOf('left');
    }

    function camera() {
      const c = st.cam, aspect = st.w / st.h, narrow = aspect < 1.1, fov = 30 * Math.PI / 180;
      const phi = narrow ? c.phiNarrow : c.phi, theta = narrow ? c.thetaNarrow : c.theta;
      const target = [0, 0, 0], dist = 30;
      const eye = [dist * Math.cos(phi) * Math.sin(theta), dist * Math.sin(phi), dist * Math.cos(phi) * Math.cos(theta)];
      const vp0 = M4.mul(M4.persp(fov, aspect, 0.5, 300), M4.lookAt(eye, target, [0, 1, 0]));
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of st.fit) {
        const q = M4.apply(vp0, p), x = q[0] / q[3], y = q[1] / q[3];
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (!Number.isFinite(x0)) { x0 = y0 = -1; x1 = y1 = 1; }
      const R = { x0: -1 + 2 * ((st.labelL || 0) + 10) / st.w, x1: 1 - 2 * ((st.labelR || 0) + 10) / st.w, y0: -1 + 2 * c.bottom / st.h, y1: 1 - 2 * c.top / st.h };
      if (R.x1 - R.x0 < 0.4) { R.x0 = -0.2; R.x1 = 0.2; }
      const xr = (R.x1 - R.x0) / (x1 - x0 || 1), yr = (R.y1 - R.y0) / (y1 - y0 || 1), k = Math.min(xr, yr);
      const kx = Math.min(xr, k * c.sx), ky = Math.min(yr, k * (narrow && c.syNarrow ? c.syNarrow : c.sy));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, tx = (R.x0 + R.x1) / 2, ty = (R.y0 + R.y1) / 2;
      st.vp = M4.mul([kx, 0, 0, 0, 0, ky, 0, 0, 0, 0, 1, 0, tx - kx * cx, ty - ky * cy, 0, 1], vp0);
    }
    function project(p) {
      const q = M4.apply(st.vp, [p[0], p[1] * st.grow, p[2]]);
      return [(q[0] / q[3] * 0.5 + 0.5) * st.w, (1 - (q[1] / q[3] * 0.5 + 0.5)) * st.h, q[3]];
    }
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2), r = canvas.getBoundingClientRect();
      st.w = Math.max(1, r.width); st.h = Math.max(1, r.height);
      canvas.width = Math.round(st.w * dpr); canvas.height = Math.round(st.h * dpr);
    }

    function draw() {
      camera();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const hov = st.hoverGroup ?? -1;
      // lines first (grid), no depth write
      gl.useProgram(tp); gl.uniformMatrix4fv(tu.vp, false, st.vp); gl.uniform1f(tu.grow, st.grow); gl.uniform1f(tu.hover, hov); gl.uniform1f(tu.reveal, st.reveal);
      gl.depthMask(false);
      if (S.lines.n) { gl.bindVertexArray(S.lines.vao); gl.drawArrays(gl.LINES, 0, S.lines.n); }
      gl.useProgram(bp); gl.uniformMatrix4fv(bu.vp, false, st.vp); gl.uniform1f(bu.grow, st.grow); gl.uniform1f(bu.hover, hov); gl.uniform1f(bu.reveal, st.reveal);
      gl.depthMask(true);
      if (S.solid.n) { gl.bindVertexArray(S.solid.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, fullCount, S.solid.n); }
      gl.depthMask(false);
      if (S.glass.n) { gl.bindVertexArray(S.glass.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, fullCount, S.glass.n); }
      if (S.tris.n) {
        gl.useProgram(tp); gl.bindVertexArray(S.tris.vao); gl.drawArrays(gl.TRIANGLES, 0, S.tris.n);
      }
      gl.depthMask(true); gl.bindVertexArray(null);

      for (const l of st.labels) {
        const [x, y, w] = project(l.p);
        const hidden = l.p[0] > st.reveal || w <= 0;
        const dim = hov >= 0 && l.id !== undefined && l.id !== hov;
        l.el.style.opacity = hidden ? '0' : dim ? '0.35' : '1';
        const dx = l.align === 'right' ? '-100%' : l.align === 'center' ? '-50%' : '0';
        l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${dx}, -50%)`;
      }
    }
    function frame() { st.raf = 0; draw(); }
    const start = () => { if (!st.raf && st.visible) st.raf = requestAnimationFrame(frame); };

    // picking: segments a-b in world space (a bar's axis, or a single point), nearest on screen wins
    function pick(px, py) {
      if (!st.vp) return null;
      let best = null, bd = Infinity;
      for (const p of st.picks) {
        if (p.a[0] > st.reveal) continue;
        const a = project(p.a), b = project(p.b || p.a);
        const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy;
        const t = L2 ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / L2)) : 0;
        const d = Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
        if (d < (p.r || 10) && d - a[2] * 0.01 < bd) { bd = d - a[2] * 0.01; best = p; }
      }
      return best;
    }
    function setHover(p, px, py) {
      const g = p ? p.group ?? -1 : -1;
      if (p !== st.hoverPick) { st.hoverPick = p; st.hoverGroup = g; canvas.style.cursor = p && opts.onPick ? 'pointer' : ''; start(); }
      if (opts.onHover) opts.onHover(p ? p.data : null, px, py);
    }
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      setHover(pick(px, py), px, py);
    });
    canvas.addEventListener('pointerleave', () => setHover(null));
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, p = pick(px, py);
      if (p && opts.onPick && (e.pointerType === 'mouse' || st.hoverPick === p)) opts.onPick(p.data);
      else setHover(p, px, py);             // first tap on touch screens shows the tooltip
    });

    new ResizeObserver(() => { resize(); measure(); start(); }).observe(canvas);
    new IntersectionObserver((es) => { st.visible = es[0].isIntersecting; if (st.visible) start(); }).observe(canvas);
    resize();

    return {
      setData,
      setAnim(a) { if (a.grow !== undefined) st.grow = a.grow; if (a.reveal !== undefined) st.reveal = a.reveal; start(); },
      relabel() { resize(); measure(); start(); },
      get state() { return st; },
    };
  }

  root.FPAScene = { create };
})(window);
