import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumDbm, overlapMHz, powerWithin, classifyNeighbors, sinr, analyzeReception, airtimeShare } from '../web/lib/receiver.js';
import { rateTable, phyRate, inferMcs, bestMcsForSnr } from '../web/lib/mcs.js';
import { rng, axisLevels, simulateSymbols, symbolErrorRate } from '../web/lib/qam.js';
import { createCsma, stepCsma, shares } from '../web/lib/csma.js';

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} は ${b} ±${tol} の範囲外`);

test('dBm の電力和: 同じ強さ 2 つで +3 dB、10 dB 差ならほぼ強い方', () => {
  near(sumDbm([-80, -80]), -76.99, 0.01);
  near(sumDbm([-60, -70]), -59.59, 0.01);
  assert.equal(sumDbm([]), null);
  assert.equal(sumDbm([null, -70]), -70);
});

test('重なり幅と、区間に落ちる電力', () => {
  assert.equal(overlapMHz([0, 10], [5, 20]), 5);
  assert.equal(overlapMHz([0, 10], [10, 20]), 0);
  // 2.4 GHz ch1 と ch3 は 22 MHz のうち 12 MHz 重なる
  const p = powerWithin({ channel: 3, width: 20, band: '2.4', rssi: -60 }, [2401, 2423]);
  near(p, -60 + 10 * Math.log10(12 / 22), 0.01);
  assert.equal(powerWithin({ channel: 11, width: 20, band: '2.4', rssi: -60 }, [2401, 2423]), null);
});

test('周りの電波の分類: 自分 / 順番待ち / 混信 / 無関係', () => {
  const link = { rssi: -55, noise: -92, channel: 44, band: '5', width: 80 };
  const nets = [
    { channel: 44, band: '5', width: 80, rssi: -54 }, // 自分の親機
    { channel: 44, band: '5', width: 80, rssi: -56 }, // 同じ親機の別 SSID
    { channel: 44, band: '5', width: 80, rssi: -75 }, // 同じ主チャンネルの他人 → 待つ
    { channel: 44, band: '5', width: 20, rssi: -88 }, // 弱すぎて頭が読めない → 混信
    { channel: 36, band: '5', width: 80, rssi: -58 }, // 主チャンネルは違うが自分の主chへ -64 dBm → 混信
    { channel: 36, band: '5', width: 20, rssi: -50 }, // 自分の 80MHz の端に入る → 混信
    { channel: 100, band: '5', width: 80, rssi: -60 }, // 重ならない
    { channel: 6, band: '2.4', width: 20, rssi: -40 }, // 別バンド
  ];
  const g = classifyNeighbors(link, nets);
  assert.equal(g.mine.length, 2);
  assert.deepEqual(g.contend.map((n) => n.rssi), [-75]);
  assert.deepEqual(g.interfere.map((n) => n.rssi).sort(), [-50, -58, -88]);
  assert.equal(g.unrelated.length, 2);
});

test('主チャンネルに強いエネルギーが入れば、別の主チャンネルでも待つ', () => {
  const link = { rssi: -55, noise: -92, channel: 44, band: '5', width: 80 };
  const g = classifyNeighbors(link, [{ channel: 36, band: '5', width: 80, rssi: -50 }]); // 主chへ -56 dBm
  assert.equal(g.contend.length, 1);
  assert.equal(g.contend[0].why, 'energy');
});

test('SINR は混信が強いほど下がり、取り分は台数で割れる', () => {
  assert.equal(sinr(-60, -90, null), 30);
  near(sinr(-60, -90, -90), 26.99, 0.01);
  assert.equal(airtimeShare(0), 1);
  assert.equal(airtimeShare(3), 0.25);
  const a = analyzeReception({ rssi: -60, noise: -92, channel: 1, band: '2.4', width: 20 }, [
    { channel: 1, band: '2.4', width: 20, rssi: -60 },
    { channel: 3, band: '2.4', width: 20, rssi: -70 },
  ]);
  assert.ok(a.ok);
  assert.equal(a.snr, 32);
  near(a.sinr, -60 - sumDbm([-92, -70 + 10 * Math.log10(12 / 22)]), 1e-9);
  assert.ok(a.lossDb > 19, `${a.lossDb}`);
  const b = analyzeReception({ rssi: -60, noise: -92, channel: 1, band: '2.4', width: 20 }, [], { extraNoiseDb: 10 });
  assert.equal(b.sinr, 22);
});

test('速度表は規格値どおり', () => {
  assert.equal(phyRate(6, 80, 11, 2), 1201);
  assert.equal(phyRate(5, 80, 9, 2), 866.6);
  assert.equal(phyRate(6, 160, 11, 2), 2402);
  assert.equal(phyRate(4, 40, 7, 2), 300);
  assert.equal(rateTable(3, 20), null);
  assert.equal(rateTable(6, 20).length, 12);
  assert.equal(rateTable(7, 20).length, 14);
});

test('送信レートから変調を逆算する', () => {
  const a = inferMcs(1200, 6, 80);
  assert.deepEqual([a.mcs, a.nss, a.mod, a.exact], [11, 2, '1024-QAM', true]);
  const b = inferMcs(866, 5, 80);
  assert.deepEqual([b.mcs, b.nss, b.mod], [9, 2, '256-QAM']);
  const c = inferMcs(144, 4, 20); // n 20MHz 2 ストリーム MCS7 ショート GI
  assert.deepEqual([c.mcs, c.nss], [7, 2]);
  assert.ok(inferMcs(130, 4, 20).exact); // ロング GI の MCS7 と ショート GI の MCS6 は同じ 130 で区別できない
  assert.equal(inferMcs(0, 6, 80), null);
});

test('SNR で使える最速の MCS', () => {
  assert.equal(bestMcsForSnr(40, 6), 11);
  assert.equal(bestMcsForSnr(40, 5), 9);
  assert.equal(bestMcsForSnr(26, 6), 7);
  assert.equal(bestMcsForSnr(1, 6), -1);
});

test('QAM の点は平均電力 1', () => {
  for (const order of [4, 16, 64, 256, 1024]) {
    const { i } = axisLevels(order);
    let e = 0;
    for (const a of i) for (const b of i) e += a * a + b * b;
    near(e / (i.length * i.length), 1, 1e-9);
  }
});

test('シミュレーションの誤り率は理論値に合う', () => {
  for (const [order, snr] of [[4, 8], [16, 14], [64, 20], [256, 26]]) {
    const { errorRate } = simulateSymbols(order, snr, 40000, rng(order));
    const th = symbolErrorRate(order, snr);
    near(errorRate, th, Math.max(0.004, th * 0.1));
  }
  assert.equal(simulateSymbols(16, 40, 2000, rng(1)).errorRate, 0);
});

test('CSMA/CA: 全員が送りたがると取り分はほぼ等分、衝突も起きる', () => {
  const sim = createCsma(['a', 'b', 'c', 'd'], rng(7));
  for (let i = 0; i < 200000; i++) stepCsma(sim);
  const { byStation, collided } = shares(sim, 200000);
  const v = Object.values(byStation);
  assert.ok(Math.max(...v) - Math.min(...v) < 0.05, v.join());
  near(v.reduce((x, y) => x + y, 0) + collided, 0.9, 0.08); // 残りはバックオフ中の空き
  assert.ok(collided > 0.01 && collided < 0.2, `${collided}`);
  const solo = createCsma(['a'], rng(3));
  for (let i = 0; i < 50000; i++) stepCsma(solo);
  const s = shares(solo, 50000);
  assert.ok(s.byStation.a > 0.7, `${s.byStation.a}`);
  assert.equal(s.collided, 0);
});
