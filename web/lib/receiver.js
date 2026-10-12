// 受信機の内側で何が起きているかを、実測値から見積もる純粋関数。
// 周りの電波を「自分の親機」「順番待ちの相手」「混信」「無関係」に分ける。
// 判定は 802.11 の受信感度の考え方に沿った目安モデル:
//   - 主チャンネルが同じで -82 dBm 以上 → 相手の送信の頭（プリアンブル）が読めるので、送り終わるまで待つ
//   - 主チャンネルが違っても、自分の主チャンネルに -62 dBm 以上のエネルギーが入る → やはり待つ
//   - それ以外で周波数が重なる → 待たずに受信してしまい、雑音として混ざる
import { occupiedRange, channelToFreq } from './wifi.js';

export const CCA_PREAMBLE_DBM = -82;
export const CCA_ENERGY_DBM = -62;
const SAME_AP_DB = 3; // 主チャンネル・幅が同じでこれ以内の強さなら、同じ親機の別 SSID とみなす

// dBm の電力和（mW で足して dBm に戻す）。空なら null
export function sumDbm(list) {
  const vals = list.filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  const mw = vals.reduce((s, v) => s + Math.pow(10, v / 10), 0);
  return 10 * Math.log10(mw);
}

// 区間 a のうち区間 b と重なる長さ
export function overlapMHz(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

// 主チャンネル 20 MHz の範囲
export function primaryRange(channel, band) {
  const c = channelToFreq(channel, band);
  if (c == null) return null;
  const w = band === '2.4' ? 22 : 20;
  return [c - w / 2, c + w / 2];
}

// 相手の電力のうち、ある区間に落ちる分 (dBm)。電力は占有幅に平らに広がると仮定
export function powerWithin(net, range) {
  const r = occupiedRange(net.channel, net.width, net.band);
  const ov = overlapMHz(r, range);
  if (!r || ov <= 0) return null;
  return net.rssi + 10 * Math.log10(ov / (r[1] - r[0]));
}

// 周りの電波を分類する。link は接続中の電波 {rssi, noise, channel, band, width}
export function classifyNeighbors(link, nets) {
  const out = { mine: [], contend: [], interfere: [], unrelated: [] };
  if (!link || link.rssi == null || !link.band) return out;
  const myRange = occupiedRange(link.channel, link.width, link.band);
  const myPrimary = primaryRange(link.channel, link.band);

  // 自分の親機: 同じ主チャンネル・同じ幅で、いまの RSSI にいちばん近いもの
  const same = nets.filter((n) => n.band === link.band && n.channel === link.channel && n.width === link.width);
  let anchor = null;
  for (const n of same) if (!anchor || Math.abs(n.rssi - link.rssi) < Math.abs(anchor.rssi - link.rssi)) anchor = n;

  for (const n of nets) {
    if (n.band !== link.band) { out.unrelated.push(n); continue; }
    if (anchor && same.includes(n) && Math.abs(n.rssi - anchor.rssi) <= SAME_AP_DB) { out.mine.push(n); continue; }
    const inMine = powerWithin(n, myRange);
    if (inMine == null) { out.unrelated.push(n); continue; }
    const inPrimary = powerWithin(n, myPrimary);
    const samePrimary = n.channel === link.channel;
    const heard = (samePrimary && n.rssi >= CCA_PREAMBLE_DBM) || (inPrimary != null && inPrimary >= CCA_ENERGY_DBM);
    if (heard) out.contend.push({ ...n, why: samePrimary ? 'preamble' : 'energy' });
    else out.interfere.push({ ...n, inBand: inMine });
  }
  out.contend.sort((a, b) => b.rssi - a.rssi);
  out.interfere.sort((a, b) => b.inBand - a.inBand);
  return out;
}

// 信号対(雑音+混信)比。混信が無ければ SNR と同じ
export function sinr(rssi, noise, interfDbm) {
  if (rssi == null || noise == null) return null;
  return rssi - sumDbm([noise, interfDbm]);
}

// 全員が送りたがっているときの自分の取り分（最悪の目安）
export function airtimeShare(contenders) {
  return 1 / (1 + contenders);
}

// 受信の内側をまとめて見積もる
export function analyzeReception(link, nets, { extraNoiseDb = 0 } = {}) {
  const groups = classifyNeighbors(link, nets);
  if (!link || link.rssi == null || link.noise == null) return { groups, ok: false };
  const noise = link.noise + extraNoiseDb;
  const interfDbm = sumDbm(groups.interfere.map((n) => n.inBand));
  const snr = link.rssi - noise;
  const s = sinr(link.rssi, noise, interfDbm);
  return {
    ok: true,
    groups,
    signal: link.rssi,
    noise,
    interfDbm,
    snr,
    sinr: s,
    lossDb: snr - s, // 混信で失った分
    share: airtimeShare(groups.contend.length),
  };
}
