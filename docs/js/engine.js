/*
 * Budget analysis engine (browser port of the tested Python modules in src/analysis and src/forecast).
 * Parity with the Python implementation is checked by tests/js/parity.test.js.
 *
 * Conventions: variance = actual - budget (positive = overspend). Amounts in NTD.
 */
(function (root) {
  'use strict';

  const METHODS = ['pace', 'recent', 'seasonal', 'hist_rate'];
  const METHOD_LABELS = {
    pace: '年累計進度法', recent: '近三月趨勢法', seasonal: '歷史季節型態法', hist_rate: '歷史執行率法',
  };
  const Z80 = 1.2816;

  const DEFAULT_SETTINGS = {
    risk: { pRed: 0.75, redPct: 0.005, minAmount: 1e6, underRate: 0.85, pYellow: 0.5, yellowPct: 0.01 },
    paceAhead: 0.05, paceBehind: -0.10,
    materialPct: 0.10, materialAmount: 1e6,
  };

  // ------------------------------------------------------------------ small helpers
  const isNum = (x) => typeof x === 'number' && !Number.isNaN(x);
  const sum = (a, i, j) => { let s = 0; for (let t = i; t < j; t++) s += a[t]; return s; };
  const div = (a, b) => (b > 0 ? a / b : NaN);
  const nz = (x) => (Number.isNaN(x) ? 0 : x);
  function nanmean(arr) {
    let s = 0, n = 0;
    for (const x of arr) if (!Number.isNaN(x)) { s += x; n++; }
    return n ? s / n : NaN;
  }
  function median(arr) {
    const a = arr.filter((x) => !Number.isNaN(x)).sort((x, y) => x - y);
    if (!a.length) return NaN;
    const h = a.length >> 1;
    return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
  }
  function erf(x) { // Abramowitz-Stegun 7.1.26, |error| < 1.5e-7
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const normCdf = (z) => (z === Infinity ? 1 : z === -Infinity ? 0 : 0.5 * (1 + erf(z / Math.SQRT2)));
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // ------------------------------------------------------------------ panel
  /** rows: [{year, month, dept, cat, budget, actual|null}] -> panel as of (year, m). */
  function makePanel(rows, year, m) {
    const used = rows.filter((r) => r.year <= year);
    const years = [...new Set(used.map((r) => r.year))].sort((a, b) => a - b);
    const kmap = new Map();
    for (const r of used) kmap.set(r.dept + '\u0001' + r.cat, { dept: r.dept, cat: r.cat });
    const keys = [...kmap.values()].sort((a, b) => cmp(a.dept, b.dept) || cmp(a.cat, b.cat));
    const idx = new Map(keys.map((k, i) => [k.dept + '\u0001' + k.cat, i]));
    const yidx = new Map(years.map((y, i) => [y, i]));
    const mk = () => keys.map(() => years.map(() => new Float64Array(12).fill(NaN)));
    const B = mk(), A = mk();
    for (const r of used) {
      const k = idx.get(r.dept + '\u0001' + r.cat), y = yidx.get(r.year), mi = r.month - 1;
      if (isNum(r.budget)) B[k][y][mi] = nz(B[k][y][mi]) + r.budget;
      if (isNum(r.actual) && !(r.year === year && r.month > m)) A[k][y][mi] = nz(A[k][y][mi]) + r.actual;
    }
    return { keys, years, B, A, K: keys.length, yi: years.indexOf(year), year, m };
  }

  // ------------------------------------------------------------------ methods
  function methodFactors(P, yi, m, recentN = 3) {
    const out = [];
    for (let k = 0; k < P.K; k++) {
      const B = P.B[k][yi], A = P.A[k][yi];
      const ytdA = sum(A, 0, m), ytdB = sum(B, 0, m), remB = sum(B, m, 12);
      const f = [NaN, NaN, NaN, NaN];
      f[0] = div(ytdA, ytdB);
      const lo = Math.max(0, m - recentN);
      f[1] = div(sum(A, lo, m), sum(B, lo, m));
      if (yi > 0) {
        let mr = 0, rt = 0;
        for (let y = 0; y < yi; y++) {
          mr += div(sum(P.A[k][y], 0, m), sum(P.A[k][y], 0, 12));
          rt += div(sum(P.A[k][y], 0, 12), sum(P.B[k][y], 0, 12));
        }
        mr /= yi; rt /= yi;
        f[2] = div(div(ytdA, mr) - ytdA, remB);
        f[3] = div(rt * (ytdB + remB) - ytdA, remB);
      }
      out.push(f.map((x) => (Number.isNaN(x) ? x : Math.max(x, 0))));
    }
    return out;
  }
  const trueFactor = (P, yi, m) => P.keys.map((_, k) => div(sum(P.A[k][yi], m, 12), sum(P.B[k][yi], m, 12)));

  function fitWeights(P, m, trainYis, o = {}) {
    const { window = 2, shrink = 0.5, sigmaFloor = 0.03, inflate = 1.25, defaultSigma = 0.12 } = o;
    const M = METHODS.length;
    if (!trainYis.length) {
      return { W: P.keys.map(() => METHODS.map(() => 1 / M)), sigma: P.keys.map(() => defaultSigma), n: 0 };
    }
    const F = [], T = [];
    for (const yi of trainYis) {
      for (let mm = Math.max(3, m - window); mm <= Math.min(11, m + window); mm++) {
        F.push(methodFactors(P, yi, mm)); T.push(trueFactor(P, yi, mm));
      }
    }
    const S = F.length;
    const mseK = P.keys.map((_, k) => METHODS.map((_, j) => {
      const e = []; for (let s = 0; s < S; s++) e.push((F[s][k][j] - T[s][k]) ** 2);
      return nanmean(e);
    }));
    const mseG = METHODS.map((_, j) => nanmean(mseK.map((r) => r[j])));
    const W = mseK.map((row) => {
      const w = row.map((v, j) => {
        const eff = shrink * mseG[j] + (1 - shrink) * v;
        return Number.isNaN(eff) ? 0 : 1 / Math.max(eff, 1e-6);
      });
      const t = w.reduce((a, b) => a + b, 0);
      return w.map((x) => x / t);
    });
    const varK = P.keys.map((_, k) => {
      let s = 0;
      for (let i = 0; i < S; i++) {
        let e = 0;
        for (let j = 0; j < M; j++) e += W[k][j] * nz(F[i][k][j] - T[i][k]);
        s += e * e;
      }
      return s / S;
    });
    const byCat = new Map();
    P.keys.forEach((key, k) => { if (!byCat.has(key.cat)) byCat.set(key.cat, []); byCat.get(key.cat).push(varK[k]); });
    const sigma = P.keys.map((key) => inflate * Math.max(Math.sqrt(nanmean(byCat.get(key.cat))), sigmaFloor));
    return { W, sigma, n: S };
  }

  function blend(f, w) {
    let num = 0, den = 0;
    for (let j = 0; j < f.length; j++) if (!Number.isNaN(f[j])) { num += w[j] * f[j]; den += w[j]; }
    return num / den;
  }

  // ------------------------------------------------------------------ spikes & one-offs
  /** Single-month / persistent spikes of the current year (same rule as Python flag_spikes). */
  function flagSpikes(P, ratioThr = 1.5, zThr = 3.0, lookback = 12) {
    const out = [];
    for (let k = 0; k < P.K; k++) {
      const obs = [];
      for (let y = 0; y <= P.yi; y++) {
        for (let mi = 0; mi < 12; mi++) {
          if (y === P.yi && mi >= P.m) break;
          const a = P.A[k][y][mi];
          if (isNum(a)) obs.push({ y, mi, a, b: P.B[k][y][mi] });
        }
      }
      const ratio = obs.map((o) => div(o.a, o.b));
      const high = ratio.map((r) => r >= ratioThr);
      obs.forEach((o, i) => {
        if (o.y !== P.yi) return;
        const prior = obs.slice(Math.max(0, i - lookback), i).map((x) => x.a);
        if (prior.length < 6) return;
        const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
        const sd = Math.sqrt(prior.reduce((a, b) => a + (b - mean) ** 2, 0) / (prior.length - 1));
        const z = sd > 0 ? (o.a - mean) / sd : NaN;
        if (ratio[i] >= ratioThr && z >= zThr) {
          const nb = (i > 0 && high[i - 1]) || (i < obs.length - 1 && high[i + 1]);
          out.push({ k, month: o.mi + 1, actual: o.a, budget: o.b, ratio: ratio[i], z, pattern: nb ? '持續偏高' : '單月異常' });
        }
      });
    }
    return out;
  }

  function normalizeOneOffs(P) {
    const spikes = flagSpikes(P).filter((s) => s.pattern === '單月異常');
    if (!spikes.length) return { panel: P, log: [] };
    const A = P.A.map((row) => row.slice());
    const log = [];
    for (const s of spikes) {
      const cur = P.A[s.k][P.yi], B = P.B[s.k][P.yi];
      const others = [];
      for (let mi = 0; mi < P.m; mi++) if (mi + 1 !== s.month && isNum(cur[mi])) others.push(cur[mi] / B[mi]);
      const normal = B[s.month - 1] * median(others);
      A[s.k] = A[s.k].slice(); A[s.k][P.yi] = Float64Array.from(cur); A[s.k][P.yi][s.month - 1] = normal;
      log.push({ k: s.k, dept: P.keys[s.k].dept, cat: P.keys[s.k].cat, month: s.month, actual: s.actual,
        normalized: normal, oneOff: s.actual - normal });
    }
    return { panel: Object.assign({}, P, { A }), log };
  }

  // ------------------------------------------------------------------ risk
  function classifyRisk(rate, p, gap, fyBudget, r = DEFAULT_SETTINGS.risk) {
    const pct = fyBudget ? gap / fyBudget : 0;
    if (p >= r.pRed && pct >= r.redPct && gap >= r.minAmount) return '紅燈・預計超支';
    if (rate < r.underRate && -gap >= r.minAmount) return '黃燈・預計大幅未執行';
    if (p >= r.pYellow && pct >= r.yellowPct && gap >= r.minAmount * 0.25) return '黃燈・小幅超支風險';
    return '綠燈・正常';
  }
  const riskClass = (s) => (s.startsWith('紅') ? 'red' : s.startsWith('黃') ? 'amber' : 'green');

  function finish(g, risk) {
    g.rate = g.fyForecast / g.fyBudget;
    g.gap = g.fyForecast - g.fyBudget;
    g.lo = Math.max(g.fyForecast - Z80 * g.sd, g.ytdActual);
    g.hi = g.fyForecast + Z80 * g.sd;
    const z = g.sd > 0 ? (g.fyBudget - g.fyForecast) / g.sd : Infinity;
    g.pOver = 1 - normCdf(z);
    g.risk = classifyRisk(g.rate, g.pOver, g.gap, g.fyBudget, risk);
    return g;
  }

  // ------------------------------------------------------------------ forecast
  function forecast(rows, commitments, year, m, opts = {}) {
    const risk = opts.risk || DEFAULT_SETTINGS.risk;
    const P = makePanel(rows, year, m);
    const yi = P.yi;
    let PL = P, oneOffs = [];
    if (opts.adjustOneOffs !== false) { const r = normalizeOneOffs(P); PL = r.panel; oneOffs = r.log; }
    const F = methodFactors(PL, yi, m);
    const train = []; for (let i = 1; i < yi; i++) train.push(i);
    const { W, sigma, n } = fitWeights(PL, m, train);

    const C = P.keys.map(() => new Float64Array(12));
    const kidx = new Map(P.keys.map((k, i) => [k.dept + '\u0001' + k.cat, i]));
    for (const c of commitments || []) {
      if (c.year !== year) continue;
      const k = kidx.get(c.dept + '\u0001' + c.cat);
      if (k !== undefined && c.month >= 1 && c.month <= 12) C[k][c.month - 1] += c.amount;
    }
    const floorOn = opts.floorCommitments !== false;

    const series = P.keys.map((key, k) => {
      const B = P.B[k][yi];
      const ytdA = sum(P.A[k][yi], 0, m), ytdB = sum(B, 0, m), remB = sum(B, m, 12);
      const fEns = blend(F[k], W[k]);
      const monthF = [], commitM = [];
      let binding = false;
      for (let mm = m; mm < 12; mm++) {
        let v = B[mm] * fEns; const c = C[k][mm];
        if (floorOn && c > v) { v = c; binding = true; }
        monthF.push(v); commitM.push(c);
      }
      const sdFactor = sigma[k];
      let cum = 0;
      const sdCum = [];
      for (let mm = m; mm < 12; mm++) { cum += B[mm]; sdCum.push(sdFactor * cum); }
      const fcRem = monthF.reduce((a, b) => a + b, 0);
      return finish({
        k, dept: key.dept, cat: key.cat,
        fyBudget: sum(B, 0, 12), ytdBudget: ytdB, ytdActual: ytdA, remBudget: remB,
        fcRemaining: fcRem, fyForecast: ytdA + fcRem, sd: sigma[k] * remB,
        commitRemaining: sum(C[k], m, 12), commitBinding: binding,
        factors: Object.fromEntries(METHODS.map((n2, j) => [n2, F[k][j]])), fEnsemble: fEns,
        weights: Object.fromEntries(METHODS.map((n2, j) => [n2, W[k][j]])), sigma: sdFactor,
        monthB: Array.from(B), monthA: Array.from(P.A[k][yi].slice(0, m)), monthF, sdCum,
        paceIndex: div(ytdA, ytdB),
      }, risk);
    });
    return { year, month: m, panel: P, series, oneOffs, nSamples: n, risk };
  }

  // ------------------------------------------------------------------ grouping
  const LEVELS = {
    total: { key: () => 'all', label: () => ({ name: '全公司' }) },
    dept: { key: (s) => s.dept, label: (s) => ({ dept: s.dept, name: s.dept }) },
    cat: { key: (s) => s.cat, label: (s) => ({ cat: s.cat, name: s.cat }) },
    dept_cat: { key: (s) => s.dept + '\u0001' + s.cat, label: (s) => ({ dept: s.dept, cat: s.cat, name: s.dept + '・' + s.cat }) },
  };

  function aggregate(series, level, risk) {
    const L = LEVELS[level];
    const groups = new Map();
    for (const s of series) {
      const key = L.key(s);
      if (!groups.has(key)) groups.set(key, Object.assign(L.label(s), {
        members: [], fyBudget: 0, ytdBudget: 0, ytdActual: 0, remBudget: 0, fcRemaining: 0, fyForecast: 0,
        commitRemaining: 0, varSd: 0,
      }));
      const g = groups.get(key);
      g.members.push(s);
      g.fyBudget += s.fyBudget; g.ytdBudget += s.ytdBudget; g.ytdActual += s.ytdActual; g.remBudget += s.remBudget;
      g.fcRemaining += s.fcRemaining; g.fyForecast += s.fyForecast; g.commitRemaining += s.commitRemaining;
      g.varSd += s.sd * s.sd;
    }
    return [...groups.values()].map((g) => {
      g.sd = Math.sqrt(g.varSd);
      g.paceIndex = div(g.ytdActual, g.ytdBudget);
      g.utilization = div(g.ytdActual, g.fyBudget);
      g.phased = div(g.ytdBudget, g.fyBudget);
      return finish(g, risk);
    });
  }

  /** Cumulative budget / actual / forecast and an 80% band for a set of series. */
  function groupPath(members, m) {
    const mb = Array(12).fill(0), ma = Array(m).fill(0), mf = Array(12 - m).fill(0), vr = Array(12 - m).fill(0);
    for (const s of members) {
      for (let i = 0; i < 12; i++) mb[i] += s.monthB[i];
      for (let i = 0; i < m; i++) ma[i] += s.monthA[i];
      for (let i = 0; i < 12 - m; i++) { mf[i] += s.monthF[i]; vr[i] += s.sdCum[i] ** 2; }
    }
    const cum = (a) => { let t = 0; return a.map((x) => (t += x)); };
    const cb = cum(mb), ca = cum(ma);
    const base = m ? ca[m - 1] : 0;
    let t = base;
    const cf = mf.map((x) => (t += x));
    const sd = vr.map(Math.sqrt);
    return {
      budget: cb, actual: ca, forecast: cf,
      lo: cf.map((v, i) => Math.max(v - Z80 * sd[i], base)), hi: cf.map((v, i) => v + Z80 * sd[i]),
      monthBudget: mb, monthActual: ma, monthForecast: mf,
    };
  }

  // ------------------------------------------------------------------ variance
  function windowRange(m, w) { return w === 'month' ? [m - 1, m] : w === 'qtd' ? [3 * Math.floor((m - 1) / 3), m] : [0, m]; }

  function variance(P, level, windowName, o = {}) {
    const pct = o.materialPct ?? DEFAULT_SETTINGS.materialPct, amt = o.materialAmount ?? DEFAULT_SETTINGS.materialAmount;
    const [a, b] = windowRange(P.m, windowName);
    const L = LEVELS[level];
    const groups = new Map();
    for (let k = 0; k < P.K; k++) {
      const key = P.keys[k];
      const s = { dept: key.dept, cat: key.cat };
      if (o.dept && key.dept !== o.dept) continue;
      const gk = L.key(s);
      if (!groups.has(gk)) groups.set(gk, Object.assign(L.label(s), { budget: 0, actual: 0 }));
      const g = groups.get(gk);
      g.budget += sum(P.B[k][P.yi], a, b); g.actual += sum(P.A[k][P.yi], a, b);
    }
    return [...groups.values()].map((g) => {
      g.variance = g.actual - g.budget; g.variancePct = div(g.variance, g.budget);
      g.direction = g.variance > 0 ? '超支' : '節省';
      g.material = Math.abs(g.variancePct) >= pct && Math.abs(g.variance) >= amt;
      return g;
    }).sort((x, y) => Math.abs(y.variance) - Math.abs(x.variance));
  }

  function varianceTrend(P, o = {}) {
    const months = o.months || 24, out = [];
    for (let y = 0; y <= P.yi; y++) {
      for (let mi = 0; mi < 12; mi++) {
        if (y === P.yi && mi >= P.m) break;
        let b = 0, a = 0, ok = false;
        for (let k = 0; k < P.K; k++) {
          const key = P.keys[k];
          if ((o.dept && key.dept !== o.dept) || (o.cat && key.cat !== o.cat)) continue;
          const v = P.A[k][y][mi];
          if (isNum(v)) { a += v; b += P.B[k][y][mi]; ok = true; }
        }
        if (ok) out.push({ year: P.years[y], month: mi + 1, budget: b, actual: a, variance: a - b, pct: div(a - b, b) });
      }
    }
    return out.slice(-months);
  }

  function waterfall(vars, topN = 8) {
    const head = vars.slice(0, topN), tail = vars.slice(topN);
    const budget = vars.reduce((s, v) => s + v.budget, 0), actual = vars.reduce((s, v) => s + v.actual, 0);
    const items = [{ label: '預算', value: budget, kind: 'total' }];
    for (const v of head) items.push({ label: v.name, value: v.variance, kind: 'delta' });
    if (tail.length) items.push({ label: '其他', value: tail.reduce((s, v) => s + v.variance, 0), kind: 'delta' });
    items.push({ label: '實際', value: actual, kind: 'total' });
    return items;
  }

  // ------------------------------------------------------------------ utilization
  function utilization(P, level, o = {}) {
    const ahead = o.paceAhead ?? DEFAULT_SETTINGS.paceAhead, behind = o.paceBehind ?? DEFAULT_SETTINGS.paceBehind;
    const L = LEVELS[level], m = P.m, groups = new Map();
    for (let k = 0; k < P.K; k++) {
      const s = P.keys[k], gk = L.key(s);
      if (!groups.has(gk)) groups.set(gk, Object.assign(L.label(s), { fyBudget: 0, ytdBudget: 0, ytdActual: 0, recentSum: 0 }));
      const g = groups.get(gk), B = P.B[k][P.yi], A = P.A[k][P.yi];
      g.fyBudget += sum(B, 0, 12); g.ytdBudget += sum(B, 0, m); g.ytdActual += sum(A, 0, m);
      g.recentSum += sum(A, Math.max(0, m - 3), m);
    }
    const nRecent = Math.min(3, m), left = 12 - m;
    return [...groups.values()].map((g) => {
      g.utilization = div(g.ytdActual, g.fyBudget); g.timeProgress = m / 12; g.phased = div(g.ytdBudget, g.fyBudget);
      g.pace = div(g.ytdActual, g.ytdBudget); g.remaining = g.fyBudget - g.ytdActual;
      g.recentRun = g.recentSum / nRecent; g.requiredRun = left ? g.remaining / left : NaN;
      g.runRatio = div(g.requiredRun, g.recentRun);
      g.status = g.pace > 1 + ahead ? '執行超前' : g.pace < 1 + behind ? '執行落後' : '正常';
      return g;
    }).sort((x, y) => x.pace - y.pace);
  }

  function utilizationCurve(P, filter = {}) {
    const bm = Array(12).fill(0), am = Array(P.m).fill(0);
    for (let k = 0; k < P.K; k++) {
      const key = P.keys[k];
      if ((filter.dept && key.dept !== filter.dept) || (filter.cat && key.cat !== filter.cat)) continue;
      for (let i = 0; i < 12; i++) bm[i] += P.B[k][P.yi][i];
      for (let i = 0; i < P.m; i++) am[i] += P.A[k][P.yi][i];
    }
    const fy = bm.reduce((a, b) => a + b, 0);
    let t = 0; const cb = bm.map((x) => (t += x) / fy);
    t = 0; const ca = am.map((x) => (t += x) / fy);
    return { budget: cb, actual: ca };
  }

  // ------------------------------------------------------------------ history
  function linSlope(xs, ys) {
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
    return den ? num / den : NaN;
  }

  /** Track record + behaviour tags per group (closed years before the current one). */
  function history(P, level, o = {}) {
    const over = o.over ?? 1.03, under = o.under ?? 0.92, q4Thr = o.q4Gap ?? 0.05, trendThr = o.trend ?? 0.05;
    const L = LEVELS[level], groups = new Map();
    const closed = []; for (let y = 0; y < P.yi; y++) closed.push(y);
    for (let k = 0; k < P.K; k++) {
      const s = P.keys[k], gk = L.key(s);
      if (!groups.has(gk)) groups.set(gk, Object.assign(L.label(s), {
        B: closed.map(() => Array(12).fill(0)), A: closed.map(() => Array(12).fill(0)) }));
      const g = groups.get(gk);
      closed.forEach((y, yi2) => { for (let i = 0; i < 12; i++) { g.B[yi2][i] += nz(P.B[k][y][i]); g.A[yi2][i] += nz(P.A[k][y][i]); } });
    }
    return [...groups.values()].map((g) => {
      const years = closed.map((y) => P.years[y]);
      const rates = closed.map((_, i) => div(sum(g.A[i], 0, 12), sum(g.B[i], 0, 12)));
      const gaps = closed.map((_, i) => div(sum(g.A[i], 9, 12), sum(g.A[i], 0, 12)) - div(sum(g.B[i], 9, 12), sum(g.B[i], 0, 12)));
      const out = { name: g.name, dept: g.dept, cat: g.cat, years, rates };
      out.mean = nanmean(rates); out.min = Math.min(...rates); out.max = Math.max(...rates);
      out.q4Gap = nanmean(gaps);
      out.trend = rates.length >= 2 ? linSlope(years, rates) : NaN;
      const d = rates.slice(1).map((v, i) => v - rates[i]);
      const up = rates.length >= 2 && d.every((x) => x > 0), dn = rates.length >= 2 && d.every((x) => x < 0);
      const tags = [];
      if (out.min >= 1.0 && out.mean >= over) tags.push('長期超支');
      if (out.max <= 1.0 && out.mean <= under) tags.push('長期未用完');
      if (out.q4Gap >= q4Thr) tags.push('Q4集中消化');
      if (up && out.trend >= trendThr) tags.push('執行率上升'); else if (dn && out.trend <= -trendThr) tags.push('執行率下降');
      out.tags = tags;
      // share of the year spent by month (average of closed years) for the seasonality chart
      out.shape = Array(12).fill(0).map((_, mi) => nanmean(closed.map((_, i) => div(sum(g.A[i], 0, mi + 1), sum(g.A[i], 0, 12)))));
      out.shapeByYear = closed.map((_, i) => Array(12).fill(0).map((_, mi) => div(sum(g.A[i], 0, mi + 1), sum(g.A[i], 0, 12))));
      out.budgetShape = Array(12).fill(0).map((_, mi) => nanmean(closed.map((_, i) => div(sum(g.B[i], 0, mi + 1), sum(g.B[i], 0, 12)))));
      return out;
    });
  }

  // ------------------------------------------------------------------ alerts
  const ACTIONS = {
    '紅燈・預計超支': '凍結非必要支出；評估追加預算或自其他單位調配（見「預算調配」）。',
    '黃燈・預計大幅未執行': '與部門確認專案進度與承諾支出；若確定無法執行，考慮釋出預算。',
    '黃燈・小幅超支風險': '持續追蹤，下月檢討；必要時控管剩餘月份支出。',
  };

  function buildAlerts(result, hist, o = {}) {
    const hmap = new Map(hist.map((h) => [h.dept + '\u0001' + h.cat, h]));
    const out = [];
    for (const s of result.series) {
      const h = hmap.get(s.dept + '\u0001' + s.cat);
      const tags = h ? h.tags : [];
      if (!s.risk.startsWith('綠')) {
        let text = `年累計執行 ${(s.ytdActual / s.fyBudget * 100).toFixed(0)}%（預算同期 ${(s.ytdBudget / s.fyBudget * 100).toFixed(0)}%），` +
          `預測全年 ${(s.fyForecast / 1e6).toFixed(1)} 百萬元，為預算的 ${(s.rate * 100).toFixed(0)}%` +
          `（80% 區間 ${(s.lo / s.fyBudget * 100).toFixed(0)}%～${(s.hi / s.fyBudget * 100).toFixed(0)}%），超支機率 ${(s.pOver * 100).toFixed(0)}%。`;
        if (s.commitRemaining > 0 && s.commitBinding) text += `已簽約未付款 ${(s.commitRemaining / 1e6).toFixed(1)} 百萬元，預測已納入。`;
        if (tags.includes('Q4集中消化')) text += '歷史上 Q4 會集中消化，年累計落後不代表全年不足。';
        if (tags.includes('長期超支')) text += '近年執行率持續高於 100%，建議檢討預算基準。';
        out.push({ level: s.risk.slice(0, 2), type: s.risk, dept: s.dept, cat: s.cat, title: `${s.dept}・${s.cat}`,
          text, action: ACTIONS[s.risk], gap: s.gap, rate: s.rate, pOver: s.pOver, tags });
      } else if (s.paceIndex < 0.9 && tags.includes('Q4集中消化')) {
        out.push({ level: '提示', type: '執行落後但屬季節性', dept: s.dept, cat: s.cat, title: `${s.dept}・${s.cat}`,
          text: `年累計僅為同期預算的 ${(s.paceIndex * 100).toFixed(0)}%，但歷史上 Q4 會集中消化，預測全年為預算的 ${(s.rate * 100).toFixed(0)}%，不列為風險。`,
          action: '無需處置，持續觀察 Q4 實際執行。', gap: s.gap, rate: s.rate, pOver: s.pOver, tags });
      }
    }
    for (const r of result.oneOffs) {
      out.push({ level: '提示', type: '單月異常', dept: r.dept, cat: r.cat, title: `${r.dept}・${r.cat}`,
        text: `${r.month} 月支出 ${(r.actual / 1e6).toFixed(1)} 百萬元，約為正常水準的 ${(r.actual / r.normalized).toFixed(1)} 倍，判定為一次性支出；已計入實際數，但不外推到後續月份。`,
        action: '確認該筆支出性質與是否需要補充預算。', gap: r.oneOff, rate: NaN, pOver: NaN, tags: [] });
    }
    const order = { '紅燈': 0, '黃燈': 1, '提示': 2 };
    return out.sort((a, b) => order[a.level] - order[b.level] || Math.abs(b.gap) - Math.abs(a.gap));
  }

  // ------------------------------------------------------------------ reallocation
  /**
   * Suggest moving budget from lines that will end with a safe surplus to lines that will overrun.
   * donor capacity  = budget - (forecast + safety x (upper bound - forecast))   [safety 0..1]
   * receiver need   = forecast - budget
   * Same-category transfers are matched first; cross-category transfers are flagged.
   */
  function reallocate(result, hist, o = {}) {
    const safety = o.safety ?? 1, minAmt = o.minAmount ?? 1e6, allowCross = o.allowCross !== false;
    const hmap = new Map(hist.map((h) => [h.dept + '\u0001' + h.cat, h]));
    const donors = [], receivers = [];
    for (const s of result.series) {
      const cap = s.fyBudget - (s.fyForecast + safety * (s.hi - s.fyForecast));
      const need = s.fyForecast - s.fyBudget;
      const tags = (hmap.get(s.dept + '\u0001' + s.cat) || { tags: [] }).tags;
      if (cap >= minAmt) donors.push({ s, left: cap, cap, tags });
      else if (need >= minAmt && s.pOver >= 0.5) receivers.push({ s, need, left: need });
    }
    // donors that are safest to draw on first: not "behind schedule" (possible delayed project), then largest surplus
    const risky = (d) => (d.s.paceIndex < 0.8 && !d.tags.includes('長期未用完') ? 1 : 0);
    donors.sort((a, b) => risky(a) - risky(b) || b.left - a.left); receivers.sort((a, b) => b.need - a.need);
    const moves = [];
    const take = (r, d, cross) => {
      const amt = Math.min(r.left, d.left);
      if (amt < minAmt * 0.5) return;
      r.left -= amt; d.left -= amt;
      const notes = [];
      if (d.s.commitRemaining > 0) notes.push(`來源含承諾支出 ${(d.s.commitRemaining / 1e6).toFixed(1)} 百萬元（已納入預測）`);
      if (d.tags.includes('長期未用完')) notes.push('歷史上長期未用完，適合同時檢討明年預算');
      if (d.s.paceIndex < 0.8 && !d.tags.includes('長期未用完')) notes.push('今年執行落後，需確認不是專案延後而於年底補執行');
      if (cross) notes.push('跨費用科目調配，需確認是否符合預算管理規範');
      moves.push({ fromDept: d.s.dept, fromCat: d.s.cat, toDept: r.s.dept, toCat: r.s.cat, amount: amt, cross, notes });
    };
    for (const r of receivers) {
      for (const d of donors) if (r.left > 0 && d.left > 0 && d.s.cat === r.s.cat && d.s.dept !== r.s.dept) take(r, d, false);
      if (allowCross) for (const d of donors) if (r.left > 0 && d.left > 0 && d.s.cat !== r.s.cat) take(r, d, true);
    }
    const summary = {
      totalNeed: receivers.reduce((a, r) => a + r.need, 0), covered: receivers.reduce((a, r) => a + (r.need - r.left), 0),
      totalCapacity: donors.reduce((a, d) => a + d.cap, 0), used: donors.reduce((a, d) => a + (d.cap - d.left), 0),
    };
    return { moves, donors, receivers, summary };
  }

  /** Post-transfer position of every dept x category line. */
  function applyMoves(series, moves) {
    const delta = new Map();
    const add = (d, c, v) => { const k = d + '\u0001' + c; delta.set(k, (delta.get(k) || 0) + v); };
    for (const mv of moves) { add(mv.fromDept, mv.fromCat, -mv.amount); add(mv.toDept, mv.toCat, mv.amount); }
    return series.map((s) => {
      const nb = s.fyBudget + (delta.get(s.dept + '\u0001' + s.cat) || 0);
      return { dept: s.dept, cat: s.cat, before: s.fyBudget, after: nb, forecast: s.fyForecast,
        rateBefore: s.fyForecast / s.fyBudget, rateAfter: s.fyForecast / nb };
    });
  }

  // ------------------------------------------------------------------ what-if
  function whatIf(members, m, factor) {
    let ytd = 0, remB = 0, fyB = 0;
    for (const s of members) { ytd += s.ytdActual; remB += s.remBudget; fyB += s.fyBudget; }
    const fy = ytd + factor * remB, left = 12 - m;
    return { fy, gap: fy - fyB, rate: fy / fyB, monthlyAllowance: left ? (fyB - ytd) / left : NaN, remBudget: remB, ytd, fyBudget: fyB };
  }

  const api = {
    METHODS, METHOD_LABELS, Z80, DEFAULT_SETTINGS, makePanel, methodFactors, fitWeights, forecast, aggregate, groupPath,
    variance, varianceTrend, waterfall, utilization, utilizationCurve, history, buildAlerts, reallocate, applyMoves,
    whatIf, flagSpikes, classifyRisk, riskClass, LEVELS, isNum,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FPA = api;
})(typeof window !== 'undefined' ? window : globalThis);
