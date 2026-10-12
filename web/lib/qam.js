// 受信機の復調を、星座図（コンスタレーション）として再現する。
// 送った点に、実測の SINR ぶんのガウス雑音を足して、いちばん近い点として読み取る。

// 再現できる乱数（mulberry32）
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

// 1 軸あたりの点の位置（平均電力 1 に正規化）。BPSK は I 軸だけ
export function axisLevels(order) {
  if (order === 2) return { i: [-1, 1], q: [0] };
  const m = Math.round(Math.sqrt(order));
  const scale = Math.sqrt((2 * (order - 1)) / 3); // 正方 QAM の平均電力
  const lv = Array.from({ length: m }, (_, k) => (2 * k - (m - 1)) / scale);
  return { i: lv, q: lv };
}

function nearestIndex(levels, v) {
  let best = 0;
  for (let k = 1; k < levels.length; k++) if (Math.abs(levels[k] - v) < Math.abs(levels[best] - v)) best = k;
  return best;
}

// n 個の記号を送って受ける。返す点は {x, y, ok}（x,y は受信した位置）
export function simulateSymbols(order, snrDb, n, r) {
  const { i: li, q: lq } = axisLevels(order);
  const sigma = Math.sqrt(1 / (2 * Math.pow(10, snrDb / 10)));
  const pts = [];
  let errors = 0;
  for (let k = 0; k < n; k++) {
    const ti = Math.floor(r() * li.length);
    const tq = Math.floor(r() * lq.length);
    const x = li[ti] + sigma * gauss(r);
    const y = lq[tq] + sigma * gauss(r);
    const ok = nearestIndex(li, x) === ti && nearestIndex(lq, y) === tq;
    if (!ok) errors++;
    pts.push({ x, y, ok });
  }
  return { pts, errorRate: errors / n };
}

// Q 関数（標準正規の上側確率）
export function qfunc(x) {
  // erfc の近似 (Abramowitz-Stegun 7.1.26)
  const z = x / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = y * Math.exp(-z * z);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

// 記号誤り率の理論値
export function symbolErrorRate(order, snrDb) {
  const snr = Math.pow(10, snrDb / 10);
  if (order === 2) return qfunc(Math.sqrt(2 * snr));
  const m = Math.sqrt(order);
  const p = 2 * (1 - 1 / m) * qfunc(Math.sqrt((3 * snr) / (order - 1)));
  return 1 - (1 - p) * (1 - p);
}
