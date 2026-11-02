/*
 * CSV parsing, column mapping and validation for budget / commitment files.
 *
 * Budget file columns (Chinese or English headers):  年度/year, 月份/month, 部門/dept, 費用科目/category,
 *   預算/budget, 實際/actual   (actual left blank for months that are not closed yet)
 * Commitment file columns: 年度, 月份, 部門, 費用科目, 承諾金額/committed_amount
 */
(function (root) {
  'use strict';

  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = [];
      } else cell += c;
    }
    row.push(cell); if (row.some((x) => x !== '')) rows.push(row);
    return rows;
  }

  const ALIASES = {
    year: ['年度', '年', 'year'], month: ['月份', '月', 'month'], dept: ['部門', 'dept', 'department', 'dept_name'],
    cat: ['費用科目', '科目', 'category', 'cat', 'cat_name'], budget: ['預算', 'budget', '預算金額'],
    actual: ['實際', 'actual', '實際金額', '實際支出'], amount: ['承諾金額', 'committed_amount', 'amount', '金額'],
  };

  function mapColumns(header, need) {
    const idx = {}, missing = [];
    for (const f of need) {
      const i = header.findIndex((h) => ALIASES[f].includes(h.trim().toLowerCase()) || ALIASES[f].includes(h.trim()));
      if (i < 0) missing.push(ALIASES[f][0]); else idx[f] = i;
    }
    return { idx, missing };
  }

  const num = (s) => { if (s === undefined || s === null) return null; s = String(s).replace(/[, \s]/g, ''); if (s === '') return null; const v = Number(s); return Number.isFinite(v) ? v : NaN; };

  function parseBudget(text) {
    const t = parseCSV(text), issues = [];
    if (t.length < 2) return { rows: [], issues: ['檔案沒有資料列'] };
    const { idx, missing } = mapColumns(t[0], ['year', 'month', 'dept', 'cat', 'budget', 'actual']);
    if (missing.length) return { rows: [], issues: ['找不到欄位：' + missing.join('、')] };
    const rows = []; let bad = 0;
    for (let i = 1; i < t.length; i++) {
      const r = t[i], year = num(r[idx.year]), month = num(r[idx.month]), budget = num(r[idx.budget]), actual = num(r[idx.actual]);
      const dept = (r[idx.dept] || '').trim(), cat = (r[idx.cat] || '').trim();
      if (!dept || !cat || !Number.isInteger(year) || !(month >= 1 && month <= 12) || budget === null || Number.isNaN(budget) || Number.isNaN(actual)) { bad++; continue; }
      rows.push({ year, month, dept, cat, budget, actual });
    }
    if (bad) issues.push(`${bad} 列格式不正確，已略過（年度、月份、部門、科目、預算必填，金額需為數字）`);
    return { rows, issues };
  }

  function parseCommitments(text) {
    const t = parseCSV(text), issues = [];
    if (t.length < 2) return { rows: [], issues: [] };
    const { idx, missing } = mapColumns(t[0], ['year', 'month', 'dept', 'cat', 'amount']);
    if (missing.length) return { rows: [], issues: ['承諾支出檔找不到欄位：' + missing.join('、')] };
    const rows = [];
    for (let i = 1; i < t.length; i++) {
      const r = t[i], year = num(r[idx.year]), month = num(r[idx.month]), amount = num(r[idx.amount]);
      if (!Number.isInteger(year) || !(month >= 1 && month <= 12) || !(amount > 0)) continue;
      rows.push({ year, month, dept: (r[idx.dept] || '').trim(), cat: (r[idx.cat] || '').trim(), amount });
    }
    return { rows, issues };
  }

  /** Summary + sanity checks of a parsed budget table. */
  function inspect(rows) {
    const issues = [], years = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
    const depts = [...new Set(rows.map((r) => r.dept))], cats = [...new Set(rows.map((r) => r.cat))];
    if (!rows.length) return { years, depts, cats, issues: ['沒有可用資料'], lastYear: null, lastClosed: 0 };
    const lastYear = years[years.length - 1];
    let lastClosed = 0;
    for (const r of rows) if (r.year === lastYear && r.actual !== null && r.month > lastClosed) lastClosed = r.month;
    if (years.length < 2) issues.push('只有一個年度：歷史季節與歷史執行率法無法使用，預測精度會較低。');
    else if (years.length < 3) issues.push('只有兩個年度：加權組合無法用歷史回測調整權重，將採等權重。建議至少三年資料。');
    const seen = new Map();
    for (const r of rows) { const k = [r.year, r.month, r.dept, r.cat].join('|'); seen.set(k, (seen.get(k) || 0) + 1); }
    const dup = [...seen.values()].filter((v) => v > 1).length;
    if (dup) issues.push(`${dup} 組年度×月份×部門×科目重複，系統會加總處理。`);
    if (lastClosed === 0) issues.push('最新年度沒有任何實際數，無法預測。');
    if (lastClosed >= 12) issues.push('最新年度已全部結帳（12 個月），預測功能需選擇較早的截止月份。');
    const prior = rows.filter((r) => r.year < lastYear && r.actual === null).length;
    if (prior) issues.push(`以往年度有 ${prior} 列沒有實際數，歷史分析可能失真。`);
    return { years, depts, cats, issues, lastYear, lastClosed };
  }

  const TEMPLATE = '年度,月份,部門,費用科目,預算,實際\n2025,1,資訊科技部,資訊軟硬體,5000000,4800000\n2026,1,資訊科技部,資訊軟硬體,5200000,5100000\n2026,12,資訊科技部,資訊軟硬體,6000000,\n';
  const COMMIT_TEMPLATE = '年度,月份,部門,費用科目,承諾金額\n2026,11,資訊科技部,資訊軟硬體,3000000\n';

  const api = { parseCSV, parseBudget, parseCommitments, inspect, TEMPLATE, COMMIT_TEMPLATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FPAData = api;
})(typeof window !== 'undefined' ? window : globalThis);
