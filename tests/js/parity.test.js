// Run: node tests/js/parity.test.js   (after python scripts/export_sample.py)
// The browser engine must reproduce the Python modules on the sample data.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..', '..');
const FPA = require(path.join(root, 'docs/js/engine.js'));
const D = require(path.join(root, 'docs/js/data.js'));
const exp = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/expected.json'), 'utf8'));
const csv = (f) => fs.readFileSync(path.join(root, 'docs/sample', f), 'utf8');

const b = D.parseBudget(csv('budget.csv')), c = D.parseCommitments(csv('commitments.csv'));
assert.strictEqual(b.issues.length, 0, b.issues.join(';'));
const [yr, mo] = exp.as_of.split('-').map(Number);
const info = D.inspect(b.rows);
assert.strictEqual(info.lastClosed, mo, 'as-of detection');

const res = FPA.forecast(b.rows, c.rows, yr, mo);
let checked = 0;
const close = (a, e, tol, what) => assert.ok(Math.abs(a - e) <= tol * Math.max(1, Math.abs(e)), `${what}: js ${a} vs py ${e}`);

const L = (x) => x.dept + '|' + x.proj + '|' + x.cat;
assert.ok(res.series.every((s) => s.proj), 'every sample line has a project');
for (const s of res.series) {
  const e = exp.series[L(s)];
  assert.ok(e, 'missing ' + L(s));
  close(s.fyForecast, e.fy_forecast, 1e-9, 'fy_forecast ' + s.dept + s.cat);
  close(s.sd, e.sd, 1e-9, 'sd');
  close(s.pOver, e.p_over, 1e-5, 'p_over');
  close(s.lo, e.lo, 1e-9, 'lo'); close(s.hi, e.hi, 1e-9, 'hi');
  assert.strictEqual(s.risk, e.risk, 'risk ' + s.dept + s.cat);
  assert.strictEqual(s.commitBinding, e.commit_binding, 'commit binding');
  checked++;
}
assert.strictEqual(checked, Object.keys(exp.series).length);

for (const g of FPA.aggregate(res.series, 'dept')) {
  const e = exp.dept[g.dept];
  close(g.fyForecast, e.fy_forecast, 1e-9, 'dept fc'); close(g.sd, e.sd, 1e-9, 'dept sd'); assert.strictEqual(g.risk, e.risk, 'dept risk ' + g.dept);
}
const projAgg = FPA.aggregate(res.series, 'proj');
assert.strictEqual(projAgg.length, Object.keys(exp.proj).length, 'project count');
for (const g of projAgg) {
  const e = exp.proj[g.dept + '|' + g.proj];
  assert.ok(e, 'missing project ' + g.dept + g.proj);
  close(g.fyForecast, e.fy_forecast, 1e-9, 'proj fc'); close(g.sd, e.sd, 1e-9, 'proj sd'); close(g.pOver, e.p_over, 1e-5, 'proj p');
  assert.strictEqual(g.risk, e.risk, 'proj risk ' + g.name);
}
assert.deepStrictEqual(res.oneOffs.map((o) => [o.dept, o.proj, o.cat, o.month]), exp.one_offs.map((o) => [o.dept, o.proj, o.cat, Number(o.period.slice(-2))]));
close(res.oneOffs[0].oneOff, exp.one_offs[0].one_off_amount, 1e-9, 'one-off amount');

