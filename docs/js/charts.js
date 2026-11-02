/* Dependency-free SVG charts. Colors come from CSS variables so they follow light/dark mode. */
(function (root) {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function niceScale(top, n = 4) {
    const raw = Math.max(top, 1e-9) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
    const steps = Math.max(1, Math.ceil(top / step - 1e-9));
    return { step, steps, max: step * steps };
  }
  function unitFor(v) { return v >= 1e9 ? [1e9, '十億'] : v >= 1e6 ? [1e6, '百萬'] : [1e3, '千']; }
  const num = (v, d = 0) => v.toLocaleString('zh-TW', { maximumFractionDigits: d, minimumFractionDigits: d });

  /** Cumulative budget / actual / forecast with an 80% band. path from FPA.groupPath. */
  function cumulative(el, path, m, tipEl) {
    const W = 680, H = 300, L = 54, R = 16, T = 18, B = 28;
    const top = Math.max(...path.budget, ...path.hi, ...path.actual) * 1.03;
    const sc = niceScale(top), ymax = sc.max, [u, uname] = unitFor(ymax);
    const xs = (i) => L + (W - L - R) * (i / 11), ys = (v) => T + (H - T - B) * (1 - v / ymax);
    const line = (arr, off = 0) => arr.map((v, i) => `${i ? 'L' : 'M'}${xs(i + off).toFixed(1)},${ys(v).toFixed(1)}`).join('');
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="累計預算、實際與預測">`;
    for (let i = 0; i <= sc.steps; i++) {
      const v = sc.step * i;
      s += `<line x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${ys(v) + 4}" text-anchor="end">${num(v / u, u >= 1e9 ? (sc.step / u < 1 ? 2 : 1) : 0)}</text>`;
    }
    for (let i = 0; i < 12; i++) s += `<text x="${xs(i)}" y="${H - 8}" text-anchor="middle">${i + 1}月</text>`;
    s += `<text x="${L}" y="10">${uname}元</text>`;
    const cid = 'rv-' + (el.id || Math.random().toString(36).slice(2));
    s += `<defs><clipPath id="${cid}"><rect class="reveal-rect" x="0" y="0" width="${W}" data-w="${W}" height="${H}"/></clipPath></defs><g clip-path="url(#${cid})">`;
    if (m < 12) {
      const base = path.actual[m - 1];
      const hi = [base, ...path.hi], lo = [base, ...path.lo];
      const up = hi.map((v, i) => `${i ? 'L' : 'M'}${xs(i + m - 1).toFixed(1)},${ys(v).toFixed(1)}`).join('');
      const dn = lo.map((v, i) => `L${xs(i + m - 1).toFixed(1)},${ys(v).toFixed(1)}`).reverse().join('');
      s += `<path d="${up}${dn}Z" fill="var(--accent)" opacity=".16"/>`;
    }
    s += `<path d="${line(path.budget)}" fill="none" stroke="var(--budget)" stroke-width="2.5"/>`;
    s += `<path d="${line(path.actual)}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>`;
    if (m < 12) {
      s += `<path d="${line([path.actual[m - 1], ...path.forecast], m - 1)}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-dasharray="6 4"/>`;
      s += `<line x1="${xs(m - 1)}" x2="${xs(m - 1)}" y1="${T}" y2="${H - B}" stroke="var(--mute)" stroke-dasharray="2 3"/>`;
      s += `<circle cx="${xs(11)}" cy="${ys(path.forecast[path.forecast.length - 1])}" r="4" fill="var(--accent)"/>`;
    }
    s += '</g>';
    s += `<rect class="hov" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg>`;
    el.innerHTML = s;
    const rect = el.querySelector('.hov');
    rect.onmousemove = (e) => {
      const bx = rect.getBoundingClientRect();
      const i = Math.max(0, Math.min(11, Math.round((e.clientX - bx.left) / bx.width * 11)));
      const a = i < m ? `累計實際 ${num(path.actual[i] / 1e6, 1)}` : `累計預測 ${num(path.forecast[i - m] / 1e6, 1)}（${num(path.lo[i - m] / 1e6, 1)}～${num(path.hi[i - m] / 1e6, 1)}）`;
      if (tipEl) tipEl.textContent = `${i + 1} 月｜累計預算 ${num(path.budget[i] / 1e6, 1)}｜${a}（百萬元）`;
    };
  }

  /** Waterfall of budget -> deviations -> actual. items from FPA.waterfall. Axis is truncated. */
  function waterfall(el, items) {
    const W = 680, H = 320, L = 14, R = 14, T = 26, B = 70;
    let run = 0; const bars = []; const levels = [];
    for (const it of items) {
      if (it.kind === 'total') { bars.push({ a: it.value, b: 0, it, end: it.value }); run = it.value; levels.push(it.value); }
      else { const a = run, b = run + it.value; bars.push({ a: b, b: a, it, end: b }); run = b; levels.push(b); }
    }
    const lo0 = Math.min(...levels), hi0 = Math.max(...levels), rng = Math.max(hi0 - lo0, hi0 * 0.02);
    const ymin = lo0 - rng * 0.25, ymax = hi0 + rng * 0.15;
    const ys = (v) => T + (H - T - B) * (1 - (v - ymin) / (ymax - ymin));
    const bw = (W - L - R) / bars.length, u = 1e6;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="預算到實際的差異瀑布圖">`;
    bars.forEach((b, i) => {
      const x = L + i * bw + bw * 0.15, w = bw * 0.7, t = b.it.kind === 'total';
      const top = Math.max(b.a, b.b === 0 ? ymin : b.b), bot = t ? ymin : Math.min(b.a, b.b);
      const y1 = ys(t ? b.a : Math.max(b.a, b.b)), y2 = ys(t ? ymin : Math.min(b.a, b.b));
      const color = t ? 'var(--budget)' : b.it.value > 0 ? 'var(--red)' : 'var(--accent)';
      s += `<rect class="wf" x="${x}" y="${y1}" width="${w}" height="${Math.max(2, y2 - y1)}" fill="${color}" rx="2"/>`;
      const lab = t ? num(b.it.value / u, 1) : (b.it.value > 0 ? '+' : '') + num(b.it.value / u, 1);
      s += `<text x="${x + w / 2}" y="${y1 - 5}" text-anchor="middle">${lab}</text>`;
      s += `<text x="${x + w / 2}" y="${H - B + 14}" text-anchor="end" transform="rotate(-35 ${x + w / 2} ${H - B + 14})">${esc(b.it.label)}</text>`;
      if (i < bars.length - 1) s += `<line x1="${x + w}" x2="${x + bw}" y1="${ys(b.end)}" y2="${ys(b.end)}" stroke="var(--mute)" stroke-dasharray="2 2"/>`;
      void top; void bot;
    });
    s += `<text x="${L}" y="12">單位：百萬元（縱軸已截斷，只用來比較差異）</text></svg>`;
    el.innerHTML = s;
  }

  /** Monthly variance bars (actual - budget): red = overspend, green = under. */
  function varianceBars(el, rows, tipEl) {
    const W = 680, H = 240, L = 54, R = 12, T = 16, B = 30;
    if (!rows.length) { el.innerHTML = '<p class="small">沒有資料</p>'; return; }
    const mx = niceMax(Math.max(...rows.map((r) => Math.abs(r.variance)), 1)), [u, uname] = unitFor(mx);
    const ys = (v) => T + (H - T - B) * (0.5 - v / (2 * mx)), bw = (W - L - R) / rows.length;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="每月預算差異">`;
    for (const f of [-1, -0.5, 0, 0.5, 1]) s += `<line x1="${L}" x2="${W - R}" y1="${ys(mx * f)}" y2="${ys(mx * f)}" stroke="var(--line)"/><text x="${L - 6}" y="${ys(mx * f) + 4}" text-anchor="end">${num(mx * f / u, u >= 1e9 ? 1 : 0)}</text>`;
    s += `<text x="${L}" y="10">${uname}元</text>`;
    rows.forEach((r, i) => {
      const x = L + i * bw + bw * 0.12, w = bw * 0.76, y0 = ys(0), y1 = ys(r.variance);
      s += `<rect class="vb" data-i="${i}" x="${x}" y="${Math.min(y0, y1)}" width="${w}" height="${Math.max(1, Math.abs(y1 - y0))}" fill="${r.variance > 0 ? 'var(--red)' : 'var(--accent)'}" rx="1"/>`;
      if (i % 3 === 0 || rows.length < 14) s += `<text x="${x + w / 2}" y="${H - 10}" text-anchor="middle">${String(r.year).slice(2)}/${r.month}</text>`;
    });
    s += '</svg>';
    el.innerHTML = s;
    el.querySelectorAll('.vb').forEach((b) => {
      b.onmouseenter = () => { const r = rows[+b.dataset.i]; if (tipEl) tipEl.textContent = `${r.year}/${r.month}｜預算 ${num(r.budget / 1e6, 1)}｜實際 ${num(r.actual / 1e6, 1)}｜差異 ${r.variance > 0 ? '+' : ''}${num(r.variance / 1e6, 2)}（${(r.pct * 100).toFixed(1)}%）百萬元`; };
    });
  }

  /** Lines of cumulative share-of-year by month. lines: [{label, values, color, dash, width, from}] */
  function shareLines(el, lines, m) {
    const W = 680, H = 260, L = 44, R = 90, T = 14, B = 28;
    const xs = (i) => L + (W - L - R) * (i / 11), ys = (v) => T + (H - T - B) * (1 - v);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="各月累計支出占全年比例">`;
    for (let i = 0; i <= 4; i++) s += `<line x1="${L}" x2="${W - R}" y1="${ys(i / 4)}" y2="${ys(i / 4)}" stroke="var(--line)"/><text x="${L - 6}" y="${ys(i / 4) + 4}" text-anchor="end">${i * 25}%</text>`;
    for (let i = 0; i < 12; i++) s += `<text x="${xs(i)}" y="${H - 8}" text-anchor="middle">${i + 1}月</text>`;
    for (const ln of lines) {
      const pts = ln.values.map((v, i) => (Number.isFinite(v) ? `${xs(i).toFixed(1)},${ys(v).toFixed(1)}` : null)).filter(Boolean);
      if (!pts.length) continue;
      s += `<polyline points="${pts.join(' ')}" fill="none" stroke="${ln.color}" stroke-width="${ln.width || 2}" ${ln.dash ? `stroke-dasharray="${ln.dash}"` : ''}/>`;
      const last = ln.values.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v)).pop();
      if (ln.label) s += `<text x="${xs(last[1]) + 6}" y="${ys(last[0]) + 4}" style="fill:${ln.color}">${esc(ln.label)}</text>`;
    }
    s += '</svg>';
    el.innerHTML = s;
  }

  root.FPACharts = { cumulative, waterfall, varianceBars, shareLines, esc, num };
})(window);
