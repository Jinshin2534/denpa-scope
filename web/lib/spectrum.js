// スペクトラム表示用の図形。1 つの電波を「台形の山」として描く。
// 返すのは周波数(MHz)と dBm の点列で、画面座標への変換は描画側が行う。

import { occupiedRange } from './wifi.js';

export const FLOOR_DBM = -100;

export function humpPoints(net, { floor = FLOOR_DBM, steps = 24 } = {}) {
  const range = occupiedRange(net.channel, net.width, net.band);
  if (!range) return [];
  const [lo, hi] = range;
  const span = hi - lo;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const x = i / steps;
    // 端が丸い山: 中央の 70% はほぼ平ら、両端は cos で落ちる
    const edge = 0.15;
    let k;
    if (x < edge) k = 0.5 - 0.5 * Math.cos((x / edge) * Math.PI);
    else if (x > 1 - edge) k = 0.5 - 0.5 * Math.cos(((1 - x) / edge) * Math.PI);
    else k = 1;
    pts.push({ f: lo + span * x, dbm: floor + (net.rssi - floor) * k });
  }
  return pts;
}

// あるバンドに属するネットワークを強い順に
export function networksInBand(nets, band) {
  return nets.filter((n) => n.band === band).sort((a, b) => b.rssi - a.rssi);
}

// チャンネルごとの混み具合: 同じ周波数に重なる他の電波の数と、その中で最も強いもの
export function congestion(nets, target) {
  const r = occupiedRange(target.channel, target.width, target.band);
  if (!r) return { overlaps: 0, strongest: null };
  let overlaps = 0, strongest = null;
  for (const n of nets) {
    if (n === target || n.band !== target.band) continue;
    const o = occupiedRange(n.channel, n.width, n.band);
    if (o && o[0] < r[1] && o[1] > r[0]) {
      overlaps++;
      if (strongest == null || n.rssi > strongest) strongest = n.rssi;
    }
  }
  return { overlaps, strongest };
}
