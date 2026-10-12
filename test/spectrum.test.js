import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humpPoints, networksInBand, congestion, FLOOR_DBM } from '../web/lib/spectrum.js';

const net = (channel, width, band, rssi) => ({ channel, width, band, rssi });

test('山は占有範囲の両端で床、中央で RSSI', () => {
  const pts = humpPoints(net(36, 80, '5', -60));
  assert.equal(pts[0].f, 5170);
  assert.equal(pts.at(-1).f, 5250);
  assert.equal(pts[0].dbm, FLOOR_DBM);
  assert.ok(Math.abs(pts.at(-1).dbm - FLOOR_DBM) < 1e-9);
  assert.equal(pts[12].dbm, -60);
  assert.ok(pts.every((p) => p.dbm <= -60 && p.dbm >= FLOOR_DBM));
});

test('バンドで絞り強い順に並べる', () => {
  const list = [net(1, 20, '2.4', -80), net(36, 20, '5', -50), net(6, 20, '2.4', -60)];
  assert.deepEqual(networksInBand(list, '2.4').map((n) => n.rssi), [-60, -80]);
});

test('混み具合: 2.4 GHz の ch1 と ch3 は重なり、ch6 とは重ならない', () => {
  const a = net(1, 20, '2.4', -60);
  const list = [a, net(3, 20, '2.4', -70), net(6, 20, '2.4', -40), net(1, 20, '5', -30)];
  assert.deepEqual(congestion(list, a), { overlaps: 1, strongest: -70 });
});
