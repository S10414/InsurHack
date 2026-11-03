(function () {
  'use strict';
  const F = window.FPA, DATA = window.FPAData, C = window.FPACharts, esc = C.esc;
  const MO = window.FPAMotion;
  let field = null, animateNext = true, lastTab = null, heroPlayed = false;
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
      overview: { risk: 'all', sort: { key: 'gap', dir: -1 }, dept: '', proj: null },
      variance: { window: 'ytd', level: 'dept', dept: '', proj: null, sel: null, sort: { key: 'variance', dir: -1 } },
      forecast: { dept: '', proj: null, cat: '', factor: null },
      alerts: { level: 'all' },
      history: { dept: '', proj: null },
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
    for (const k of ['overview', 'variance', 'forecast', 'history']) { S.ui[k].dept = ''; S.ui[k].proj = null; }
    S.ui.forecast.cat = ''; S.ui.variance.sel = null;
    recompute();

  }

  function recompute() {
    S.error = '';
    try {
      if (!S.rows.length || !S.info.lastClosed) throw new Error('沒有可分析的資料，請到「資料」頁載入範例或上傳檔案。');
      S.res = F.forecast(S.rows, S.comm, S.year, S.month, { risk: S.settings.risk });
      const P = S.res.panel;
      S.hist = F.history(P, 'series'); S.histDept = F.history(P, 'dept');
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
  /** Projects of a department ('' entries mean the file had no project column for those rows). */
  const projs = (dept) => [...new Set(S.res.series.filter((s) => !dept || s.dept === dept).map((s) => s.proj))];
  const hasProj = (dept) => projs(dept).some((p) => p);
  const nProj = () => new Set(S.res.series.filter((s) => s.proj).map((s) => s.dept + '|' + s.proj)).size;
  const projLabel = (p) => p || '未分專案';
  /** proj: null = all projects; a string (also '') = that project. */
  const scopeName = (f) => (f.proj != null && hasProj(f.dept) ? projLabel(f.proj) : f.dept || '全公司');
  const scopeKey = (dept, proj) => `${esc(dept || '')}|${proj == null ? '' : '1|' + esc(proj)}`;
  /** Breadcrumb: 全公司 › 部門 › 專案. `attr` names the data attribute that handles the click. */
  function crumbs(f, attr) {
    const parts = [[`${attr}=""`, '全公司']];
    if (f.dept) parts.push([`${attr}="${scopeKey(f.dept, null)}"`, f.dept]);
    if (f.dept && f.proj != null && hasProj(f.dept)) parts.push(['', projLabel(f.proj)]);
    return `<div class="crumbs" role="navigation" aria-label="目前範圍">${parts.map(([a, l], i) => (i === parts.length - 1
      ? `<span aria-current="location">${esc(l)}</span>` : `<button type="button" ${a}>${esc(l)}</button>`)).join('<i aria-hidden="true">›</i>')}</div>`;
  }
  const parseScope = (v) => { const a = String(v).split('|'); return { dept: a[0] || '', proj: a[1] === '1' ? a[2] : null, rest: a.slice(a[1] === '1' ? 3 : 2) }; };
  /** Department + project selects bound to S.ui[tab]. Project select only when the department has projects. */
  function scopeSelects(tab, u, allLabel = '全公司') {
    const pv = u.proj == null ? '*' : u.proj;
    return `<label>部門 <select data-ui="${tab}.dept">${opt('', allLabel, u.dept)}${depts().map((d) => opt(d, d, u.dept)).join('')}</select></label>` +
      (u.dept && hasProj(u.dept) ? `<label>專案 <select data-ui="${tab}.proj">${opt('*', '全部專案', pv)}${projs(u.dept).map((x) => opt(x, projLabel(x), pv)).join('')}</select></label>` : '');
  }
  const rcls = (r) => F.riskClass(r);
  const moveType = (x) => `${x.inDept ? '部門內' : '跨部門'}・${x.cross ? '跨科目' : '同科目'}`;
  /** Budget split of the current scope into its children, coloured by risk. Click a segment to drill down. */
  function strip(items, total, attr) {
    return `<div class="strip" role="list">${items.map((d) => {
      const w = Math.max(d.fyBudget / total * 100, 0.6);
      const dev = d.rate - 1;
      const devTxt = `${dev > 0 ? '+' : dev < 0 ? '−' : ''}${(Math.abs(dev) * 100).toFixed(1)}%`;
      return `<button type="button" role="listitem" class="seg ${rcls(d.risk)}" style="flex:${w} 1 0" ${attr(d)}
        title="${esc(d.label)}｜全年預算 ${M(d.fyBudget)}｜預測全年 ${M(d.fyForecast)}｜${d.gap >= 0 ? '超支' : '結餘'} ${M(Math.abs(d.gap))} 百萬元（${devTxt}）｜${esc(d.risk)}">
        <span class="nm">${esc(d.label)}</span><span class="rt">${devTxt}</span></button>`;
    }).join('')}</div>`;
  }
  const nonRed = () => S.alerts.filter((a) => a.level === '紅燈').length;

  // ------------------------------------------------------------------ views
  /** The overview drills: company -> departments, department -> projects, project -> expense categories. */
  function overviewRows(u, risk) {
    const f = { dept: u.dept, proj: u.dept ? u.proj : null };
    const members = S.res.series.filter((s) => F.inScope(s, f));
    let level, kind;
    if (!u.dept) { level = 'dept'; kind = 'dept'; }
    else if (hasProj(u.dept) && u.proj == null) { level = 'proj'; kind = 'proj'; }
    else { level = 'series'; kind = 'cat'; }
    const rows = F.aggregate(members, level, risk).map((d) => {
      d.label = kind === 'dept' ? d.dept : kind === 'proj' ? projLabel(d.proj) : d.cat;
      if (kind === 'dept') {
        const ps = F.aggregate(d.members, 'proj', risk);
        d.nProj = ps.filter((x) => x.proj).length;
        d.nRed = ps.filter((x) => x.risk.startsWith('紅')).length; d.nAmber = ps.filter((x) => x.risk.startsWith('黃')).length;
      }
      if (kind === 'proj') { d.nCat = d.members.length; d.nRedLines = d.members.filter((x) => x.risk.startsWith('紅')).length; }
      return d;
    });
    return { f, members, rows, kind };
  }

  function viewOverview() {
    const u = S.ui.overview, risk = S.settings.risk;
    const { f, members, rows: all, kind } = overviewRows(u, risk);
    const total = F.aggregate(members, 'total', risk)[0];
    const counts = { red: all.filter((d) => d.risk.startsWith('紅')).length, amber: all.filter((d) => d.risk.startsWith('黃')).length };
    let ds = u.risk === 'all' ? all : all.filter((d) => F.riskClass(d.risk) === u.risk);
    ds = sortRows(ds, u.sort.key === 'name' ? 'label' : u.sort.key, u.sort.dir);
    const inScopeAlert = (a) => F.inScope(a, f);
    const scopedAlerts = S.alerts.filter((a) => a.level !== '提示' && inScopeAlert(a));
    const sev = scopedAlerts.slice(0, 4);
    const unit = { dept: '部門', proj: '專案', cat: '費用科目' }[kind];
    const name = scopeName(f);
    const kp = [
      ['全年預算', M(total.fyBudget), !u.dept ? `${depts().length} 個部門、${nProj() ? nProj() + ' 個專案、' : ''}${cats().length} 類費用` : `${all.length} 個${unit}`],
      ['年累計實際', M(total.ytdActual), `執行率 ${Pc(total.utilization, 1)}，同期預算 ${Pc(total.phased, 1)}`],
      ['預測全年', M(total.fyForecast), `為預算的 ${Pc(total.rate, 1)}（區間 ${Pc(total.lo / total.fyBudget)}～${Pc(total.hi / total.fyBudget)}）`],
      ['預計差異', SM(total.gap), total.gap >= 0 ? '預計超支（百萬元）' : '預計結餘（百萬元）'],
      [`需關注${unit}`, `${counts.red} 紅 / ${counts.amber} 黃`, `共 ${scopedAlerts.length} 項科目層級預警`],
    ];
    const path = F.groupPath(members, S.month);
    S._chartPath = path;
    const nameCell = (d) => {
      let sub = '';
      if (kind === 'dept' && d.nProj) sub = `${d.nProj} 個專案${d.nRed ? `，<b class="pos">${d.nRed} 紅</b>` : ''}${d.nAmber ? `，<b class="amb">${d.nAmber} 黃</b>` : ''}`;
      if (kind === 'proj') sub = `${d.nCat} 個費用科目${d.nRedLines ? `，<b class="pos">${d.nRedLines} 紅</b>` : ''}`;
      return `<td><span class="nm">${esc(d.label)}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</td>`;
    };
    const go = (d) => (kind === 'dept' ? `data-drill="${scopeKey(d.dept, null)}"` : kind === 'proj' ? `data-drill="${scopeKey(d.dept, d.proj)}"`
      : `data-line-go="${scopeKey(d.dept, d.proj)}|${esc(d.cat)}"`);
    const hint = { dept: '點選部門，查看部門內各專案', proj: '點選專案，查看專案的費用科目', cat: '點選科目，查看推估明細' }[kind];
    const hidden = kind === 'dept' ? all.filter((d) => d.risk.startsWith('綠') && (d.nRed || d.nAmber)) : [];
    return `
      ${crumbs(f, 'data-drill')}
      <div class="kpis">${kp.map(([l, v, n]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="n">${n}</div></div>`).join('')}</div>
      <div class="card strip-card"><h3>${esc(name)}的預算組成</h3>
        <p class="small" style="margin:0 0 8px">每一段的寬度是占全年預算的比例；數字是預測全年偏離預算多少，＋為預計超支、−為預計結餘；顏色是燈號。${hint}。</p>
        ${strip(sortRows(all, 'fyBudget', -1), total.fyBudget, go)}
        ${hidden.length ? `<p class="small hidden-risk">${hidden.map((d) => `<b>${esc(d.dept)}</b>整體為綠燈，但內含 ${d.nRed ? d.nRed + ' 個紅燈' : ''}${d.nRed && d.nAmber ? '、' : ''}${d.nAmber ? d.nAmber + ' 個黃燈' : ''}專案`).join('；')}。部門合計會讓專案的超支與結餘互相抵銷。</p>` : ''}
      </div>
      <div class="grid2">
        <div class="card"><h3>${esc(name)}累計支出（百萬元）</h3>
          <div class="legend"><span class="lg-b">累計預算</span><span class="lg-a">累計實際</span><span class="lg-f">預測</span><span class="lg-band">80% 區間</span></div>
          <div id="ch-total"></div><div class="tip" id="tip-total">滑鼠移到圖上查看各月數字</div></div>
        <div class="card"><h3>最需要處理的項目</h3>
          ${sev.length ? sev.map((a) => `<div class="alert ${a.level === '紅燈' ? 'red' : 'amber'}"><div class="t"><span class="pill ${a.level === '紅燈' ? 'red' : 'amber'}">${a.level}</span>${esc(a.title)}</div><div class="a">${esc(a.type.slice(3))}｜預測 ${Pc(a.rate)}｜${SM(a.gap)} 百萬元</div></div>`).join('') : '<div class="empty">這個範圍沒有需要處理的預警</div>'}
          <button class="btn" data-go="alerts">查看全部預警</button></div>
      </div>
      <h2>${u.dept ? esc(name) + '：' : ''}${unit}明細 <span class="small">　${hint}</span></h2>
      <div class="row"><div class="chips">${[['all', '全部'], ['red', '紅燈'], ['amber', '黃燈'], ['green', '綠燈']].map(([k, l]) => `<button class="chip ${u.risk === k ? 'on' : ''}" data-chip="overview.risk:${k}">${l}</button>`).join('')}</div>
        ${u.dept ? `<button class="btn" data-drill="${f.proj != null && hasProj(u.dept) ? scopeKey(u.dept, null) : ''}">回上一層</button>` : ''}
        <button class="btn" data-fc-scope>看${esc(name)}的年底預測</button>
        <button class="btn" data-export="overview">匯出 CSV</button></div>
      <div class="card tw"><table><thead><tr>
        ${th('overview', 'name', unit, u.sort, true)}${th('overview', 'fyBudget', '全年預算', u.sort)}${th('overview', 'ytdActual', '年累計實際', u.sort)}
        ${th('overview', 'utilization', '執行率 / 同期進度', u.sort)}${th('overview', 'fyForecast', '預測全年', u.sort)}${th('overview', 'rate', '預測÷預算', u.sort)}
        ${th('overview', 'gap', '預計差異', u.sort)}<th>80% 區間</th>${th('overview', 'pOver', '超支機率', u.sort)}<th>燈號</th></tr></thead><tbody>
        ${ds.map((d) => `<tr class="click" ${go(d)}>${nameCell(d)}<td>${M(d.fyBudget)}</td><td>${M(d.ytdActual)}</td>
          <td>${bar(d.utilization, d.phased)} <span class="small">${Pc(d.utilization)} / ${Pc(d.phased)}</span></td><td>${M(d.fyForecast)}</td><td class="hl">${Pc(d.rate, 1)}</td>
          <td class="${d.gap > 0 ? 'pos' : 'neg'}">${SM(d.gap)}</td><td class="small">${Pc(d.lo / d.fyBudget)}～${Pc(d.hi / d.fyBudget)}</td><td>${Pc(d.pOver)}</td><td>${pill(d.risk)}</td></tr>`).join('') || `<tr><td colspan="10" class="empty">沒有符合的${unit}</td></tr>`}
        </tbody><tfoot><tr><td>${esc(name)}合計</td><td>${M(total.fyBudget)}</td><td>${M(total.ytdActual)}</td><td></td><td>${M(total.fyForecast)}</td><td>${Pc(total.rate, 1)}</td><td>${SM(total.gap)}</td><td></td><td>${Pc(total.pOver)}</td><td>${pill(total.risk)}</td></tr></tfoot></table></div>
      <p class="small">執行率 = 年累計實際 ÷ 全年預算；黑線是「預算同期進度」，依預算自己的月份分佈計算，不是平均 1/12。合計列的超支機率把下層項目視為互相獨立，實際風險可能較高。金額單位：百萬元。</p>`;
  }

  function viewVariance() {
    const u = S.ui.variance, P = S.res.panel;
    const vars = F.variance(P, u.level, u.window, { dept: u.dept || null, proj: u.proj, materialPct: S.settings.materialPct, materialAmount: S.settings.materialAmount });
    const rows = sortRows(vars, u.sort.key, u.sort.dir);
    S._varRows = rows;
    const sel = u.sel || {};
    const scope = scopeName({ dept: u.dept, proj: u.proj });
    const wl = { month: '當月', qtd: '本季累計', ytd: '年累計' }[u.window];
    const totalB = vars.reduce((a, v) => a + v.budget, 0), totalA = vars.reduce((a, v) => a + v.actual, 0);
    const spikes = F.flagSpikes(P).map((s) => ({ dept: P.keys[s.k].dept, proj: P.keys[s.k].proj, cat: P.keys[s.k].cat, month: s.month, ...s }))
      .filter((s) => F.inScope(s, { dept: u.dept, proj: u.proj }));
    const withProj = nProj() > 0;
    return `
      <div class="row">
        <label>期間 <select data-ui="variance.window">${opt('month', '當月', u.window)}${opt('qtd', '本季累計', u.window)}${opt('ytd', '年累計', u.window)}</select></label>
        <label>層級 <select data-ui="variance.level">${opt('dept', '部門', u.level)}${withProj ? opt('proj', '專案', u.level) : ''}${opt('cat', '費用科目', u.level)}${opt('dept_cat', '部門×科目', u.level)}${withProj ? opt('series', '專案×科目', u.level) : ''}</select></label>
        ${scopeSelects('variance', u)}
        <label>重大差異門檻 ≥ <input type="number" step="1" min="0" value="${S.settings.materialPct * 100}" data-set="materialPct" data-scale="0.01">% 且 ≥ <input type="number" step="0.5" min="0" value="${S.settings.materialAmount / 1e6}" data-set="materialAmount" data-scale="1000000">百萬元</label>
        <button class="btn" data-export="variance">匯出 CSV</button>
      </div>
      <div class="grid2">
        <div class="card"><h3>預算 → 實際：差異來源（${wl}）</h3><div id="ch-wf"></div></div>
        <div class="card"><h3>${esc(sel.name || scope)}：每月差異（近 24 個月）</h3><div id="ch-trend"></div><div class="tip" id="tip-trend">紅色 = 超支，綠色 = 低於預算</div></div>
      </div>
      <h2>差異明細（${wl}）<span class="small">　點選一列查看該項目的月度趨勢</span></h2>
      <div class="card tw"><table><thead><tr>${th('variance', 'name', '項目', u.sort, true)}${th('variance', 'budget', '預算', u.sort)}${th('variance', 'actual', '實際', u.sort)}
        ${th('variance', 'variance', '差異（實際−預算）', u.sort)}${th('variance', 'variancePct', '差異%', u.sort)}<th>方向</th><th>重大差異</th></tr></thead><tbody>
        ${rows.map((v, i) => `<tr class="click ${sel.name === v.name ? 'sel' : ''}" data-var-sel="${i}"><td>${esc(v.name)}</td><td>${M(v.budget)}</td><td>${M(v.actual)}</td>
          <td class="${v.variance > 0 ? 'pos' : 'neg'}">${SM(v.variance)}</td><td class="${v.variance > 0 ? 'pos' : 'neg'}">${v.variancePct > 0 ? '+' : ''}${Pc(v.variancePct, 1)}</td><td>${v.direction}</td>
          <td>${v.material ? '<span class="pill amber">重大</span>' : ''}</td></tr>`).join('')}
        </tbody><tfoot><tr><td>合計</td><td>${M(totalB)}</td><td>${M(totalA)}</td><td class="${totalA > totalB ? 'pos' : 'neg'}">${SM(totalA - totalB)}</td><td>${Pc((totalA - totalB) / totalB, 1)}</td><td></td><td></td></tr></tfoot></table></div>
      <p class="small">金額單位：百萬元。差異 = 實際 − 預算，正數為超支。重大差異需同時達到百分比與金額門檻。</p>
      <h2>單月異常偵測</h2>
      <div class="card tw">${spikes.length ? `<table><thead><tr><th>期間</th><th class="l">部門</th>${withProj ? '<th class="l">專案</th>' : ''}<th class="l">費用科目</th><th>預算</th><th>實際</th><th>為預算的倍數</th><th>型態</th></tr></thead><tbody>
        ${spikes.map((s) => `<tr><td>${P.year}-${String(s.month).padStart(2, '0')}</td><td class="l">${esc(s.dept)}</td>${withProj ? `<td class="l">${esc(projLabel(s.proj))}</td>` : ''}<td class="l">${esc(s.cat)}</td><td>${M(s.budget)}</td><td>${M(s.actual)}</td><td>${s.ratio.toFixed(1)}x</td><td><span class="pill ${s.pattern === '單月異常' ? 'info' : 'amber'}">${s.pattern}</span></td></tr>`).join('')}</tbody></table>
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
    const scopeCats = [...new Set(S.res.series.filter((s) => F.inScope(s, { dept: u.dept, proj: u.proj })).map((s) => s.cat))];
    if (u.cat && !scopeCats.includes(u.cat)) u.cat = '';
    const members = S.res.series.filter((s) => F.inScope(s, u));
    const withProj = nProj() > 0;
    const sel = `<div class="row">
        ${scopeSelects('forecast', u)}
        <label>費用科目 <select data-ui="forecast.cat">${opt('', '全部科目', u.cat)}${scopeCats.map((c) => opt(c, c, u.cat)).join('')}</select></label>
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
        <div class="card"><h3>${esc([u.dept, u.proj != null && hasProj(u.dept) ? projLabel(u.proj) : '', u.cat].filter(Boolean).join('・') || '全公司')}：累計支出（百萬元）</h3>
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
      <div class="card tw"><table><thead><tr><th class="l">部門</th>${withProj ? '<th class="l">專案</th>' : ''}<th class="l">費用科目</th><th>全年預算</th><th>年累計</th>
        ${F.METHODS.map((n) => `<th title="預測剩餘月份會用掉的剩餘預算比例">${F.METHOD_LABELS[n]}</th>`).join('')}<th>組合</th><th>承諾(未付)</th><th>預測全年</th><th>預測÷預算</th><th>燈號</th></tr></thead><tbody>
        ${rowsDetail.map((s) => `<tr><td class="l">${esc(s.dept)}</td>${withProj ? `<td class="l">${esc(projLabel(s.proj))}</td>` : ''}<td class="l">${esc(s.cat)}</td><td>${M(s.fyBudget)}</td><td>${M(s.ytdActual)}</td>
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

  /** History drills like the overview: departments -> projects -> expense categories of one project. */
  function historyScope() {
    const u = S.ui.history, P = S.res.panel;
    const f = { dept: u.dept, proj: u.dept ? u.proj : null };
    if (!u.dept) return { f, kind: 'dept', rows: S.histDept };
    if (hasProj(u.dept) && u.proj == null) return { f, kind: 'proj', rows: F.history(P, 'proj', { dept: u.dept }) };
    return { f, kind: 'cat', rows: S.hist.filter((h) => F.inScope(h, f)) };
  }

  function viewHistory() {
    const hd = S.histDept;
    if (!hd.length || !hd[0].years.length) return '<div class="empty">需要至少一個已完整結帳的歷史年度。</div>';
    const years = hd[0].years;
    const { f, kind, rows: hrows } = historyScope();
    const rate = (x) => `<span class="${x > 1.03 ? 'pos' : x < 0.92 ? 'neg' : ''}">${Pc(x, 1)}</span>`;
    const label = (h) => (kind === 'dept' ? h.dept : kind === 'proj' ? projLabel(h.proj) : h.cat);
    const go = (h) => (kind === 'dept' ? `class="click" data-hist-go="${scopeKey(h.dept, null)}"` : kind === 'proj' ? `class="click" data-hist-go="${scopeKey(h.dept, h.proj)}"` : '');
    const cell = (h) => `<tr ${go(h)}><td>${esc(label(h))}</td>${h.rates.map((r) => `<td>${rate(r)}</td>`).join('')}<td class="hl">${rate(h.mean)}</td><td>${Number.isFinite(h.trend) ? (h.trend > 0 ? '+' : '') + (h.trend * 100).toFixed(1) + ' 點/年' : '–'}</td><td>${Number.isFinite(h.q4Gap) ? (h.q4Gap > 0 ? '+' : '') + (h.q4Gap * 100).toFixed(1) + ' 點' : '–'}</td><td class="l">${tags(h.tags)}</td></tr>`;
    const unit = { dept: '部門', proj: '專案', cat: '費用科目' }[kind];
    const head = `<thead><tr><th>${unit}</th>${years.map((y) => `<th>${y} 執行率</th>`).join('')}<th>平均</th><th>趨勢</th><th title="Q4 占全年實際支出的比例，減去 Q4 占預算的比例">Q4 偏離</th><th class="l">型態</th></tr></thead>`;
    const rows = hrows.slice().sort((a, b) => b.mean - a.mean);
    const hint = { dept: '點選部門可往下看專案。', proj: '點選專案可往下看費用科目。', cat: '' }[kind];
    return `
      ${crumbs(f, 'data-hist-go')}
      <div class="row"><span class="small">執行率 = 全年實際 ÷ 全年預算；紅字 > 103%，綠字 < 92%。${hint}</span></div>
      <div class="card tw"><table>${head}<tbody>${rows.map(cell).join('')}</tbody></table></div>
      <h2>支出節奏：${esc(scopeName(f))}</h2>
      <div class="card"><div class="legend"><span style="--c:var(--budget)" class="lg-b">預算進度</span><span class="lg-a">歷史平均實際</span><span class="lg-f">今年累計 ÷ 預測全年</span></div>
        <div id="ch-shape"></div>
        <p class="small">縱軸是各月底累計支出占全年的比例。歷史平均若明顯高於預算線，代表該單位習慣把支出放在年底；今年累計若落在歷史平均之下，要看是否為預期中的季節性。</p></div>`;
  }

  function viewRealloc() {
    const u = S.ui.realloc;
    const ra = F.reallocate(S.res, S.hist, { safety: u.safety, minAmount: u.minAmount, allowCross: u.cross });
    const after = F.applyMoves(S.res.series, ra.moves).filter((x) => Math.abs(x.after - x.before) > 1);
    const sm = ra.summary;
    return `
      <div class="note">邏輯：預計用不完的項目，扣掉安全邊際後的餘額可以釋出；預計超支的項目依缺口大小優先補足。順序是同部門其他專案的同一科目、其他部門的同一科目，最後才是跨科目（會標示提醒）。這是建議，不是決策。</div>
      <div class="row">
        <label>釋出餘額的保守程度 <select data-ui="realloc.safety">${opt(1, '保守：以 80% 區間上限估算支出', u.safety)}${opt(0.5, '中性：區間上限與預測值的中間', u.safety)}${opt(0, '積極：以預測值估算支出', u.safety)}</select></label>
        <label>單筆最低金額 <input type="number" step="0.5" min="0" value="${u.minAmount / 1e6}" data-ruiset="minAmount" data-scale="1000000">百萬元</label>
        <label><input type="checkbox" ${u.cross ? 'checked' : ''} data-ruicheck="cross"> 允許跨費用科目</label>
        <button class="btn" data-export="realloc">匯出 CSV</button></div>
      <div class="kpis">
        <div class="kpi"><div class="l">預計超支缺口（機率 ≥ 50%）</div><div class="v">${M(sm.totalNeed)}</div><div class="n">${ra.receivers.length} 個項目（百萬元）</div></div>
        <div class="kpi"><div class="l">可釋出餘額</div><div class="v">${M(sm.totalCapacity)}</div><div class="n">${ra.donors.length} 個項目（百萬元）</div></div>
        <div class="kpi"><div class="l">建議調配金額</div><div class="v">${M(sm.used)}</div><div class="n">${ra.moves.length} 筆</div></div>
        <div class="kpi"><div class="l">缺口補足比例</div><div class="v">${sm.totalNeed ? Pc(sm.covered / sm.totalNeed, sm.totalNeed - sm.covered > 1 ? 1 : 0) : '–'}</div><div class="n">${sm.totalNeed - sm.covered > 1 ? '未補足 ' + M(sm.totalNeed - sm.covered) + ' 百萬元，需追加預算' : '全數可由內部調配'}</div></div>
      </div>
      <h2>調配建議</h2>
      <div class="card tw">${ra.moves.length ? `<table><thead><tr><th class="l">自（部門・專案・科目）</th><th class="l">至（部門・專案・科目）</th><th class="l">類型</th><th>金額（百萬元）</th><th class="l">提醒</th></tr></thead><tbody>
        ${ra.moves.map((x) => `<tr><td class="l">${esc(x.from)}</td><td class="l">${esc(x.to)}</td><td class="l nw">${moveType(x)}</td><td class="hl">${M(x.amount)}</td><td class="l small nw">${x.notes.map(esc).join('；') || '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">目前沒有需要或可以調配的項目</div>'}</div>
      ${after.length ? `<h2>調配後的預測執行率</h2><div class="card tw"><table><thead><tr><th class="l">部門・專案・科目</th><th>調整前預算</th><th>調整後預算</th><th>預測全年</th><th>調整前 預測÷預算</th><th>調整後 預測÷預算</th></tr></thead><tbody>
        ${after.map((x) => `<tr><td class="l">${esc(x.name)}</td><td>${M(x.before)}</td><td>${M(x.after)}</td><td>${M(x.forecast)}</td><td>${Pc(x.rateBefore, 1)}</td><td class="hl">${Pc(x.rateAfter, 1)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <p class="small">提醒欄位會標示來源項目的承諾支出、歷史上長期未用完，或今年執行落後但可能是專案延後的情況，後者不建議立即釋出。</p>`;
  }

  function viewData() {
    const info = S.info;
    return `
      <div class="grid2e">
        <div class="card"><h3>使用範例資料</h3><p class="small">模擬一家壽險公司 10 個部門、24 個專案、8 類費用，2023–2026 年。六種典型情境埋在特定專案裡，例如核心系統換版延後、品牌廣告年底集中消化、委外理賠調查費用暴增。</p>
          <button class="btn pri" data-load-sample>載入範例資料</button></div>
        <div class="card"><h3>上傳你的資料（CSV）</h3>
          <div class="row"><label>預算與實際 <input type="file" accept=".csv,text/csv" data-upload="budget"></label></div>
          <div class="row"><label>承諾支出（選填） <input type="file" accept=".csv,text/csv" data-upload="comm"></label></div>
          <div class="row"><button class="btn" data-template="budget">下載預算檔範本</button><button class="btn" data-template="comm">下載承諾支出範本</button></div>
          <p class="small">欄位：年度、月份、部門、專案（選填）、費用科目、預算、實際（尚未結帳的月份實際留白）。有專案欄位時，總覽可以從部門往下看到各專案。建議至少 3 年資料，最新年度為進行中。資料只在你的瀏覽器內處理。</p></div>
      </div>
      ${S.issues.map((i) => `<div class="warn">${esc(i)}</div>`).join('')}
      ${info && S.rows.length ? `<h2>目前資料</h2><div class="kpis">
        <div class="kpi"><div class="l">來源</div><div class="v" style="font-size:16px">${esc(S.source)}</div></div>
        <div class="kpi"><div class="l">年度</div><div class="v" style="font-size:16px">${info.years[0]}–${info.years[info.years.length - 1]}</div><div class="n">${info.years.length} 年</div></div>
        <div class="kpi"><div class="l">部門 / 專案 / 科目</div><div class="v" style="font-size:16px">${info.depts.length} / ${info.projs.length || '–'} / ${info.cats.length}</div></div>
        <div class="kpi"><div class="l">最新年度已結帳</div><div class="v" style="font-size:16px">${info.lastClosed} 個月</div></div>
        <div class="kpi"><div class="l">承諾支出</div><div class="v" style="font-size:16px">${S.comm.length} 筆</div></div></div>
        <div class="card tw"><table><thead><tr><th>年度</th><th>月份</th><th class="l">部門</th><th class="l">專案</th><th class="l">費用科目</th><th>預算</th><th>實際</th></tr></thead><tbody>
        ${S.rows.slice(-8).map((r) => `<tr><td>${r.year}</td><td>${r.month}</td><td class="l">${esc(r.dept)}</td><td class="l">${esc(r.proj || '–')}</td><td class="l">${esc(r.cat)}</td><td>${r.budget.toLocaleString()}</td><td>${r.actual === null ? '' : r.actual.toLocaleString()}</td></tr>`).join('')}
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
    const anim = animateNext; animateNext = false;
    if (S.tab === 'overview' && g('ch-total')) { C.cumulative(g('ch-total'), S._chartPath, S.month, g('tip-total')); if (anim) MO.revealChart(g('ch-total')); }
    if (S.tab === 'forecast' && g('ch-fc')) { C.cumulative(g('ch-fc'), S._chartPath, S.month, g('tip-fc')); if (anim) MO.revealChart(g('ch-fc')); }
    if (S.tab !== lastTab) { MO.tabEnter($('#view')); lastTab = S.tab; }
    if (S.tab === 'variance') {
      const u = S.ui.variance, P = S.res.panel, sel = u.sel || {};
      const vars = F.variance(P, u.level, u.window, { dept: u.dept || null, proj: u.proj });
      C.waterfall(g('ch-wf'), F.waterfall(vars, 8));
      if (anim) MO.revealBars(g('ch-wf'));
      C.varianceBars(g('ch-trend'), F.varianceTrend(P, { dept: sel.dept || u.dept || null, proj: sel.proj !== undefined ? sel.proj : u.proj, cat: sel.cat || null, months: 24 }), g('tip-trend'));
    }
    if (S.tab === 'history' && g('ch-shape')) {
      const { f } = historyScope();
      const base = F.history(S.res.panel, 'total', f)[0];
      const lines = [{ label: '預算', values: base.budgetShape, color: 'var(--budget)', dash: '5 4', width: 2 }];
      base.shapeByYear.forEach((v, i) => lines.push({ label: String(base.years[i]), values: v, color: 'var(--line)', width: 1.5 }));
      lines.push({ label: '歷史平均', values: base.shape, color: 'var(--accent)', width: 3 });
      const members = S.res.series.filter((s) => F.inScope(s, f));
      const gg = F.aggregate(members, 'total', S.settings.risk)[0], path = F.groupPath(members, S.month);
      lines.push({ label: `${S.year} 累計`, values: path.actual.map((a) => a / gg.fyForecast), color: 'var(--ink)', width: 3 });
      C.shareLines(g('ch-shape'), lines, S.month);
    }
  }

  // ------------------------------------------------------------------ events
  const setPath = (obj, path, val) => { const ks = path.split('.'); let o = obj; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = val; };

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab],[data-sort],[data-go],[data-drill],[data-line-go],[data-fc-scope],[data-chip],[data-var-sel],[data-hist-go],[data-export],[data-load-sample],[data-template],[data-whatif-reset],[data-risk-reset]');
    if (!t) return;
    const d = t.dataset;
    if (d.tab) { animateNext = true; S.tab = d.tab; render(); MO.toTools(); }
    else if (d.go) { S.tab = d.go; render(); MO.toTools(); }
    else if (d.sort) { const [tab, key] = d.sort.split(':'); const s = S.ui[tab].sort; s.dir = s.key === key ? -s.dir : (key === 'name' ? 1 : -1); s.key = key; render(); }
    else if (d.drill !== undefined) { const sc = parseScope(d.drill), u = S.ui.overview; u.dept = sc.dept; u.proj = sc.dept ? sc.proj : null; u.risk = 'all'; animateNext = true; render(); MO.toTools(); }
    else if (d.lineGo !== undefined) { const sc = parseScope(d.lineGo); openForecast(sc.dept, sc.proj, sc.rest[0] || ''); }
    else if (d.fcScope !== undefined) { const u = S.ui.overview; openForecast(u.dept, u.dept ? u.proj : null, ''); }
    else if (d.chip) { const [p, v] = d.chip.split(':'); setPath(S.ui, p, v); render(); }
    else if (d.varSel !== undefined) {
      const v = (S._varRows || [])[+d.varSel], u = S.ui.variance;
      if (v) u.sel = u.sel && u.sel.name === v.name ? null : { dept: v.dept || null, proj: v.proj, cat: v.cat || null, name: v.name };
      render();
    }
    else if (d.histGo !== undefined) { const sc = parseScope(d.histGo), u = S.ui.history; u.dept = sc.dept; u.proj = sc.dept ? sc.proj : null; render(); }
    else if (d.export) exportCSV(d.export);
    else if (d.loadSample !== undefined) loadSample();
    else if (d.template) download(d.template === 'budget' ? '預算檔範本.csv' : '承諾支出範本.csv', d.template === 'budget' ? DATA.TEMPLATE : DATA.COMMIT_TEMPLATE);
    else if (d.whatifReset !== undefined) { S.ui.forecast.factor = null; render(); }
    else if (d.riskReset !== undefined) { S.settings.risk = JSON.parse(JSON.stringify(F.DEFAULT_SETTINGS.risk)); recompute(); render(); }
  });

  document.addEventListener('change', (e) => {
    const t = e.target, d = t.dataset;
    if (t.id === 'asof') { S.month = +t.value; S.ui.forecast.factor = null; recompute(); animateNext = true; render(); renderHero(true); return; }
    if (d.ui) {
      animateNext = true;
      const v = t.value, [tab, field] = d.ui.split('.');
      setPath(S.ui, d.ui, d.ui === 'realloc.safety' ? +v : field === 'proj' ? (v === '*' ? null : v) : v);
      if (field === 'dept' && 'proj' in S.ui[tab]) S.ui[tab].proj = null;
      if (tab === 'forecast') S.ui.forecast.factor = null;
      if (tab === 'variance' && field !== 'window') S.ui.variance.sel = null;
      render();
    }
    else if (d.set) { S.settings[d.set] = +t.value * +d.scale; render(); }
    else if (d.risk) { S.settings.risk[d.risk] = +t.value * +d.scale; recompute(); render(); }
    else if (d.ruiset) { S.ui.realloc[d.ruiset] = +t.value * +d.scale; render(); }
    else if (d.ruicheck) { S.ui.realloc[d.ruicheck] = t.checked; render(); }
    else if (d.upload) readFile(t.files[0], d.upload);
  });

  document.addEventListener('input', (e) => {
    if (e.target.id !== 'whatif') return;
    const u = S.ui.forecast, members = S.res.series.filter((s) => F.inScope(s, u));
    u.factor = +e.target.value / 100;
    const g = F.aggregate(members, 'total', S.settings.risk)[0], m = S.month, left = 12 - m;
    const recent = members.reduce((a, s) => a + s.monthA.slice(Math.max(0, m - 3)).reduce((x, y) => x + y, 0), 0) / Math.min(3, m);
    $('#wf-val').textContent = e.target.value + '%';
    $('#wf-out').innerHTML = whatIfCards(F.whatIf(members, m, u.factor), g, recent, left);
  });

  function openForecast(dept, proj, cat) {
    const u = S.ui.forecast;
    u.dept = dept || ''; u.proj = dept ? proj : null; u.cat = cat || ''; u.factor = null;
    S.tab = 'forecast'; animateNext = true; render(); MO.toTools();
  }

  function loadSample() {
    const b = DATA.parseBudget(window.FPA_SAMPLE.budget), c = DATA.parseCommitments(window.FPA_SAMPLE.commitments);
    setData(b.rows, c.rows, '範例資料（模擬）');
    S.tab = 'overview'; animateNext = true; render(); renderHero(heroPlayed);
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
        renderHero(true);
      } else {
        const r = DATA.parseCommitments(text);
        S.comm = r.rows; recompute(); S.issues = r.issues.concat(S.info ? S.info.issues : []);
        renderHero(true);
      }
      render();
    };
    rd.readAsText(file, 'utf-8');
  }

  function exportCSV(kind) {
    const risk = S.settings.risk, P = S.res.panel;
    if (kind === 'overview') {
      const { rows: d, kind: k } = overviewRows(S.ui.overview, risk);
      download(`${scopeName({ dept: S.ui.overview.dept, proj: S.ui.overview.proj })}_${{ dept: '部門', proj: '專案', cat: '科目' }[k]}預測.csv`, toCSV([['部門', (r) => r.dept], ['專案', (r) => r.proj || ''], ['費用科目', (r) => r.cat || ''], ['全年預算', (r) => Math.round(r.fyBudget)], ['年累計實際', (r) => Math.round(r.ytdActual)], ['預測全年', (r) => Math.round(r.fyForecast)],
        ['預測÷預算', (r) => r.rate.toFixed(4)], ['預計差異', (r) => Math.round(r.gap)], ['區間下限', (r) => Math.round(r.lo)], ['區間上限', (r) => Math.round(r.hi)], ['超支機率', (r) => r.pOver.toFixed(3)], ['燈號', (r) => r.risk]], d));
    } else if (kind === 'forecast') {
      download('科目預測.csv', toCSV([['部門', (s) => s.dept], ['專案', (s) => s.proj], ['費用科目', (s) => s.cat], ['全年預算', (s) => Math.round(s.fyBudget)], ['年累計實際', (s) => Math.round(s.ytdActual)], ['預測全年', (s) => Math.round(s.fyForecast)],
        ['預測÷預算', (s) => s.rate.toFixed(4)], ['區間下限', (s) => Math.round(s.lo)], ['區間上限', (s) => Math.round(s.hi)], ['超支機率', (s) => s.pOver.toFixed(3)], ['承諾支出(未付)', (s) => Math.round(s.commitRemaining)], ['燈號', (s) => s.risk]],
      S.res.series.filter((s) => F.inScope(s, S.ui.forecast))));
    } else if (kind === 'variance') {
      const u = S.ui.variance;
      download('差異分析.csv', toCSV([['項目', (v) => v.name], ['預算', (v) => Math.round(v.budget)], ['實際', (v) => Math.round(v.actual)], ['差異', (v) => Math.round(v.variance)], ['差異%', (v) => (v.variancePct * 100).toFixed(2)], ['重大差異', (v) => (v.material ? '是' : '')]],
        F.variance(P, u.level, u.window, { dept: u.dept || null, proj: u.proj, materialPct: S.settings.materialPct, materialAmount: S.settings.materialAmount })));
    } else if (kind === 'alerts') {
      download('預警清單.csv', toCSV([['等級', (a) => a.level], ['類型', (a) => a.type], ['部門', (a) => a.dept], ['專案', (a) => a.proj || ''], ['費用科目', (a) => a.cat], ['說明', (a) => a.text], ['建議', (a) => a.action]], S.alerts));
    } else if (kind === 'realloc') {
      const u = S.ui.realloc, ra = F.reallocate(S.res, S.hist, { safety: u.safety, minAmount: u.minAmount, allowCross: u.cross });
      download('預算調配建議.csv', toCSV([['來源部門', (x) => x.fromDept], ['來源專案', (x) => x.fromProj || ''], ['來源科目', (x) => x.fromCat], ['目標部門', (x) => x.toDept], ['目標專案', (x) => x.toProj || ''], ['目標科目', (x) => x.toCat], ['金額', (x) => Math.round(x.amount)], ['類型', moveType], ['提醒', (x) => x.notes.join('；')]], ra.moves));
    }
  }

    // ------------------------------------------------------------------ hero (headline + WebGL field)
  function heroRows() {
    const risk = S.settings.risk, order = { red: 0, amber: 1, green: 2 };
    const ds = F.aggregate(S.res.series, 'dept', risk).sort((a, b) => order[F.riskClass(a.risk)] - order[F.riskClass(b.risk)] || b.gap - a.gap);
    return ds.map((d) => {
      const months = [];
      for (let i = 0; i < 12; i++) {
        let v = 0, b = 0;
        for (const s of d.members) { b += s.monthB[i]; v += i < S.month ? s.monthA[i] : s.monthF[i - S.month]; }
        months.push({ value: v, budget: b, forecast: i >= S.month });
      }
      return { name: d.dept, months };
    });
  }

  function renderHero(replay) {
    const title = $('#hero-title');
    if (!S.res) { title.innerHTML = '<span class="ln"><span>載入資料後開始分析</span></span>'; $('#hero-sub').textContent = ''; return; }
    const t = F.aggregate(S.res.series, 'total', S.settings.risk)[0];
    const gapM = Math.abs(t.gap) / 1e6;
    title.innerHTML =
      `<span class="ln"><span>${S.year} 年預計${t.gap < 0 ? '結餘' : '超支'} <b data-v="${gapM.toFixed(1)}" data-d="1">${gapM.toFixed(1)}</b> 百萬元</span></span>`;
    renderHeroSub();
    if (field) field.setData({ rows: heroRows(), closed: S.month });
    if (!heroPlayed) { heroPlayed = true; MO.heroIntro(field); }
    else if (replay) { MO.refreshHeroNumbers(); MO.regrow(); }
  }

  /** One line under the headline: departments forecast above budget, and below it. Items are dropped
   *  (largest deviations kept) until the line fits the width; CSS ellipsis is the last fallback. */
  function renderHeroSub() {
    const el = $('#hero-sub');
    if (!S.res || !el) return;
    const ds = F.aggregate(S.res.series, 'dept', S.settings.risk);
    const dev = (d) => d.rate - 1;
    const over = ds.filter((d) => d.risk.startsWith('紅') || d.risk === '黃燈・小幅超支風險').sort((a, b) => dev(b) - dev(a));
    const under = ds.filter((d) => d.risk === '黃燈・預計大幅未執行').sort((a, b) => dev(a) - dev(b));
    const pct = (d) => `${dev(d) > 0 ? '+' : '−'}${(Math.abs(dev(d)) * 100).toFixed(1)}%`;
    const item = (d) => `${esc(d.dept)} <b>${pct(d)}</b>`;
    const group = (label, cls, list, n, short) => (list.length ? `<span class="grp ${cls}"><i class="sw ${cls}"></i>${label}：${list.slice(0, n).map(item).join('、')}${list.length > n ? ` 等 ${list.length} 個${short ? '' : '部門'}` : ''}</span>` : '');
    const draw = (no, nu, short) => {
      el.innerHTML = (over.length || under.length)
        ? group(short ? '超支' : '高於預算', 'over', over, no, short) + group(short ? '結餘' : '低於預算', 'under', under, nu, short)
        : '各部門的全年預測都在預算附近';
      el.title = (over.length ? '高於預算：' + over.map((d) => `${d.dept} ${pct(d)}`).join('、') : '') +
        (under.length ? '　低於預算：' + under.map((d) => `${d.dept} ${pct(d)}`).join('、') : '');
    };
    const fits = () => el.scrollWidth <= el.clientWidth + 1;
    let no = over.length, nu = under.length, short = false;
    draw(no, nu, short);
    while (!fits() && (no > 1 || nu > 1 || !short)) {
      if (no > 1 && no >= nu) no--; else if (nu > 1) nu--; else short = true;
      draw(no, nu, short);
    }
  }

  function initField() {
    const canvas = $('#field'), tip = $('#field-tip');
    const M1 = (x) => (x / 1e6).toLocaleString('zh-TW', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    try {
      field = window.FPAField && window.FPAField.create(canvas, $('#field-labels'), {
        reducedMotion: !MO.enabled,
        onHover(c, x, y) {
          if (!c) { tip.hidden = true; return; }
          const r = c.value / c.budget - 1;
          tip.innerHTML = `<b>${esc(c.row)}</b>　${S.year} 年 ${c.i + 1} 月${c.forecast ? '（預測）' : ''}<br>支出 ${M1(c.value)}　預算 ${M1(c.budget)} 百萬元<br><span class="${r > 0 ? 'pos' : 'neg'}">${r > 0 ? '+' : ''}${(r * 100).toFixed(1)}%</span>`;
          tip.hidden = false;
          const w = canvas.clientWidth;
          tip.style.transform = `translate(${Math.min(x + 14, w - 230)}px, ${Math.max(y - 70, 4)}px)`;
        },
        onPick(c) { const u = S.ui.overview; u.dept = c.row; u.proj = null; u.risk = 'all'; S.tab = 'overview'; animateNext = true; render(); MO.goTools(); },
      });
    } catch (e) { field = null; console.warn('WebGL field disabled:', e.message); }
    if (!field) document.body.classList.add('no-webgl');
    else MO.pinHero($('#hero'), field);
  }

  // ------------------------------------------------------------------ boot
  MO.init();
  initField();
  loadSample();
  $('#cue').addEventListener('click', () => MO.goTools());
  let subTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(subTimer); subTimer = setTimeout(renderHeroSub, 120); });
})();
