import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelToFreq, centerChannel, occupiedRange, bandFromRaw, widthFromRaw, rssiLabel, dbmToMilliwatt, formatPower, phyModeName } from '../web/lib/wifi.js';

test('チャンネル→中心周波数', () => {
  assert.equal(channelToFreq(1, '2.4'), 2412);
  assert.equal(channelToFreq(6, '2.4'), 2437);
  assert.equal(channelToFreq(14, '2.4'), 2484);
  assert.equal(channelToFreq(36, '5'), 5180);
  assert.equal(channelToFreq(149, '5'), 5745);
  assert.equal(channelToFreq(1, '6'), 5955);
  assert.equal(channelToFreq(1, 'x'), null);
});

test('5 GHz の束ねチャンネルの中心は規格どおり', () => {
  assert.equal(centerChannel(36, 20, '5'), 36);
  assert.equal(centerChannel(40, 40, '5'), 38);
  assert.equal(centerChannel(64, 40, '5'), 62);
  assert.equal(centerChannel(44, 80, '5'), 42);
  assert.equal(centerChannel(157, 80, '5'), 155);
  assert.equal(centerChannel(112, 80, '5'), 106);
  assert.equal(centerChannel(60, 160, '5'), 50);
  assert.equal(centerChannel(128, 160, '5'), 114);
});

test('6 GHz の束ねチャンネルの中心は規格どおり', () => {
  assert.equal(centerChannel(5, 40, '6'), 3);
  assert.equal(centerChannel(5, 80, '6'), 7);
  assert.equal(centerChannel(37, 160, '6'), 47);
  assert.equal(centerChannel(1, 160, '6'), 15);
});

test('2.4 GHz の 40 MHz は端に寄らない側へ伸ばす', () => {
  assert.equal(centerChannel(1, 40, '2.4'), 3);
  assert.equal(centerChannel(11, 40, '2.4'), 9);
});

test('占有範囲: 2.4 GHz の 20 MHz は 22 MHz 幅', () => {
  assert.deepEqual(occupiedRange(6, 20, '2.4'), [2426, 2448]);
  assert.deepEqual(occupiedRange(36, 80, '5'), [5170, 5250]);
});

test('CoreWLAN の生値の変換', () => {
  assert.equal(bandFromRaw(1), '2.4');
  assert.equal(bandFromRaw(3), '6');
  assert.equal(bandFromRaw(0), null);
  assert.equal(widthFromRaw(3), 80);
  assert.equal(widthFromRaw(0), 20);
  assert.equal(phyModeName(6), 'Wi-Fi 6 (ax)');
});

test('RSSI の目安は境界で切り替わる', () => {
  assert.equal(rssiLabel(-50), 'とても強い');
  assert.equal(rssiLabel(-51), '強い');
  assert.equal(rssiLabel(-70), 'ふつう');
  assert.equal(rssiLabel(-81), 'とても弱い');
});

test('dBm と電力', () => {
  assert.equal(dbmToMilliwatt(0), 1);
  assert.ok(Math.abs(dbmToMilliwatt(-30) - 1e-3) < 1e-15);
  assert.equal(formatPower(dbmToMilliwatt(-30)), '1.00 µW');
  assert.equal(formatPower(dbmToMilliwatt(-70)), '100 pW');
});
