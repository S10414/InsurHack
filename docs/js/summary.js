/*
 * Rule-based summary ("自動摘要"). Every sentence is filled from the engine's own outputs — forecast, interval,
 * probability, alerts, spike detector, history tags, commitments and the reallocation plan — so each number in
 * the text can be traced back to a table in the tool. No language model is involved.
 *
 * build(ctx) -> { headline, items: [{ tone, text, link }], text }
 *   ctx = { res, alerts, hist, panel, year, month, risk, scope: { dept, proj }, realloc, F }
 *   tone: 'red' | 'amber' | 'info' | 'ok';  link: { kind: 'line', dept, proj, cat } | { kind: 'tab', tab } | { kind: 'scope', dept, proj }
 */
(function (root) {
  'use strict';

  function amt(x) {
    const t = [[1e12, '兆元'], [1e8, '億元'], [1e4, '萬元'], [1, '元']], a = Math.abs(x);
    const [div, u] = t.find((q) => a >= q[0]) || t[3];
    const v = a / div, d = u === '元' ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return Number(v.toFixed(d)).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ' + u;
  }
  const pc = (x, d = 0) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '–');

  function build(ctx) {
    const { res, alerts, hist, panel: P, year, month, risk, scope, realloc, F } = ctx;
    const f = { dept: scope.dept || null, proj: scope.dept ? scope.proj : null };
    const members = res.series.filter((s) => F.inScope(s, f));
    if (!members.length) return { headline: '', items: [], text: '' };
    const T = F.aggregate(members, 'total', risk)[0];
    const name = !f.dept ? '全公司' : f.proj != null ? `${f.dept}・${f.proj || '未分專案'}` : f.dept;
    const lineLabel = (x) => [!f.dept ? x.dept : '', x.proj && f.proj == null ? x.proj : '', x.cat].filter(Boolean).join('・');
    const hmap = new Map(hist.map((h) => [F.lineKey(h), h]));
    const tagsOf = (s) => (hmap.get(F.lineKey(s)) || { tags: [] }).tags;
    const sMap = new Map(res.series.map((s) => [F.lineKey(s), s]));
    const items = [];

    // 1. headline: where the scope stands and where it will land
    const dir = T.gap >= 0 ? '超支' : '結餘';
    const certainty = T.pOver >= 0.9 ? '幾乎確定會超支' : T.pOver >= 0.5 ? `較可能超支（機率 ${pc(T.pOver)}）`
      : T.pOver <= 0.1 ? '超支機率很低' : `超支機率 ${pc(T.pOver)}`;
    const headline = `截至 ${year} 年 ${month} 月底，${name}年累計支出 ${amt(T.ytdActual)}，執行率 ${pc(T.utilization, 1)}`
      + `（依預算月份分佈，同期應為 ${pc(T.phased, 1)}）。預測全年 ${amt(T.fyForecast)}，為預算的 ${pc(T.rate, 1)}，`
      + `預計${dir} ${amt(Math.abs(T.gap))}；80% 區間為預算的 ${pc(T.lo / T.fyBudget)}～${pc(T.hi / T.fyBudget)}，${certainty}。`;

    const inScope = (a) => F.inScope(a, f);
    const red = alerts.filter((a) => a.level === '紅燈' && inScope(a));
    const under = alerts.filter((a) => a.type === '黃燈・預計大幅未執行' && inScope(a));
    const smallOver = alerts.filter((a) => a.type !== '黃燈・預計大幅未執行' && a.level === '黃燈' && inScope(a));
    const oneOffs = res.oneOffs.filter(inScope);
    const spikes = F.flagSpikes(P).map((x) => ({ ...P.keys[x.k], ...x })).filter((x) => inScope(x) && x.pattern === '持續偏高');

    // 2. where the overrun comes from (largest first), with the reason the engine found
    red.slice(0, 3).forEach((a) => {
      const s = sMap.get(F.lineKey(a)), tags = tagsOf(a), why = [];
      const one = oneOffs.find((o) => F.lineKey(o) === F.lineKey(a));
      const sp = spikes.filter((x) => F.lineKey(x) === F.lineKey(a)).sort((x, y) => x.month - y.month)[0];
      if (one) why.push(one.oneOff >= a.gap
        ? `超支幾乎全來自 ${one.month} 月一筆約 ${amt(one.oneOff)}的一次性支出；預測已把它當單一事件、不往後外推，其餘月份大致符合預算`
        : `${one.month} 月有一筆約 ${amt(one.oneOff)}的一次性支出（不往後外推），扣除後仍超支約 ${amt(a.gap - one.oneOff)}`);
      if (sp) why.push(`${sp.month} 月起支出持續偏高（當月約為預算的 ${sp.ratio.toFixed(1)} 倍，之後未回落），判定為趨勢改變而非單月異常`);
      if (tags.includes('長期超支')) why.push('過去幾年執行率都高於 100%，問題可能在預算基準偏低');
      if (!why.length && s) why.push(tags.includes('Q4集中消化')
        ? `年累計為同期預算的 ${pc(s.paceIndex)}，但這個項目歷年都在第四季集中支出，依此推估年底會超出預算`
        : `年累計已達同期預算的 ${pc(s.paceIndex)}，照目前速度年底會超出預算`);
      items.push({ tone: 'red', text: `${lineLabel(a)}：預計超支 ${amt(a.gap)}（預算的 ${pc(a.rate)}，超支機率 ${pc(a.pOver)}）。${why.join('；')}。`,
        link: { kind: 'line', dept: a.dept, proj: a.proj, cat: a.cat } });
    });
    if (red.length > 3) items.push({ tone: 'red', text: `另有 ${red.length - 3} 個紅燈項目，合計預計超支 ${amt(red.slice(3).reduce((x, a) => x + a.gap, 0))}，見預警頁。`, link: { kind: 'tab', tab: 'alerts' } });
    if (smallOver.length) {
      const g = smallOver.reduce((x, a) => x + a.gap, 0);
      items.push({ tone: 'amber', text: `${smallOver.length} 個項目可能小幅超支（黃燈），合計約 ${amt(g)}，例如${lineLabel(smallOver[0])}（超支機率 ${pc(smallOver[0].pOver)}）。`, link: { kind: 'tab', tab: 'alerts' } });
    }

    // 3. large under-execution, grouped by department + project: delayed project or genuinely unused budget?
    const groups = new Map();
    for (const a of under) { const k = a.dept + '|' + (a.proj || ''); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
    [...groups.values()].sort((x, y) => x.reduce((t, a) => t + a.gap, 0) - y.reduce((t, a) => t + a.gap, 0)).slice(0, 2).forEach((g) => {
      const lines = g.map((a) => sMap.get(F.lineKey(a))).filter(Boolean);
      const gap = g.reduce((t, a) => t + a.gap, 0), bud = lines.reduce((t, s) => t + s.fyBudget, 0), fc = lines.reduce((t, s) => t + s.fyForecast, 0);
      const commit = lines.reduce((t, s) => t + s.commitRemaining, 0), why = [];
      if (commit > 0) why.push(`但已簽約未付款 ${amt(commit)}，較像專案時程延後，不宜直接釋出`);
      if (g.some((a) => tagsOf(a).includes('長期未用完'))) why.push('歷年都未用完，可考慮下修明年預算');
      if (!why.length) why.push('需確認是需求減少還是專案延後');
      const head = [!f.dept ? g[0].dept : '', g[0].proj && f.proj == null ? g[0].proj : ''].filter(Boolean).join('・');
      const cats = g.map((a) => a.cat).join('、');
      items.push({ tone: 'amber', text: `${head ? head + '的' : ''}${cats}：預測只用到預算的 ${pc(fc / bud)}，預計結餘 ${amt(-gap)}；${why.join('，')}。`,
        link: { kind: 'line', dept: g[0].dept, proj: g[0].proj, cat: g.length === 1 ? g[0].cat : '' } });
    });

    // 4. totals that hide a red unit (department green, project red)
    if (f.proj == null) {
      const level = !f.dept ? 'dept' : 'proj';
      const units = F.aggregate(members, level, risk);
      for (const u of units) {
        if (!u.risk.startsWith('綠')) continue;
        const inner = F.aggregate(u.members, level === 'dept' ? 'proj' : 'series', risk).filter((x) => x.risk.startsWith('紅'));
        if (!inner.length || (level === 'dept' && inner.every((x) => !x.proj))) continue;
        const nm = level === 'dept' ? u.dept : (u.proj || '未分專案');
        const who = inner.slice(0, 2).map((x) => (level === 'dept' ? x.proj : x.cat)).join('、');
        items.push({ tone: 'info', text: `${nm}合計為綠燈（預算的 ${pc(u.rate)}），但其中${who}為紅燈；${level === 'dept' ? '其他專案' : '其他科目'}的結餘抵銷了超支，只看合計會漏掉。`,
          link: level === 'dept' ? { kind: 'scope', dept: u.dept, proj: null } : { kind: 'scope', dept: u.dept, proj: u.proj } });
      }
    }

    // 5. seasonal lag that is not a risk
    const seasonal = alerts.filter((a) => a.type === '執行落後但屬季節性' && inScope(a));
    if (seasonal.length) items.push({ tone: 'ok', text: `${seasonal.map(lineLabel).slice(0, 2).join('、')}年累計落後，但歷史上 Q4 會集中支出，預測全年仍接近預算，不列為風險。`,
      link: { kind: 'line', dept: seasonal[0].dept, proj: seasonal[0].proj, cat: seasonal[0].cat } });

    // 6. can it be funded internally?
    if (realloc && realloc.summary.totalNeed > 0 && !f.dept) {
      const sm = realloc.summary, left = sm.totalNeed - sm.covered;
      items.push({ tone: left > 1e6 ? 'amber' : 'ok', text: `預計超支缺口合計 ${amt(sm.totalNeed)}，依建議做 ${realloc.moves.length} 筆內部調配（${amt(sm.used)}）可補足 ${pc(sm.covered / sm.totalNeed, left > 1e4 ? 1 : 0)}`
        + `${left > 1e4 ? `，剩下 ${amt(left)}需追加預算` : '，不需追加預算'}；調出項目以不影響其 80% 區間上限為原則。`, link: { kind: 'tab', tab: 'realloc' } });
    }
    if (!items.length) items.push({ tone: 'ok', text: '這個範圍沒有紅燈或黃燈項目，預測全年都在預算範圍內。', link: null });

    const text = [headline, ...items.map((x) => '・' + x.text)].join('\n');
    return { headline, items, text };
  }

  const api = { build, amt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FPASummary = api;
})(typeof window !== 'undefined' ? window : globalThis);
