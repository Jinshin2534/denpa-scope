// Wi-Fi の数値まわりの純粋関数。DOM にも Node にも依存しない。

export const BANDS = {
  '2.4': { label: '2.4 GHz', min: 2400, max: 2495 },
  '5': { label: '5 GHz', min: 5150, max: 5895 },
  '6': { label: '6 GHz', min: 5925, max: 7125 },
};

// CoreWLAN の CWChannelBand の生値 → バンド名
export function bandFromRaw(raw) {
  return { 1: '2.4', 2: '5', 3: '6' }[raw] ?? null;
}

// CoreWLAN の CWChannelWidth の生値 → MHz
export function widthFromRaw(raw) {
  return { 1: 20, 2: 40, 3: 80, 4: 160 }[raw] ?? 20;
}

// CoreWLAN の CWPHYMode の生値 → 規格名
export function phyModeName(raw) {
  return { 1: '802.11a', 2: '802.11b', 3: '802.11g', 4: 'Wi-Fi 4 (n)', 5: 'Wi-Fi 5 (ac)', 6: 'Wi-Fi 6 (ax)', 7: 'Wi-Fi 7 (be)' }[raw] ?? '不明';
}

// チャンネル番号の中心周波数 (MHz)
export function channelToFreq(ch, band) {
  if (band === '2.4') return ch === 14 ? 2484 : 2407 + 5 * ch;
  if (band === '5') return 5000 + 5 * ch;
  if (band === '6') return 5950 + 5 * ch;
  return null;
}

// 主チャンネルと帯域幅から、束ねたチャンネル全体の中心チャンネルを求める。
// 5/6 GHz は束ね方が規格で決まっている。2.4 GHz の 40 MHz は上下どちらに伸ばすか
// 取得できないので、端に寄らない側（7 以下なら上、それ以外は下）と仮定する。
export function centerChannel(primary, widthMHz, band) {
  if (widthMHz <= 20) return primary;
  if (band === '2.4') return primary <= 7 ? primary + 2 : primary - 2;
  const n = widthMHz / 20; // 束ねる 20 MHz チャンネルの数
  if (band === '6') {
    const idx = Math.floor((primary - 1) / 4);
    const first = 1 + Math.floor(idx / n) * n * 4;
    return first + (n - 1) * 2;
  }
  if (band === '5') {
    const groups = {
      40: [36, 44, 52, 60, 100, 108, 116, 124, 132, 140, 149, 157, 165, 173],
      80: [36, 52, 100, 116, 132, 149, 165],
      160: [36, 100, 149],
    }[widthMHz];
    if (!groups) return primary;
    let first = groups[0];
    for (const g of groups) if (g <= primary) first = g;
    return first + (n - 1) * 2;
  }
  return primary;
}

// 信号の占有範囲 [下端, 上端] (MHz)
export function occupiedRange(primary, widthMHz, band) {
  const c = channelToFreq(centerChannel(primary, widthMHz, band), band);
  if (c == null) return null;
  const w = band === '2.4' && widthMHz === 20 ? 22 : widthMHz; // 2.4 GHz の 20 MHz は実際には約 22 MHz 広がる
  return [c - w / 2, c + w / 2];
}

// RSSI の言葉による目安
export function rssiLabel(rssi) {
  if (rssi >= -50) return 'とても強い';
  if (rssi >= -60) return '強い';
  if (rssi >= -70) return 'ふつう';
  if (rssi >= -80) return '弱い';
  return 'とても弱い';
}

// SNR の目安
export function snrLabel(snr) {
  if (snr >= 40) return '非常に良い';
  if (snr >= 25) return '良い';
  if (snr >= 15) return '不安定になりやすい';
  return '通信が厳しい';
}

// dBm → mW（受信電力の実量）
export function dbmToMilliwatt(dbm) {
  return Math.pow(10, dbm / 10);
}

// mW を読みやすい単位つき文字列に
export function formatPower(mw) {
  const units = [['mW', 1], ['µW', 1e-3], ['nW', 1e-6], ['pW', 1e-9], ['fW', 1e-12]];
  for (const [u, s] of units) {
    if (mw >= s) return `${(mw / s).toPrecision(3)} ${u}`;
  }
  return `${(mw / 1e-15).toPrecision(3)} aW`;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
