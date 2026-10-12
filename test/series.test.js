import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeries, pushSample, windowOf, stats, toCsv } from '../web/lib/series.js';

test('古いサンプルは maxAge を過ぎると消える', () => {
  const s = createSeries(1000);
  for (let t = 0; t <= 3000; t += 100) pushSample(s, { t, v: t });
  assert.equal(s.items[0].t, 2000);
  assert.equal(s.items.at(-1).t, 3000);
});

test('時刻が巻き戻ったサンプルは捨てる', () => {
  const s = createSeries(1000);
  pushSample(s, { t: 500 });
  pushSample(s, { t: 400 });
  assert.equal(s.items.length, 1);
});

test('windowOf は両端を含む', () => {
  const s = createSeries(10000);
  for (let t = 0; t <= 1000; t += 100) pushSample(s, { t });
  assert.equal(windowOf(s, 200, 500).length, 4);
});

test('統計', () => {
  const r = stats([-70, -60, -80, NaN]);
  assert.equal(r.min, -80);
  assert.equal(r.max, -60);
  assert.equal(r.mean, -70);
  assert.ok(Math.abs(r.std - Math.sqrt(200 / 3)) < 1e-9);
  assert.equal(stats([]), null);
});

test('CSV', () => {
  const csv = toCsv([{ t: 1, a: -70 }, { t: 2, a: null }], [{ label: 't', get: (s) => s.t }, { label: 'a', get: (s) => s.a }]);
  assert.equal(csv, 't,a\n1,-70\n2,');
});
