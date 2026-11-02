(function () {
  'use strict';
  const F = window.FPA, DATA = window.FPAData, C = window.FPACharts, esc = C.esc;
  const $ = (s, el = document) => el.querySelector(s);

  // ------------------------------------------------------------------ formatting
  const M = (x, d = 1) => (Number.isFinite(x) ? (x / 1e6).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const SM = (x, d = 1) => (Number.isFinite(x) ? (x > 0 ? '+' : '') + M(x, d) : '–');
  const Pc = (x, d = 0) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '–');
  const pill = (r) => `<span class="pill ${F.riskClass(r)}">${esc(r)}</span>`;
  const tags = (t) => (t && t.length ? t.map((x) => `<span class="tag">${esc(x)}</span>`).join('') : '<span class="small">穩定</span>');
  const bar = (u, ph) => `<span class="bar"><i style="width:${Math.min(100, Math.max(0, u * 100))}%"></i><b style="left:${Math.min(100, Math.max(0, ph * 100))}%"></b></span>`;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;

  // ------------------------------------------------------------------ state
  const S = {
    rows: [], comm: [], source: '', info: null, issues: [], year: 0, month: 0, tab: 'overview', error: '',
    settings: JSON.parse(JSON.stringify(F.DEFAULT_SETTINGS)), res: null, hist: null, histDept: null, alerts: [],
    ui: {
      overview: { risk: 'all', sort: { key: 'gap', dir: -1 } },
      variance: { window: 'ytd', level: 'dept', dept: '', sel: null, sort: { key: 'variance', dir: -1 } },
      forecast: { dept: '', cat: '', factor: null },
      alerts: { level: 'all' },
      history: { dept: '' },
      realloc: { safety: 1, minAmount: 1e6, cross: true },
    },
  };
  const TABS = [['overview', '總覽'], ['variance', '差異分析'], ['forecast', '年底預測'], ['alerts', '預警'],
    ['history', '歷史執行'], ['realloc', '預算調配'], ['data', '資料']];

  // ------------------------------------------------------------------ data & compute
  function setData(rows, comm, source) {
    S.rows = rows; S.comm = comm; S.source = source;
    S.info = DATA.inspect(rows); S.issues = S.info.issues.slice();
    S.year = S.info.lastYear;
    S.month = Math.min(Math.max(S.info.lastClosed, 1), 11);
    S.ui.forecast.factor = null;
    recompute();
    if (S.res) { const q = F.history(S.res.panel, 'dept').find((h) => h.tags.includes('Q4集中消化')); S.ui.history.dept = q ? q.dept : ''; }
  }

  function recompute() {
    S.error = '';
    try {
      if (!S.rows.length || !S.info.lastClosed) throw new Error('沒有可分析的資料，請到「資料」頁載入範例或上傳檔案。');
      S.res = F.forecast(S.rows, S.comm, S.year, S.month, { risk: S.settings.risk });
      const P = S.res.panel;
      S.hist = F.history(P, 'dept_cat'); S.histDept = F.history(P, 'dept');
      S.alerts = F.buildAlerts(S.res, S.hist);
    } catch (e) { S.res = null; S.error = e.message; }
  }

  // ------------------------------------------------------------------ helpers
  function sortRows(rows, key, dir) {
    return rows.slice().sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === 'string') return dir * x.localeCompare(y, 'zh-TW');
      return dir * ((Number.isFinite(x) ? x : -Infinity) - (Number.isFinite(y) ? y : -Infinity));
    });
  }
  function th(tableId, key, label, cur, left) {
    const on = cur && cur.key === key ? (cur.dir > 0 ? ' ▲' : ' ▼') : '';
    return `<th class="s ${left ? 'l' : ''}" data-sort="${tableId}:${key}">${label}${on}</th>`;
  }
  const download = (name, text) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };
  const toCSV = (cols, rows) => [cols.map((c) => c[0]).join(',')].concat(rows.map((r) => cols.map((c) => {
    const v = c[1](r); return /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
  }).join(','))).join('\n');
  const depts = () => [...new Set(S.res.series.map((s) => s.dept))];
  const cats = () => [...new Set(S.res.series.map((s) => s.cat))];
  const nonRed = () => S.alerts.filter((a) => a.level === '紅燈').length;

  // ------------------------------------------------------------------ views
  function viewOverview() {
    const u = S.ui.overview, risk = S.settings.risk;
    const total = F.aggregate(S.res.series, 'total', risk)[0];
    let ds = F.aggregate(S.res.series, 'dept', risk);
    const counts = { red: ds.filter((d) => d.risk.startsWith('紅')).length, amber: ds.filter((d) => d.risk.startsWith('黃')).length };
    if (u.risk !== 'all') ds = ds.filter((d) => F.riskClass(d.risk) === u.risk);
    ds = sortRows(ds, u.sort.key, u.sort.dir);
    const sev = S.alerts.filter((a) => a.level !== '提示').slice(0, 4);
    const kp = [
      ['全年預算', M(total.fyBudget), `${depts().length} 個部門、${cats().length} 類費用`],
      ['年累計實際', M(total.ytdActual), `執行率 ${Pc(total.utilization, 1)}，同期預算 ${Pc(total.phased, 1)}`],
      ['預測全年', M(total.fyForecast), `為預算的 ${Pc(total.rate, 1)}（區間 ${Pc(total.lo / total.fyBudget)}～${Pc(total.hi / total.fyBudget)}）`],
      ['預計差異', SM(total.gap), total.gap >= 0 ? '預計超支（百萬元）' : '預計結餘（百萬元）'],
      ['需關注部門', `${counts.red} 紅 / ${counts.amber} 黃`, `共 ${S.alerts.filter((a) => a.level !== '提示').length} 項科目層級預警`],
    ];
    const path = F.groupPath(S.res.series, S.month);
    S._chartPath = path;
    return `
      <div class="kpis">${kp.map(([l, v, n]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="n">${n}</div></div>`).join('')}</div>
      <div class="grid2">
        <div class="card"><h3>全公司累計支出（百萬元）</h3>
          <div class="legend"><span class="lg-b">累計預算</span><span class="lg-a">累計實際</span><span class="lg-f">預測</span><span class="lg-band">80% 區間</span></div>
          <div id="ch-total"></div><div class="tip" id="tip-total">滑鼠移到圖上查看各月數字</div></div>
        <div class="card"><h3>最需要處理的項目</h3>
          ${sev.length ? sev.map((a) => `<div class="alert ${a.level === '紅燈' ? 'red' : 'amber'}"><div class="t"><span class="pill ${a.level === '紅燈' ? 'red' : 'amber'}">${a.level}</span>${esc(a.title)}</div><div class="a">${esc(a.type.slice(3))}｜預測 ${Pc(a.rate)}｜${SM(a.gap)} 百萬元</div></div>`).join('') : '<div class="empty">目前沒有需要處理的預警</div>'}
          <button class="btn" data-go="alerts">查看全部預警</button></div>
      </div>
      <h2>部門總覽 <span class="small">　點選部門查看預測明細</span></h2>
      <div class="row"><div class="chips">${[['all', '全部'], ['red', '紅燈'], ['amber', '黃燈'], ['green', '綠燈']].map(([k, l]) => `<button class="chip ${u.risk === k ? 'on' : ''}" data-chip="overview.risk:${k}">${l}</button>`).join('')}</div>
        <button class="btn" data-export="dept">匯出 CSV</button></div>
      <div class="card tw"><table><thead><tr>
        ${th('overview', 'name', '部門', u.sort, true)}${th('overview', 'fyBudget', '全年預算', u.sort)}${th('overview', 'ytdActual', '年累計實際', u.sort)}
        ${th('overview', 'utilization', '執行率 / 同期進度', u.sort)}${th('overview', 'fyForecast', '預測全年', u.sort)}${th('overview', 'rate', '預測÷預算', u.sort)}
        ${th('overview', 'gap', '預計差異', u.sort)}<th>80% 區間</th>${th('overview', 'pOver', '超支機率', u.sort)}<th>燈號</th></tr></thead><tbody>
        ${ds.map((d) => `<tr class="click" data-dept-go="${esc(d.dept)}"><td>${esc(d.name)}</td><td>${M(d.fyBudget)}</td><td>${M(d.ytdActual)}</td>
          <td>${bar(d.utilization, d.phased)} <span class="small">${Pc(d.utilization)} / ${Pc(d.phased)}</span></td><td>${M(d.fyForecast)}</td><td class="hl">${Pc(d.rate, 1)}</td>
          <td class="${d.gap > 0 ? 'pos' : 'neg'}">${SM(d.gap)}</td><td class="small">${Pc(d.lo / d.fyBudget)}～${Pc(d.hi / d.fyBudget)}</td><td>${Pc(d.pOver)}</td><td>${pill(d.risk)}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">沒有符合的部門</td></tr>'}
        </tbody><tfoot><tr><td>全公司</td><td>${M(total.fyBudget)}</td><td>${M(total.ytdActual)}</td><td></td><td>${M(total.fyForecast)}</td><td>${Pc(total.rate, 1)}</td><td>${SM(total.gap)}</td><td></td><td></td><td></td></tr></tfoot></table></div>
      <p class="small">執行率 = 年累計實際 ÷ 全年預算；黑線是「預算同期進度」，依預算自己的月份分佈計算，不是平均 1/12。金額單位：百萬元。</p>`;
  }

  function viewVariance() {
    const u = S.ui.variance, P = S.res.panel;
    const vars = F.variance(P, u.level, u.window, { dept: u.dept || null, materialPct: S.settings.materialPct, materialAmount: S.settings.materialAmount });
    const rows = sortRows(vars, u.sort.key, u.sort.dir);
    const sel = u.sel || {};
    const trend = F.varianceTrend(P, { dept: sel.dept || u.dept || null, cat: sel.cat || null, months: 24 });
    const wl = { month: '當月', qtd: '本季累計', ytd: '年累計' }[u.window];
    const totalB = vars.reduce((a, v) => a + v.budget, 0), totalA = vars.reduce((a, v) => a + v.actual, 0);
    const spikes = F.flagSpikes(P).map((s) => ({ dept: P.keys[s.k].dept, cat: P.keys[s.k].cat, month: s.month, ...s }));
    return `
      <div class="row">
        <label>期間 <select data-ui="variance.window">${opt('month', '當月', u.window)}${opt('qtd', '本季累計', u.window)}${opt('ytd', '年累計', u.window)}</select></label>
        <label>層級 <select data-ui="variance.level">${opt('dept', '部門', u.level)}${opt('cat', '費用科目', u.level)}${opt('dept_cat', '部門×科目', u.level)}</select></label>
        <label>範圍 <select data-ui="variance.dept">${opt('', '全公司', u.dept)}${depts().map((d) => opt(d, d, u.dept)).join('')}</select></label>
        <label>重大差異門檻 ≥ <input type="number" step="1" min="0" value="${S.settings.materialPct * 100}" data-set="materialPct" data-scale="0.01">% 且 ≥ <input type="number" step="0.5" min="0" value="${S.settings.materialAmount / 1e6}" data-set="materialAmount" data-scale="1000000">百萬元</label>
        <button class="btn" data-export="variance">匯出 CSV</button>
      </div>
      <div class="grid2">
        <div class="card"><h3>預算 → 實際：差異來源（${wl}）</h3><div id="ch-wf"></div></div>
        <div class="card"><h3>${esc(sel.name || (u.dept || '全公司'))}：每月差異（近 24 個月）</h3><div id="ch-trend"></div><div class="tip" id="tip-trend">紅色 = 超支，綠色 = 低於預算</div></div>
      </div>
      <h2>差異明細（${wl}）<span class="small">　點選一列查看該項目的月度趨勢</span></h2>
      <div class="card tw"><table><thead><tr>${th('variance', 'name', '項目', u.sort, true)}${th('variance', 'budget', '預算', u.sort)}${th('variance', 'actual', '實際', u.sort)}
        ${th('variance', 'variance', '差異（實際−預算）', u.sort)}${th('variance', 'variancePct', '差異%', u.sort)}<th>方向</th><th>重大差異</th></tr></thead><tbody>
        ${rows.map((v) => `<tr class="click ${sel.name === v.name ? 'sel' : ''}" data-var-sel="${esc(v.dept || '')}|${esc(v.cat || '')}|${esc(v.name)}"><td>${esc(v.name)}</td><td>${M(v.budget)}</td><td>${M(v.actual)}</td>
          <td class="${v.variance > 0 ? 'pos' : 'neg'}">${SM(v.variance)}</td><td class="${v.variance > 0 ? 'pos' : 'neg'}">${v.variancePct > 0 ? '+' : ''}${Pc(v.variancePct, 1)}</td><td>${v.direction}</td>
          <td>${v.material ? '<span class="pill amber">重大</span>' : ''}</td></tr>`).join('')}
        </tbody><tfoot><tr><td>合計</td><td>${M(totalB)}</td><td>${M(totalA)}</td><td class="${totalA > totalB ? 'pos' : 'neg'}">${SM(totalA - totalB)}</td><td>${Pc((totalA - totalB) / totalB, 1)}</td><td></td><td></td></tr></tfoot></table></div>
      <p class="small">金額單位：百萬元。差異 = 實際 − 預算，正數為超支。重大差異需同時達到百分比與金額門檻。</p>
      <h2>單月異常偵測</h2>
      <div class="card tw">${spikes.length ? `<table><thead><tr><th>期間</th><th class="l">部門</th><th class="l">費用科目</th><th>預算</th><th>實際</th><th>為預算的倍數</th><th>型態</th></tr></thead><tbody>
        ${spikes.map((s) => `<tr><td>${P.year}-${String(s.month).padStart(2, '0')}</td><td class="l">${esc(s.dept)}</td><td class="l">${esc(s.cat)}</td><td>${M(s.budget)}</td><td>${M(s.actual)}</td><td>${s.ratio.toFixed(1)}x</td><td><span class="pill ${s.pattern === '單月異常' ? 'info' : 'amber'}">${s.pattern}</span></td></tr>`).join('')}</tbody></table>
        <p class="small">條件：當月實際 ≥ 預算 1.5 倍，且高於該科目前 12 個月平均 3 個標準差。「單月異常」判定為一次性，預測時不外推；「持續偏高」代表趨勢已改變。</p>` : '<div class="empty">本期沒有偵測到異常</div>'}</div>`;
  }

  function methodTotals(members) {
    return F.METHODS.map((name) => {
      let fy = 0, w = 0, wsum = 0;
      for (const s of members) {
        const f = Number.isNaN(s.factors[name]) ? s.factors.pace : s.factors[name];
        fy += s.ytdActual + f * s.remBudget; w += s.weights[name] * s.remBudget; wsum += s.remBudget;
      }
      return { name, fy, weight: wsum ? w / wsum : 0 };
    });
  }

  function viewForecast() {
    const u = S.ui.forecast, m = S.month;
    const members = S.res.series.filter((s) => (!u.dept || s.dept === u.dept) && (!u.cat || s.cat === u.cat));
    const sel = `<div class="row">
        <label>部門 <select data-ui="forecast.dept">${opt('', '全公司', u.dept)}${depts().map((d) => opt(d, d, u.dept)).join('')}</select></label>
        <label>費用科目 <select data-ui="forecast.cat">${opt('', '全部科目', u.cat)}${cats().map((c) => opt(c, c, u.cat)).join('')}</select></label>
        <button class="btn" data-export="forecast">匯出 CSV</button></div>`;
    if (!members.length) return sel + '<div class="empty">沒有符合的資料</div>';
    const g = F.aggregate(members, 'total', S.settings.risk)[0];
    const path = F.groupPath(members, m); S._chartPath = path;
    const mt = methodTotals(members);
    const factor0 = g.remBudget > 0 ? g.fcRemaining / g.remBudget : 1;
    if (u.factor === null) u.factor = Math.round(factor0 * 100) / 100;
    const w = F.whatIf(members, m, u.factor);
    const left = 12 - m, recent = members.reduce((a, s) => a + s.monthA.slice(Math.max(0, m - 3)).reduce((x, y) => x + y, 0), 0) / Math.min(3, m);
    const rowsDetail = members.slice().sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    const fcell = (v) => (Number.isNaN(v) ? '–' : Pc(v));
    return `${sel}
      <div class="grid2">
        <div class="card"><h3>${esc(u.dept || '全公司')}${u.cat ? '・' + esc(u.cat) : ''}：累計支出（百萬元）</h3>
          <div class="legend"><span class="lg-b">累計預算</span><span class="lg-a">累計實際</span><span class="lg-f">預測</span><span class="lg-band">80% 區間</span></div>
          <div id="ch-fc"></div><div class="tip" id="tip-fc">滑鼠移到圖上查看各月數字</div></div>
        <div class="card"><div>${pill(g.risk)}</div>
          <p class="big" style="margin:8px 0 0">${M(g.fyForecast)} <span class="small">百萬元</span></p>
          <p style="margin:0 0 8px">預測全年支出，為預算的 <b>${Pc(g.rate, 1)}</b>，預計${g.gap >= 0 ? '超支' : '結餘'} <b class="${g.gap > 0 ? 'pos' : 'neg'}">${M(Math.abs(g.gap))}</b> 百萬元。</p>
          <div class="small">80% 區間：${M(g.lo)}～${M(g.hi)} 百萬元（預算 ${M(g.fyBudget)}）<br>超支機率：${Pc(g.pOver)}<br>已簽約未付款：${M(g.commitRemaining)} 百萬元（已列為各月下限）</div>
          <h3 style="margin-top:14px">四種推估方法</h3>
          <table><thead><tr><th>方法</th><th>預測全年</th><th>權重</th></tr></thead><tbody>
          ${mt.map((x) => `<tr><td>${F.METHOD_LABELS[x.name]}</td><td>${M(x.fy)}</td><td>${Pc(x.weight)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>加權組合（含承諾支出下限）</td><td>${M(g.fyForecast)}</td><td></td></tr></tfoot></table></div>
      </div>
      <h2>情境試算：假設剩餘月份的執行率</h2>
      <div class="card">
        <div class="row"><label>剩餘預算被使用的比例 <input type="range" id="whatif" min="0" max="200" step="1" value="${Math.round(u.factor * 100)}"> <b id="wf-val">${Math.round(u.factor * 100)}%</b></label>
          <button class="btn" data-whatif-reset>回到模型預測（${Pc(factor0)}）</button></div>
        <div class="kpis" id="wf-out">${whatIfCards(w, g, recent, left)}</div>
        <p class="small">例：拉到 100% 代表剩餘 ${left} 個月把剩餘預算全數用完；「不超支的每月支出上限」是剩餘預算 ÷ 剩餘月數，可與近三個月平均支出比較。</p>
      </div>
      <h2>${members.length > 1 ? '科目明細' : '推估明細'}</h2>
      <div class="card tw"><table><thead><tr><th class="l">部門</th><th class="l">費用科目</th><th>全年預算</th><th>年累計</th>
        ${F.METHODS.map((n) => `<th title="預測剩餘月份會用掉的剩餘預算比例">${F.METHOD_LABELS[n]}</th>`).join('')}<th>組合</th><th>承諾(未付)</th><th>預測全年</th><th>預測÷預算</th><th>燈號</th></tr></thead><tbody>
        ${rowsDetail.map((s) => `<tr><td class="l">${esc(s.dept)}</td><td class="l">${esc(s.cat)}</td><td>${M(s.fyBudget)}</td><td>${M(s.ytdActual)}</td>
          ${F.METHODS.map((n) => `<td>${fcell(s.factors[n])}<span class="small"> ·${Pc(s.weights[n])}</span></td>`).join('')}<td class="hl">${Pc(s.fEnsemble)}</td>
          <td>${s.commitRemaining > 0 ? M(s.commitRemaining) + (s.commitBinding ? ' ◆' : '') : '–'}</td><td>${M(s.fyForecast)}</td><td class="hl">${Pc(s.rate, 1)}</td><td>${pill(s.risk)}</td></tr>`).join('')}
        </tbody></table></div>
      <p class="small">各方法欄位 = 預測「剩餘預算會被用掉幾成」，· 後為該方法的權重（依回測誤差）。◆ = 承諾支出高於推估值，預測以承諾支出為下限。${S.res.nSamples ? `權重與區間來自 ${S.res.nSamples} 組歷史回測樣本。` : '歷史年度不足，採等權重與預設區間。'}</p>`;
  }

  function whatIfCards(w, g, recent, left) {
    const c = [
      ['情境全年支出', M(w.fy), `為預算的 ${Pc(w.rate, 1)}`],
      ['情境差異', SM(w.gap), w.gap > 0 ? '超支（百萬元）' : '結餘（百萬元）'],
      ['不超支的每月支出上限', M(w.monthlyAllowance), `剩餘 ${left} 個月（百萬元／月）`],
      ['近三個月平均支出', M(recent), recent > w.monthlyAllowance ? '高於上限，需要減速' : '在上限之內'],
    ];
    return c.map(([l, v, n]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="n">${n}</div></div>`).join('');
  }

  function viewAlerts() {
    const u = S.ui.alerts, r = S.settings.risk;
    const list = S.alerts.filter((a) => u.level === 'all' || a.level === u.level);
    const num = (label, key, val, scale, step) => `<label>${label} <input type="number" step="${step}" value="${+(val / scale).toFixed(3)}" data-risk="${key}" data-scale="${scale}"></label>`;
    return `
      <div class="card"><h3>預警規則（可調整，變更後立即重新計算）</h3>
        <div class="row">
          ${num('紅燈：超支機率 ≥ (%)', 'pRed', r.pRed, 0.01, 5)}${num('且超支 ≥ 預算 (%)', 'redPct', r.redPct, 0.01, 0.5)}${num('且超支金額 ≥ (百萬元)', 'minAmount', r.minAmount, 1e6, 0.5)}
        </div><div class="row">
          ${num('黃燈（落後）：預測 < 預算 (%)', 'underRate', r.underRate, 0.01, 5)}${num('黃燈（小幅超支）：機率 ≥ (%)', 'pYellow', r.pYellow, 0.01, 5)}${num('且超支 ≥ 預算 (%)', 'yellowPct', r.yellowPct, 0.01, 0.5)}
          <button class="btn" data-risk-reset>恢復預設</button>
        </div>
        <p class="small" style="margin:0">金額門檻避免小科目因百分比波動而亮紅燈。機率來自預測區間；單月異常與季節性落後另列為提示。</p></div>
      <div class="row" style="margin-top:14px"><div class="chips">${[['all', '全部'], ['紅燈', '紅燈'], ['黃燈', '黃燈'], ['提示', '提示']].map(([k, l]) => `<button class="chip ${u.level === k ? 'on' : ''}" data-chip="alerts.level:${k}">${l}（${S.alerts.filter((a) => k === 'all' || a.level === k).length}）</button>`).join('')}</div>
        <button class="btn" data-export="alerts">匯出 CSV</button></div>
      ${list.map((a) => `<div class="alert ${a.level === '紅燈' ? 'red' : a.level === '黃燈' ? 'amber' : 'info'}"><div class="t"><span class="pill ${a.level === '紅燈' ? 'red' : a.level === '黃燈' ? 'amber' : 'info'}">${a.level}</span>${esc(a.title)}：${esc(a.type.replace(/^[紅黃]燈・/, ''))}</div>
        <div class="x">${esc(a.text)}</div><div class="a"><b>建議：</b>${esc(a.action)}</div></div>`).join('') || '<div class="empty">沒有符合的預警</div>'}`;
  }

  function viewHistory() {
    const u = S.ui.history, P = S.res.panel;
    const hd = S.histDept;
    if (!hd.length || !hd[0].years.length) return '<div class="empty">需要至少一個已完整結帳的歷史年度。</div>';
    const years = hd[0].years;
    const dept = u.dept || '';
    const rate = (x) => `<span class="${x > 1.03 ? 'pos' : x < 0.92 ? 'neg' : ''}">${Pc(x, 1)}</span>`;
    const cell = (h, name) => `<tr class="click" data-hist-dept="${esc(h.dept || '')}"><td>${esc(name)}</td>${h.rates.map((r) => `<td>${rate(r)}</td>`).join('')}<td class="hl">${rate(h.mean)}</td><td>${Number.isFinite(h.trend) ? (h.trend > 0 ? '+' : '') + (h.trend * 100).toFixed(1) + ' 點/年' : '–'}</td><td>${Number.isFinite(h.q4Gap) ? (h.q4Gap > 0 ? '+' : '') + (h.q4Gap * 100).toFixed(1) + ' 點' : '–'}</td><td class="l">${tags(h.tags)}</td></tr>`;
    const head = `<thead><tr><th>${dept ? '費用科目' : '部門'}</th>${years.map((y) => `<th>${y} 執行率</th>`).join('')}<th>平均</th><th>趨勢</th><th title="Q4 占全年實際支出的比例，減去 Q4 占預算的比例">Q4 偏離</th><th class="l">型態</th></tr></thead>`;
    const rows = dept ? S.hist.filter((h) => h.dept === dept).sort((a, b) => b.mean - a.mean) : hd.slice().sort((a, b) => b.mean - a.mean);
    const target = dept ? hd.find((h) => h.dept === dept) : F.history(P, 'total')[0];
    const members = S.res.series.filter((s) => !dept || s.dept === dept);
    const g = F.aggregate(members, 'total', S.settings.risk)[0];
    const curve = (() => { const path = F.groupPath(members, S.month); return path.actual.map((a) => a / g.fyForecast); })();
    return `
      <div class="row"><label>範圍 <select data-ui="history.dept">${opt('', '全部部門', dept)}${depts().map((d) => opt(d, d, dept)).join('')}</select></label>
        <span class="small">執行率 = 全年實際 ÷ 全年預算；紅字 > 103%，綠字 < 92%。點選部門可往下看科目。</span></div>
      <div class="card tw"><table>${head}<tbody>${rows.map((h) => (dept ? cell(h, h.cat) : cell(h, h.name))).join('')}</tbody></table></div>
      <h2>支出節奏：${esc(dept || '全公司')}</h2>
      <div class="card"><div class="legend"><span style="--c:var(--budget)" class="lg-b">預算進度</span><span class="lg-a">歷史平均實際</span><span class="lg-f">今年累計 ÷ 預測全年</span></div>
        <div id="ch-shape"></div>
        <p class="small">縱軸是各月底累計支出占全年的比例。歷史平均若明顯高於預算線，代表該單位習慣把支出放在年底；今年累計若落在歷史平均之下，要看是否為預期中的季節性。</p></div>`;
    void target;
  }

  function viewRealloc() {
    const u = S.ui.realloc;
    const ra = F.reallocate(S.res, S.hist, { safety: u.safety, minAmount: u.minAmount, allowCross: u.cross });
    const after = F.applyMoves(S.res.series, ra.moves).filter((x) => Math.abs(x.after - x.before) > 1);
    const sm = ra.summary;
    return `
      <div class="note">邏輯：預計用不完的項目，扣掉安全邊際後的餘額可以釋出；預計超支的項目依缺口大小優先補足。同費用科目的調配優先，跨科目的標示提醒。這是建議，不是決策。</div>
      <div class="row">
        <label>釋出餘額的保守程度 <select data-ui="realloc.safety">${opt(1, '保守：以 80% 區間上限估算支出', u.safety)}${opt(0.5, '中性：區間上限與預測值的中間', u.safety)}${opt(0, '積極：以預測值估算支出', u.safety)}</select></label>
        <label>單筆最低金額 <input type="number" step="0.5" min="0" value="${u.minAmount / 1e6}" data-ruiset="minAmount" data-scale="1000000">百萬元</label>
        <label><input type="checkbox" ${u.cross ? 'checked' : ''} data-ruicheck="cross"> 允許跨費用科目</label>
        <button class="btn" data-export="realloc">匯出 CSV</button></div>
      <div class="kpis">
        <div class="kpi"><div class="l">預計超支缺口（機率 ≥ 50%）</div><div class="v">${M(sm.totalNeed)}</div><div class="n">${ra.receivers.length} 個項目（百萬元）</div></div>
        <div class="kpi"><div class="l">可釋出餘額</div><div class="v">${M(sm.totalCapacity)}</div><div class="n">${ra.donors.length} 個項目（百萬元）</div></div>
        <div class="kpi"><div class="l">建議調配金額</div><div class="v">${M(sm.used)}</div><div class="n">${ra.moves.length} 筆</div></div>
        <div class="kpi"><div class="l">缺口補足比例</div><div class="v">${sm.totalNeed ? Pc(sm.covered / sm.totalNeed) : '–'}</div><div class="n">${sm.totalNeed - sm.covered > 1 ? '未補足 ' + M(sm.totalNeed - sm.covered) + ' 百萬元，需追加預算' : '全數可由內部調配'}</div></div>
      </div>
      <h2>調配建議</h2>
      <div class="card tw">${ra.moves.length ? `<table><thead><tr><th class="l">自（部門・科目）</th><th class="l">至（部門・科目）</th><th>金額（百萬元）</th><th class="l">提醒</th></tr></thead><tbody>
        ${ra.moves.map((x) => `<tr><td class="l">${esc(x.fromDept)}・${esc(x.fromCat)}</td><td class="l">${esc(x.toDept)}・${esc(x.toCat)}</td><td class="hl">${M(x.amount)}</td><td class="l small nw">${x.notes.map(esc).join('；') || '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">目前沒有需要或可以調配的項目</div>'}</div>
      ${after.length ? `<h2>調配後的預測執行率</h2><div class="card tw"><table><thead><tr><th class="l">部門・科目</th><th>調整前預算</th><th>調整後預算</th><th>預測全年</th><th>調整前 預測÷預算</th><th>調整後 預測÷預算</th></tr></thead><tbody>
        ${after.map((x) => `<tr><td class="l">${esc(x.dept)}・${esc(x.cat)}</td><td>${M(x.before)}</td><td>${M(x.after)}</td><td>${M(x.forecast)}</td><td>${Pc(x.rateBefore, 1)}</td><td class="hl">${Pc(x.rateAfter, 1)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <p class="small">提醒欄位會標示來源項目的承諾支出、歷史上長期未用完，或今年執行落後但可能是專案延後的情況，後者不建議立即釋出。</p>`;
  }

  function viewData() {
    const info = S.info;
    return `
      <div class="grid2e">
        <div class="card"><h3>使用範例資料</h3><p class="small">模擬一家壽險公司 10 個部門、8 類費用，2023–2026 年，其中埋了六種典型情境。</p>
          <button class="btn pri" data-load-sample>載入範例資料</button></div>
        <div class="card"><h3>上傳你的資料（CSV）</h3>
          <div class="row"><label>預算與實際 <input type="file" accept=".csv,text/csv" data-upload="budget"></label></div>
          <div class="row"><label>承諾支出（選填） <input type="file" accept=".csv,text/csv" data-upload="comm"></label></div>
          <div class="row"><button class="btn" data-template="budget">下載預算檔範本</button><button class="btn" data-template="comm">下載承諾支出範本</button></div>
          <p class="small">欄位：年度、月份、部門、費用科目、預算、實際（尚未結帳的月份實際留白）。建議至少 3 年資料，最新年度為進行中。資料只在你的瀏覽器內處理。</p></div>
      </div>
      ${S.issues.map((i) => `<div class="warn">${esc(i)}</div>`).join('')}
      ${info && S.rows.length ? `<h2>目前資料</h2><div class="kpis">
        <div class="kpi"><div class="l">來源</div><div class="v" style="font-size:16px">${esc(S.source)}</div></div>
        <div class="kpi"><div class="l">年度</div><div class="v" style="font-size:16px">${info.years[0]}–${info.years[info.years.length - 1]}</div><div class="n">${info.years.length} 年</div></div>
        <div class="kpi"><div class="l">部門 / 科目</div><div class="v" style="font-size:16px">${info.depts.length} / ${info.cats.length}</div></div>
        <div class="kpi"><div class="l">最新年度已結帳</div><div class="v" style="font-size:16px">${info.lastClosed} 個月</div></div>
        <div class="kpi"><div class="l">承諾支出</div><div class="v" style="font-size:16px">${S.comm.length} 筆</div></div></div>
        <div class="card tw"><table><thead><tr><th>年度</th><th>月份</th><th class="l">部門</th><th class="l">費用科目</th><th>預算</th><th>實際</th></tr></thead><tbody>
        ${S.rows.slice(-8).map((r) => `<tr><td>${r.year}</td><td>${r.month}</td><td class="l">${esc(r.dept)}</td><td class="l">${esc(r.cat)}</td><td>${r.budget.toLocaleString()}</td><td>${r.actual === null ? '' : r.actual.toLocaleString()}</td></tr>`).join('')}
        </tbody></table><p class="small">顯示最後 8 列，共 ${S.rows.length.toLocaleString()} 列。</p></div>` : ''}`;
  }

  // ------------------------------------------------------------------ render
  const VIEWS = { overview: viewOverview, variance: viewVariance, forecast: viewForecast, alerts: viewAlerts, history: viewHistory, realloc: viewRealloc, data: viewData };

  function render() {
    $('#nav').innerHTML = TABS.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}${k === 'alerts' && S.res ? `<span class="badge">${nonRed()}</span>` : ''}</button>`).join('');
    $('#source').textContent = S.source ? `資料來源：${S.source}` : '';
    const sel = $('#asof');
    if (S.info && S.info.lastClosed) {
      const max = Math.min(S.info.lastClosed, 11);
      sel.innerHTML = Array.from({ length: max }, (_, i) => opt(i + 1, `${S.year} 年 ${i + 1} 月底`, S.month)).join('');
      sel.disabled = false;
    } else { sel.innerHTML = ''; sel.disabled = true; }

    const v = $('#view');
    if (S.tab !== 'data' && !S.res) {
      v.innerHTML = `<div class="warn">${esc(S.error || '尚未載入資料')}</div>` + viewData();
    } else v.innerHTML = VIEWS[S.tab]();
    afterRender();
  }

  function afterRender() {
    const g = (id) => document.getElementById(id);
    if (S.tab === 'overview' && g('ch-total')) C.cumulative(g('ch-total'), S._chartPath, S.month, g('tip-total'));
    if (S.tab === 'forecast' && g('ch-fc')) C.cumulative(g('ch-fc'), S._chartPath, S.month, g('tip-fc'));
    if (S.tab === 'variance') {
      const u = S.ui.variance, P = S.res.panel, sel = u.sel || {};
      const vars = F.variance(P, u.level, u.window, { dept: u.dept || null });
      C.waterfall(g('ch-wf'), F.waterfall(vars, 8));
      C.varianceBars(g('ch-trend'), F.varianceTrend(P, { dept: sel.dept || u.dept || null, cat: sel.cat || null, months: 24 }), g('tip-trend'));
    }
    if (S.tab === 'history' && g('ch-shape')) {
      const u = S.ui.history, hd = S.histDept, h = u.dept ? hd.find((x) => x.dept === u.dept) : null;
      const base = h || aggregateHistory();
      const lines = [{ label: '預算', values: base.budgetShape, color: 'var(--budget)', dash: '5 4', width: 2 }];
      base.shapeByYear.forEach((v, i) => lines.push({ label: String(base.years[i]), values: v, color: 'var(--line)', width: 1.5 }));
      lines.push({ label: '歷史平均', values: base.shape, color: 'var(--accent)', width: 3 });
      const members = S.res.series.filter((s) => !u.dept || s.dept === u.dept);
      const gg = F.aggregate(members, 'total', S.settings.risk)[0], path = F.groupPath(members, S.month);
      lines.push({ label: `${S.year} 累計`, values: path.actual.map((a) => a / gg.fyForecast), color: 'var(--ink)', width: 3 });
      C.shareLines(g('ch-shape'), lines, S.month);
    }
  }

  function aggregateHistory() {
    const t = F.history(S.res.panel, 'total')[0];
    return t;
  }

  // ------------------------------------------------------------------ events
  const setPath = (obj, path, val) => { const ks = path.split('.'); let o = obj; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = val; };

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab],[data-sort],[data-go],[data-dept-go],[data-chip],[data-var-sel],[data-hist-dept],[data-export],[data-load-sample],[data-template],[data-whatif-reset],[data-risk-reset]');
    if (!t) return;
    const d = t.dataset;
    if (d.tab) { S.tab = d.tab; render(); window.scrollTo(0, 0); }
    else if (d.go) { S.tab = d.go; render(); window.scrollTo(0, 0); }
    else if (d.sort) { const [tab, key] = d.sort.split(':'); const s = S.ui[tab].sort; s.dir = s.key === key ? -s.dir : (key === 'name' ? 1 : -1); s.key = key; render(); }
    else if (d.deptGo !== undefined) { S.ui.forecast.dept = d.deptGo; S.ui.forecast.cat = ''; S.ui.forecast.factor = null; S.tab = 'forecast'; render(); window.scrollTo(0, 0); }
    else if (d.chip) { const [p, v] = d.chip.split(':'); setPath(S.ui, p, v); render(); }
    else if (d.varSel) { const [dept, cat, name] = d.varSel.split('|'); const u = S.ui.variance; u.sel = u.sel && u.sel.name === name ? null : { dept: dept || null, cat: cat || null, name }; render(); }
    else if (d.histDept !== undefined) { const u = S.ui.history; u.dept = u.dept ? '' : d.histDept; render(); }
    else if (d.export) exportCSV(d.export);
    else if (d.loadSample !== undefined) loadSample();
    else if (d.template) download(d.template === 'budget' ? '預算檔範本.csv' : '承諾支出範本.csv', d.template === 'budget' ? DATA.TEMPLATE : DATA.COMMIT_TEMPLATE);
    else if (d.whatifReset !== undefined) { S.ui.forecast.factor = null; render(); }
    else if (d.riskReset !== undefined) { S.settings.risk = JSON.parse(JSON.stringify(F.DEFAULT_SETTINGS.risk)); recompute(); render(); }
  });

  document.addEventListener('change', (e) => {
    const t = e.target, d = t.dataset;
    if (t.id === 'asof') { S.month = +t.value; S.ui.forecast.factor = null; recompute(); render(); return; }
    if (d.ui) { const v = t.value; setPath(S.ui, d.ui, d.ui === 'realloc.safety' ? +v : v); if (d.ui.startsWith('forecast.')) S.ui.forecast.factor = null; if (d.ui === 'variance.dept' || d.ui === 'variance.level') S.ui.variance.sel = null; render(); }
    else if (d.set) { S.settings[d.set] = +t.value * +d.scale; render(); }
    else if (d.risk) { S.settings.risk[d.risk] = +t.value * +d.scale; recompute(); render(); }
    else if (d.ruiset) { S.ui.realloc[d.ruiset] = +t.value * +d.scale; render(); }
    else if (d.ruicheck) { S.ui.realloc[d.ruicheck] = t.checked; render(); }
    else if (d.upload) readFile(t.files[0], d.upload);
  });

  document.addEventListener('input', (e) => {
    if (e.target.id !== 'whatif') return;
    const u = S.ui.forecast, members = S.res.series.filter((s) => (!u.dept || s.dept === u.dept) && (!u.cat || s.cat === u.cat));
    u.factor = +e.target.value / 100;
    const g = F.aggregate(members, 'total', S.settings.risk)[0], m = S.month, left = 12 - m;
    const recent = members.reduce((a, s) => a + s.monthA.slice(Math.max(0, m - 3)).reduce((x, y) => x + y, 0), 0) / Math.min(3, m);
    $('#wf-val').textContent = e.target.value + '%';
    $('#wf-out').innerHTML = whatIfCards(F.whatIf(members, m, u.factor), g, recent, left);
  });

  function loadSample() {
    const b = DATA.parseBudget(window.FPA_SAMPLE.budget), c = DATA.parseCommitments(window.FPA_SAMPLE.commitments);
    setData(b.rows, c.rows, '範例資料（模擬）');
    S.tab = 'overview'; render();
  }

  function readFile(file, kind) {
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      const text = String(rd.result);
      if (kind === 'budget') {
        const r = DATA.parseBudget(text);
        if (!r.rows.length) { S.issues = r.issues; render(); return; }
        setData(r.rows, S.comm.filter(() => false), file.name);
        S.issues = r.issues.concat(S.issues);
      } else {
        const r = DATA.parseCommitments(text);
        S.comm = r.rows; recompute(); S.issues = r.issues.concat(S.info ? S.info.issues : []);
      }
      render();
    };
    rd.readAsText(file, 'utf-8');
  }

  function exportCSV(kind) {
    const risk = S.settings.risk, P = S.res.panel;
    if (kind === 'dept') {
      const d = F.aggregate(S.res.series, 'dept', risk);
      download('部門預測.csv', toCSV([['部門', (r) => r.name], ['全年預算', (r) => Math.round(r.fyBudget)], ['年累計實際', (r) => Math.round(r.ytdActual)], ['預測全年', (r) => Math.round(r.fyForecast)],
        ['預測÷預算', (r) => r.rate.toFixed(4)], ['預計差異', (r) => Math.round(r.gap)], ['區間下限', (r) => Math.round(r.lo)], ['區間上限', (r) => Math.round(r.hi)], ['超支機率', (r) => r.pOver.toFixed(3)], ['燈號', (r) => r.risk]], d));
    } else if (kind === 'forecast') {
      download('科目預測.csv', toCSV([['部門', (s) => s.dept], ['費用科目', (s) => s.cat], ['全年預算', (s) => Math.round(s.fyBudget)], ['年累計實際', (s) => Math.round(s.ytdActual)], ['預測全年', (s) => Math.round(s.fyForecast)],
        ['預測÷預算', (s) => s.rate.toFixed(4)], ['區間下限', (s) => Math.round(s.lo)], ['區間上限', (s) => Math.round(s.hi)], ['超支機率', (s) => s.pOver.toFixed(3)], ['承諾支出(未付)', (s) => Math.round(s.commitRemaining)], ['燈號', (s) => s.risk]],
      S.res.series.filter((s) => (!S.ui.forecast.dept || s.dept === S.ui.forecast.dept) && (!S.ui.forecast.cat || s.cat === S.ui.forecast.cat))));
    } else if (kind === 'variance') {
      const u = S.ui.variance;
      download('差異分析.csv', toCSV([['項目', (v) => v.name], ['預算', (v) => Math.round(v.budget)], ['實際', (v) => Math.round(v.actual)], ['差異', (v) => Math.round(v.variance)], ['差異%', (v) => (v.variancePct * 100).toFixed(2)], ['重大差異', (v) => (v.material ? '是' : '')]],
        F.variance(P, u.level, u.window, { dept: u.dept || null, materialPct: S.settings.materialPct, materialAmount: S.settings.materialAmount })));
    } else if (kind === 'alerts') {
      download('預警清單.csv', toCSV([['等級', (a) => a.level], ['類型', (a) => a.type], ['部門', (a) => a.dept], ['費用科目', (a) => a.cat], ['說明', (a) => a.text], ['建議', (a) => a.action]], S.alerts));
    } else if (kind === 'realloc') {
      const u = S.ui.realloc, ra = F.reallocate(S.res, S.hist, { safety: u.safety, minAmount: u.minAmount, allowCross: u.cross });
      download('預算調配建議.csv', toCSV([['來源部門', (x) => x.fromDept], ['來源科目', (x) => x.fromCat], ['目標部門', (x) => x.toDept], ['目標科目', (x) => x.toCat], ['金額', (x) => Math.round(x.amount)], ['跨科目', (x) => (x.cross ? '是' : '')], ['提醒', (x) => x.notes.join('；')]], ra.moves));
    }
  }

  // ------------------------------------------------------------------ boot
  loadSample();
})();
