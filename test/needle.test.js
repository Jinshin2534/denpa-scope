import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNeedle, stepNeedle } from '../web/lib/needle.js';

test('針は目標値に落ち着く', () => {
  let n = createNeedle(-100);
  for (let i = 0; i < 300; i++) n = stepNeedle(n, -60, 1 / 60);
  assert.ok(Math.abs(n.value + 60) < 0.01);
});

test('針は少し行き過ぎる（アナログらしさ）が、暴れない', () => {
  let n = createNeedle(-100);
  let peak = -100;
  for (let i = 0; i < 300; i++) {
    n = stepNeedle(n, -60, 1 / 60);
    peak = Math.max(peak, n.value);
  }
  assert.ok(peak > -60, '行き過ぎがある');
  assert.ok(peak < -55, '行き過ぎは 5 dB 未満');
});

test('長いコマ落ちでも発散しない', () => {
  let n = createNeedle(-100);
  n = stepNeedle(n, -40, 10);
  assert.ok(Number.isFinite(n.value));
  assert.ok(n.value > -100 && n.value < -20);
});