const P = res.panel;
for (const w of ['month', 'ytd']) {
  for (const v of FPA.variance(P, 'dept', w)) {
    const e = exp.variance[w][v.dept];
    close(v.variance, e.variance, 1e-9, 'variance'); assert.strictEqual(v.material, e.material, 'material ' + w + v.dept);
  }
}
for (const u of FPA.utilization(P, 'dept')) {
  const e = exp.utilization[u.dept];
  close(u.pace, e.pace, 1e-9, 'pace'); assert.strictEqual(u.status, e.status, 'status'); close(u.requiredRun, e.required, 1e-9, 'required run rate');
}
for (const h of FPA.history(P, 'series')) {
  const e = exp.history[L(h)];
  close(h.mean, e.mean, 1e-9, 'hist mean');
  assert.strictEqual(h.tags.length ? h.tags.join('、') : '穩定', e.tags, 'tags ' + L(h));
}
for (const h of FPA.history(P, 'dept_cat')) {
  const e = exp.history_dept_cat[h.dept + '|' + h.cat];
  close(h.mean, e.mean, 1e-9, 'hist mean dept_cat');
  assert.strictEqual(h.tags.length ? h.tags.join('、') : '穩定', e.tags, 'tags ' + h.dept + h.cat);
}
const sp = FPA.flagSpikes(P).map((s) => [L(P.keys[s.k]), s.month, s.pattern]).sort().join('/');
assert.strictEqual(sp, exp.spikes.map((s) => [L(s), Number(s.period.slice(-2)), s.pattern]).sort().join('/'), 'spikes');

// reallocation sanity: transfers never exceed what a donor can give or a receiver needs
const hist = FPA.history(P, 'series');
const ra = FPA.reallocate(res, hist, {});
assert.ok(ra.moves.length > 0, 'expected some transfers on sample data');
const given = new Map(), got = new Map();
for (const mv of ra.moves) {
  given.set(mv.from, (given.get(mv.from) || 0) + mv.amount);
  got.set(mv.to, (got.get(mv.to) || 0) + mv.amount);
}
for (const d of ra.donors) assert.ok((given.get(FPA.lineName(d.s)) || 0) <= d.cap + 1, 'donor over-given');
for (const r of ra.receivers) assert.ok((got.get(FPA.lineName(r.s)) || 0) <= r.need + 1, 'receiver over-filled');
// within-department transfers are tried before going to another department
const first = new Map();
for (const mv of ra.moves) if (!first.has(mv.to)) first.set(mv.to, mv);
assert.ok(ra.moves.some((mv) => mv.inDept), 'expected at least one within-department transfer');
const after = FPA.applyMoves(res.series, ra.moves);
close(after.reduce((a, x) => a + x.after, 0), after.reduce((a, x) => a + x.before, 0), 1e-9, 'transfers conserve total budget');

// a file without the project column still works and gives the same department totals
const noProj = b.rows.map((r) => Object.assign({}, r, { proj: '' }));
const cNoProj = c.rows.map((r) => Object.assign({}, r, { proj: '' }));
const flat = FPA.forecast(noProj, cNoProj, yr, mo);
assert.ok(flat.series.length < res.series.length && flat.series.every((s) => s.proj === ''), 'flat series');
const dTot = (r) => FPA.aggregate(r.series, 'total')[0];
close(dTot(flat).fyBudget, dTot(res).fyBudget, 1e-12, 'flat budget');
close(dTot(flat).ytdActual, dTot(res).ytdActual, 1e-12, 'flat ytd');
// a commitment without a project is spread over that department's projects in the category
const spread = FPA.forecast(b.rows, cNoProj, yr, mo);
close(spread.series.reduce((a, s) => a + s.commitRemaining, 0), res.series.reduce((a, s) => a + s.commitRemaining, 0), 1e-9, 'commitments spread');

// an as-of month before the data ends must ignore later actuals
const early = FPA.forecast(b.rows, [], 2025, 6);
const tampered = b.rows.map((r) => (r.year === 2025 && r.month > 6 && r.actual !== null ? Object.assign({}, r, { actual: r.actual * 3 }) : r));
const early2 = FPA.forecast(tampered, [], 2025, 6);
close(early.series.reduce((a, s) => a + s.fyForecast, 0), early2.series.reduce((a, s) => a + s.fyForecast, 0), 1e-12, 'no look-ahead');

console.log(`OK  ${checked} budget lines, ${projAgg.length} projects, parity with Python within tolerance; ${ra.moves.length} transfer suggestions (${ra.moves.filter((m) => m.inDept).length} within a department)`);
