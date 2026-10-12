// 変調方式（MCS）と通信速度の表。送信レートから「いま使っている変調」を逆算する。
// 速度は 1 ストリームあたり (Mbps)。n/ac はショート GI、ax/be は 0.8µs GI の規格値。

export const MCS_INFO = [
  { mod: 'BPSK', bits: 1, order: 2, rate: '1/2', snr: 2 },
  { mod: 'QPSK', bits: 2, order: 4, rate: '1/2', snr: 5 },
  { mod: 'QPSK', bits: 2, order: 4, rate: '3/4', snr: 9 },
  { mod: '16-QAM', bits: 4, order: 16, rate: '1/2', snr: 11 },
  { mod: '16-QAM', bits: 4, order: 16, rate: '3/4', snr: 15 },
  { mod: '64-QAM', bits: 6, order: 64, rate: '2/3', snr: 18 },
  { mod: '64-QAM', bits: 6, order: 64, rate: '3/4', snr: 20 },
  { mod: '64-QAM', bits: 6, order: 64, rate: '5/6', snr: 25 },
  { mod: '256-QAM', bits: 8, order: 256, rate: '3/4', snr: 29 },
  { mod: '256-QAM', bits: 8, order: 256, rate: '5/6', snr: 31 },
  { mod: '1024-QAM', bits: 10, order: 1024, rate: '3/4', snr: 34 },
  { mod: '1024-QAM', bits: 10, order: 1024, rate: '5/6', snr: 37 },
  { mod: '4096-QAM', bits: 12, order: 4096, rate: '3/4', snr: 40 },
  { mod: '4096-QAM', bits: 12, order: 4096, rate: '5/6', snr: 42 },
];
// snr は 20 MHz・誤り率 10% 程度で必要な SNR の目安（機種で数 dB 前後する）

const HT = {
  20: [7.2, 14.4, 21.7, 28.9, 43.3, 57.8, 65, 72.2],
  40: [15, 30, 45, 60, 90, 120, 135, 150],
};
const VHT = {
  20: [7.2, 14.4, 21.7, 28.9, 43.3, 57.8, 65, 72.2, 86.7, 96.3],
  40: [15, 30, 45, 60, 90, 120, 135, 150, 180, 200],
  80: [32.5, 65, 97.5, 130, 195, 260, 292.5, 325, 390, 433.3],
};
const HE = {
  20: [8.6, 17.2, 25.8, 34.4, 51.6, 68.8, 77.4, 86, 103.2, 114.7, 129, 143.4, 154.9, 172.1],
  40: [17.2, 34.4, 51.6, 68.8, 103.2, 137.6, 154.9, 172.1, 206.5, 229.4, 258.1, 286.8, 309.7, 344.1],
  80: [36, 72.1, 108.1, 144.1, 216.2, 288.2, 324.3, 360.3, 432.4, 480.4, 540.4, 600.5, 648.5, 720.6],
};

// CWPHYMode の生値と幅から 1 ストリームあたりの速度表を返す
export function rateTable(phy, width) {
  const w = width >= 160 ? 160 : width;
  const pick = (t, maxMcs) => {
    const base = w === 160 ? (t[80] ? t[80].map((v) => +(v * 2).toFixed(1)) : null) : t[w];
    return base ? base.slice(0, maxMcs + 1) : null;
  };
  if (phy === 4) return pick(HT, 7);
  if (phy === 5) return pick(VHT, 9);
  if (phy === 6) return pick(HE, 11);
  if (phy === 7) return pick(HE, 13);
  return null; // a/b/g は対象外
}

// 規格上の速度 (Mbps)
export function phyRate(phy, width, mcs, nss) {
  const t = rateTable(phy, width);
  return t && t[mcs] != null ? +(t[mcs] * nss).toFixed(1) : null;
}

// 送信レートにいちばん近い (MCS, ストリーム数) を探す。
// GI の違い（n/ac のロング GI は約 0.9 倍、ax の 1.6µs GI は約 0.94 倍）も候補に入れる。
export function inferMcs(rate, phy, width) {
  const t = rateTable(phy, width);
  if (!t || !(rate > 0)) return null;
  const giFactors = phy >= 6 ? [1, 0.944, 0.85] : [1, 0.9];
  let best = null;
  for (let nss = 1; nss <= 4; nss++) {
    for (let mcs = 0; mcs < t.length; mcs++) {
      for (const gi of giFactors) {
        const v = t[mcs] * nss * gi;
        const err = Math.abs(v - rate) / rate;
        if (!best || err < best.err - 1e-9) best = { mcs, nss, err, gi };
      }
    }
  }
  return { mcs: best.mcs, nss: best.nss, exact: best.err < 0.03, ...MCS_INFO[best.mcs] };
}

// この SNR で安定して使える最も速い MCS（なければ -1）
export function bestMcsForSnr(snr, phy) {
  const max = { 4: 7, 5: 9, 6: 11, 7: 13 }[phy] ?? 11;
  let m = -1;
  for (let i = 0; i <= max; i++) if (snr >= MCS_INFO[i].snr) m = i;
  return m;
}
