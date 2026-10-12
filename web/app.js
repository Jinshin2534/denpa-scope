// 画面の配線: SSE で受けた値をバッファに積み、メーター・波形・スペクトラムを描く。
import { BANDS, bandFromRaw, widthFromRaw, phyModeName, channelToFreq, centerChannel, rssiLabel, snrLabel, dbmToMilliwatt, formatPower, clamp } from './lib/wifi.js';
import { createSeries, pushSample, windowOf, stats, toCsv } from './lib/series.js';
import { createNeedle, stepNeedle } from './lib/needle.js';
import { humpPoints, networksInBand, congestion, FLOOR_DBM } from './lib/spectrum.js';

const DBM_MIN = -100;
const DBM_MAX = -20;
const PEAK_WINDOW_MS = 10_000;

const css = getComputedStyle(document.documentElement);
const C = {
  phosphor: css.getPropertyValue('--phosphor').trim(),
  amber: css.getPropertyValue('--amber').trim(),
  red: css.getPropertyValue('--red').trim(),
  face: css.getPropertyValue('--face').trim(),
  faceInk: css.getPropertyValue('--face-ink').trim(),
  dim: css.getPropertyValue('--dim').trim(),
  ink: css.getPropertyValue('--ink').trim(),
  low: '#6b8cff',
};
const NET_COLORS = ['#74ffa3', '#ffb54a', '#6bc7ff', '#ff7ab8', '#c59bff', '#ffe36b', '#7affea', '#ff9a6b'];

const state = {
  series: createSeries(5 * 60_000 + 5_000),
  link: null,
  nets: [],
  scanAt: null,
  mode: 'starting',
  hold: null, // 一時停止した時刻（ms）。null なら動いている
  timebase: 30,
  band: '5',
  bandAuto: true, // 接続中の帯域にまだ合わせていない
  needle: createNeedle(DBM_MIN),
  spectrumDirty: true,
};

const $ = (id) => document.getElementById(id);

// ---------- データ受信 ----------

function normalizeLink(o) {
  return {
    t: o.t,
    rssi: o.rssi,
    noise: o.noise,
    rate: o.rate,
    channel: o.channel,
    band: bandFromRaw(o.band),
    width: widthFromRaw(o.width),
    phy: o.phy,
    ssid: o.ssid ?? null,
    iface: o.iface,
    power: o.power,
  };
}

function normalizeNet(o) {
  return { ssid: o.ssid ?? null, bssid: o.bssid ?? null, rssi: o.rssi, channel: o.channel, band: bandFromRaw(o.band), width: widthFromRaw(o.width) };
}

export function receive(msg) {
  if (msg.type === 'link') {
    const link = normalizeLink(msg);
    // RSSI 0 は「圏外 / 未接続」を意味する
    const connected = link.power && link.rssi !== 0;
    state.link = connected ? link : { ...link, rssi: null, noise: null };
    pushSample(state.series, { t: link.t, rssi: connected ? link.rssi : null, noise: connected ? link.noise : null, rate: connected ? link.rate : null });
    if (state.bandAuto && link.band) {
      state.bandAuto = false;
      setBand(link.band);
    }
  } else if (msg.type === 'scan') {
    state.nets = msg.nets.map(normalizeNet).filter((n) => n.band && n.channel);
    state.scanAt = msg.t;
    state.spectrumDirty = true;
    renderNetTable();
  } else if (msg.type === 'mode') {
    state.mode = msg.mode;
    renderMode(msg.reason);
  }
}

function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => receive(JSON.parse(e.data));
  es.onerror = () => {
    state.mode = 'error';
    renderMode('サーバーとの接続が切れました（再接続を試みています）');
  };
}

// ---------- キャンバス ----------

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const h = canvas.clientHeight || 240;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// ---------- アナログメーター ----------

const ARC_START = Math.PI * 7 / 6;
const ARC_SPAN = Math.PI * 4 / 6;
const angleOf = (dbm) => ARC_START + ((clamp(dbm, DBM_MIN - 3, DBM_MAX + 3) - DBM_MIN) / (DBM_MAX - DBM_MIN)) * ARC_SPAN;

function drawMeter(now) {
  const { ctx, w, h } = fit($('meter'));
  ctx.clearRect(0, 0, w, h);
  const r = Math.min(w * 0.44, h * 0.8);
  const cx = w / 2;
  const cy = h * 0.5 + r * 0.42;

  // 文字盤
  const faceGrad = ctx.createLinearGradient(0, cy - r, 0, cy + r * 0.3);
  faceGrad.addColorStop(0, '#f6f0e0');
  faceGrad.addColorStop(1, '#ded4bb');
  ctx.fillStyle = faceGrad;
  roundRect(ctx, cx - r * 1.08, cy - r * 1.08, r * 2.16, r * 1.38, 12);
  ctx.fill();

  // 色帯
  const bandR = r * 0.86;
  const zones = [[DBM_MIN, -80, C.red], [-80, -70, C.amber], [-70, DBM_MAX, '#3fb36b']];
  ctx.lineWidth = r * 0.05;
  for (const [a, b, col] of zones) {
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.arc(cx, cy, bandR, angleOf(a), angleOf(b));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 目盛り
  ctx.strokeStyle = C.faceInk;
  ctx.fillStyle = C.faceInk;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.max(10, r * 0.075)}px ui-monospace, "SF Mono", Menlo, monospace`;
  for (let v = DBM_MIN; v <= DBM_MAX; v += 2) {
    const a = angleOf(v);
    const major = v % 10 === 0;
    const r1 = r * 0.92;
    const r2 = major ? r * 1.02 : r * 0.97;
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    ctx.stroke();
    if (major) ctx.fillText(String(v), cx + Math.cos(a) * r * 0.74, cy + Math.sin(a) * r * 0.74);
  }
  ctx.font = `700 ${Math.max(11, r * 0.09)}px -apple-system, "Hiragino Sans", sans-serif`;
  ctx.fillText('dBm', cx, cy - r * 0.42);
  ctx.font = `${Math.max(10, r * 0.06)}px -apple-system, "Hiragino Sans", sans-serif`;
  ctx.fillStyle = '#6b6352';
  ctx.fillText('弱い', cx + Math.cos(ARC_START) * r * 0.55, cy + Math.sin(ARC_START) * r * 0.55 + r * 0.12);
  ctx.fillText('強い', cx + Math.cos(ARC_START + ARC_SPAN) * r * 0.55, cy + Math.sin(ARC_START + ARC_SPAN) * r * 0.55 + r * 0.12);

  // 直近の最大・最小マーカー
  const recent = stats(windowOf(state.series, now - PEAK_WINDOW_MS, now).map((s) => s.rssi));
  if (recent) {
    marker(ctx, cx, cy, r, recent.max, C.red);
    marker(ctx, cx, cy, r, recent.min, C.low);
  }

  // 針
  const a = angleOf(state.needle.value);
  const tipX = cx + Math.cos(a) * r * 0.98;
  const tipY = cy + Math.sin(a) * r * 0.98;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 3;
  ctx.strokeStyle = '#c22d1f';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(a) * r * 0.12, cy - Math.sin(a) * r * 0.12);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.restore();

  // 軸カバー（文字盤の下端で針の根元を隠す）
  ctx.fillStyle = '#1d211f';
  roundRect(ctx, cx - r * 1.08, cy - r * 0.02, r * 2.16, r * 0.32, { tl: 0, tr: 0, br: 12, bl: 12 });
  ctx.fill();
  ctx.fillStyle = '#3a403c';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.07, Math.PI, 0);
  ctx.fill();

  // 数値
  const rssi = state.link?.rssi;
  ctx.fillStyle = rssi == null ? C.dim : C.phosphor;
  ctx.font = `600 ${Math.max(14, r * 0.14)}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.fillText(rssi == null ? '---' : `${rssi} dBm`, cx, cy + r * 0.16);

  // ガラスの映り込み
  const glare = ctx.createLinearGradient(0, cy - r * 1.08, 0, cy - r * 0.3);
  glare.addColorStop(0, 'rgba(255,255,255,0.35)');
  glare.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glare;
  roundRect(ctx, cx - r * 1.06, cy - r * 1.06, r * 2.12, r * 0.6, 10);
  ctx.fill();
}

function marker(ctx, cx, cy, r, dbm, color) {
  const a = angleOf(dbm);
  const rr = r * 1.06;
  const x = cx + Math.cos(a) * rr;
  const y = cy + Math.sin(a) * rr;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a + Math.PI / 2);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 6);
  ctx.lineTo(-5, -3);
  ctx.lineTo(5, -3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rad = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : r;
  ctx.beginPath();
  ctx.moveTo(x + rad.tl, y);
  ctx.lineTo(x + w - rad.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad.tr);
  ctx.lineTo(x + w, y + h - rad.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad.br, y + h);
  ctx.lineTo(x + rad.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad.bl);
  ctx.lineTo(x, y + rad.tl);
  ctx.quadraticCurveTo(x, y, x + rad.tl, y);
  ctx.closePath();
}

// ---------- 波形（オシロスコープ） ----------

function drawScope(now) {
  const { ctx, w, h } = fit($('scope'));
  ctx.fillStyle = '#07100b';
  ctx.fillRect(0, 0, w, h);
  const L = 44, R = 12, T = 10, B = 24;
  const pw = w - L - R, ph = h - T - B;
  const span = state.timebase * 1000;
  const from = now - span;
  const xOf = (t) => L + ((t - from) / span) * pw;
  const yOf = (dbm) => T + (1 - (clamp(dbm, DBM_MIN, DBM_MAX) - DBM_MIN) / (DBM_MAX - DBM_MIN)) * ph;

  // 方眼（オシロの 10 目盛り）
  ctx.strokeStyle = 'rgba(116,255,163,0.09)';
  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
  ctx.fillStyle = C.dim;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = DBM_MIN; v <= DBM_MAX; v += 10) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(L + pw, y);
    ctx.stroke();
    ctx.fillText(String(v), L - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 10; i++) {
    const x = Math.round(L + (pw * i) / 10) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, T);
    ctx.lineTo(x, T + ph);
    ctx.stroke();
    if (i % 2 === 0) {
      const sec = -state.timebase + (state.timebase * i) / 10;
      ctx.fillText(i === 10 ? (state.hold ? '停止' : '今') : `${Math.round(sec)}s`, x, T + ph + 6);
    }
  }

  const pts = windowOf(state.series, from - 200, now);
  ctx.save();
  ctx.beginPath();
  ctx.rect(L, T, pw, ph);
  ctx.clip();

  // SNR の帯（RSSI とノイズのあいだ）
  ctx.fillStyle = 'rgba(116,255,163,0.10)';
  for (const run of runs(pts, (s) => s.rssi != null && s.noise != null)) {
    ctx.beginPath();
    run.forEach((s, i) => (i ? ctx.lineTo(xOf(s.t), yOf(s.rssi)) : ctx.moveTo(xOf(s.t), yOf(s.rssi))));
    for (let i = run.length - 1; i >= 0; i--) ctx.lineTo(xOf(run[i].t), yOf(run[i].noise));
    ctx.closePath();
    ctx.fill();
  }

  trace(ctx, pts, 'noise', xOf, yOf, C.amber, 1.5, 0);
  trace(ctx, pts, 'rssi', xOf, yOf, C.phosphor, 2, 10);
  ctx.restore();

  // 最新値の札
  const last = [...pts].reverse().find((s) => s.rssi != null);
  if (last) {
    tag(ctx, L + pw, yOf(last.rssi), `${last.rssi}`, C.phosphor);
    if (last.noise != null) tag(ctx, L + pw, yOf(last.noise), `${last.noise}`, C.amber);
  }
}

// null の箇所で線を切る
function runs(pts, ok) {
  const out = [];
  let cur = [];
  for (const s of pts) {
    if (ok(s)) cur.push(s);
    else if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

function trace(ctx, pts, key, xOf, yOf, color, width, glow) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  if (glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = glow;
  }
  for (const run of runs(pts, (s) => s[key] != null)) {
    ctx.beginPath();
    run.forEach((s, i) => (i ? ctx.lineTo(xOf(s.t), yOf(s[key])) : ctx.moveTo(xOf(s.t), yOf(s[key]))));
    ctx.stroke();
  }
  ctx.restore();
}

function tag(ctx, x, y, text, color) {
  ctx.font = '600 11px ui-monospace, "SF Mono", Menlo, monospace';
  const tw = ctx.measureText(text).width + 8;
  ctx.fillStyle = color;
  roundRect(ctx, x - tw - 2, y - 8, tw, 16, 3);
  ctx.fill();
  ctx.fillStyle = '#07100b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x - tw / 2 - 2, y + 0.5);
}

// ---------- スペクトラム ----------

const BAND_LABEL_CHANNELS = {
  '2.4': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  '5': [36, 44, 52, 60, 100, 108, 116, 124, 132, 140, 149, 157, 165],
  '6': [1, 33, 65, 97, 129, 161, 193, 225],
};

// 同じ帯域・チャンネル・幅のものをまとめる（同じ親機が複数の BSSID を出していることが多い）
export function groupNets(nets) {
  const map = new Map();
  for (const n of nets) {
    const key = `${n.band}/${n.channel}/${n.width}`;
    const g = map.get(key);
    if (!g) map.set(key, { ...n, count: 1, ssids: n.ssid ? [n.ssid] : [] });
    else {
      g.count++;
      if (n.rssi > g.rssi) g.rssi = n.rssi;
      if (n.ssid && !g.ssids.includes(n.ssid)) g.ssids.push(n.ssid);
    }
  }
  return [...map.values()];
}

function isMine(g) {
  const l = state.link;
  return l && l.rssi != null && g.band === l.band && g.channel === l.channel;
}

function drawSpectrum() {
  const { ctx, w, h } = fit($('spectrum'));
  ctx.fillStyle = '#07100b';
  ctx.fillRect(0, 0, w, h);
  const band = BANDS[state.band];
  const L = 44, R = 12, T = 12, B = 26;
  const pw = w - L - R, ph = h - T - B;
  const xOf = (f) => L + ((f - band.min) / (band.max - band.min)) * pw;
  const yOf = (dbm) => T + (1 - (clamp(dbm, DBM_MIN, DBM_MAX) - DBM_MIN) / (DBM_MAX - DBM_MIN)) * ph;

  ctx.strokeStyle = 'rgba(116,255,163,0.09)';
  ctx.fillStyle = C.dim;
  ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = DBM_MIN; v <= DBM_MAX; v += 10) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(L + pw, y);
    ctx.stroke();
    ctx.fillText(String(v), L - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const ch of BAND_LABEL_CHANNELS[state.band]) {
    const x = Math.round(xOf(channelToFreq(ch, state.band))) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, T);
    ctx.lineTo(x, T + ph);
    ctx.stroke();
    ctx.fillText(String(ch), x, T + ph + 6);
  }

  const groups = networksInBand(groupNets(state.nets), state.band).reverse(); // 弱いものから描いて強いものを手前に
  ctx.save();
  ctx.beginPath();
  ctx.rect(L, T, pw, ph);
  ctx.clip();
  const labels = [];
  // 強い山のラベルを先に置き、ぶつかるものは上へずらす
  const placed = [];
  groups.forEach((g) => {
    const pts = humpPoints(g, { floor: FLOOR_DBM });
    if (!pts.length) return;
    const color = netColor(g);
    const mine = isMine(g);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(xOf(p.f), yOf(p.dbm)) : ctx.moveTo(xOf(p.f), yOf(p.dbm))));
    ctx.fillStyle = hexAlpha(color, mine ? 0.28 : 0.14);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = mine ? 2.5 : 1.5;
    ctx.stroke();
    const mid = pts[Math.floor(pts.length / 2)];
    labels.push({ text: `${netName(g)}${mine ? '（接続中）' : ''}`, x: xOf(mid.f), y: yOf(mid.dbm) - 3, color, mine });
  });
  ctx.textBaseline = 'bottom';
  for (const lb of labels.reverse()) {
    ctx.font = `${lb.mine ? 700 : 500} 11px -apple-system, "Hiragino Sans", sans-serif`;
    const half = ctx.measureText(lb.text).width / 2 + 2;
    let y = lb.y;
    const hits = (yy) => placed.some((p) => lb.x - half < p.x2 && lb.x + half > p.x1 && yy - 13 < p.y2 && yy > p.y1);
    for (let i = 0; i < 6 && hits(y); i++) y -= 13;
    placed.push({ x1: lb.x - half, x2: lb.x + half, y1: y - 13, y2: y });
    ctx.fillStyle = lb.color;
    ctx.fillText(lb.text, lb.x, y);
  }
  ctx.restore();

  if (!groups.length) {
    ctx.fillStyle = C.dim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '13px -apple-system, "Hiragino Sans", sans-serif';
    ctx.fillText(state.scanAt ? 'この帯域には電波が見つかりませんでした' : 'スキャン中…（初回は数秒かかります）', L + pw / 2, T + ph / 2);
  }
}

function netColor(g) {
  if (isMine(g)) return C.phosphor;
  const idx = Math.abs(hash(`${g.band}/${g.channel}/${g.width}`)) % (NET_COLORS.length - 1);
  return NET_COLORS[idx + 1];
}

function netName(g) {
  if (g.ssids.length) return g.ssids.join(' / ');
  return `ch${g.channel}${g.count > 1 ? ` ×${g.count}` : ''}`;
}

function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- DOM の数値 ----------

function renderMode(reason) {
  const el = $('mode');
  el.className = `badge ${state.mode}`;
  el.textContent = { live: '実測中', demo: 'デモデータ（実測ではありません）', error: '停止', starting: '接続待ち' }[state.mode] ?? state.mode;
  el.title = reason || '';
}

function renderReadouts(now) {
  const l = state.link;
  const set = (id, v) => { const e = $(id); if (e.textContent !== v) e.textContent = v; };
  if (l) {
    set('iface', `${l.iface}${l.power ? '' : '（Wi-Fi オフ）'}`);
    const ok = l.rssi != null;
    set('ro-rssi', ok ? String(l.rssi) : '--');
    set('ro-rssi-label', ok ? rssiLabel(l.rssi) : '未接続');
    set('ro-power', ok ? formatPower(dbmToMilliwatt(l.rssi)) : '--');
    set('ro-noise', ok ? String(l.noise) : '--');
    const snr = ok ? l.rssi - l.noise : null;
    set('ro-snr', ok ? String(snr) : '--');
    set('ro-snr-label', ok ? snrLabel(snr) : '');
    set('ro-rate', ok ? String(Math.round(l.rate)) : '--');
    if (ok && l.band) {
      const center = channelToFreq(centerChannel(l.channel, l.width, l.band), l.band);
      set('ro-channel', `ch${l.channel} · ${BANDS[l.band].label} · ${l.width} MHz（中心 ${center} MHz）`);
    } else set('ro-channel', '--');
    set('ro-phy', ok ? phyModeName(l.phy) : '--');
    set('ro-ssid', l.ssid ?? (ok ? '取得できません（位置情報の制限）' : '--'));
  }
  const s = stats(windowOf(state.series, now - state.timebase * 1000, now).map((x) => x.rssi));
  set('st-mean', s ? `${s.mean.toFixed(1)}` : '--');
  set('st-min', s ? `${s.min}` : '--');
  set('st-max', s ? `${s.max}` : '--');
  set('st-std', s ? `${s.std.toFixed(2)} dB` : '--');
}

function renderNetTable() {
  const groups = groupNets(state.nets).sort((a, b) => (isMine(b) - isMine(a)) || (b.rssi - a.rssi));
  const anySsid = state.nets.some((n) => n.ssid);
  $('ssid-note').hidden = anySsid || !state.nets.length;
  $('scan-info').textContent = state.scanAt
    ? `${state.nets.length} 個の電波 · ${new Date(state.scanAt).toLocaleTimeString('ja-JP')} にスキャン`
    : 'スキャン中…';
  const tbody = $('net-rows');
  tbody.textContent = '';
  for (const g of groups) {
    const tr = document.createElement('tr');
    if (isMine(g)) tr.className = 'mine';
    const { overlaps, strongest } = congestion(groups, g);
    const pct = clamp((g.rssi - DBM_MIN) / (DBM_MAX - DBM_MIN), 0, 1);
    const cells = [
      null,
      `${g.channel}`,
      `${BANDS[g.band].label.replace(' GHz', '')}G · ${g.width}M`,
      null,
      overlaps ? `${overlaps} 個${strongest != null ? `（最強 ${strongest}）` : ''}` : 'なし',
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      if (i === 0) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.style.background = netColor(g);
        td.append(chip, g.ssids.length ? g.ssids.join(' / ') : '（名前取得不可）');
        if (g.count > 1) td.append(` ×${g.count}`);
        if (isMine(g)) {
          const t = document.createElement('span');
          t.className = 'tag';
          t.textContent = '接続中';
          td.append(t);
        }
      } else if (i === 3) {
        const bar = document.createElement('span');
        bar.className = 'bar';
        bar.style.width = `${Math.round(pct * 60)}px`;
        bar.style.background = g.rssi >= -70 ? C.phosphor : g.rssi >= -80 ? C.amber : C.red;
        td.append(bar, `${g.rssi}`);
      } else td.textContent = text;
      tr.append(td);
    });
    tbody.append(tr);
  }
}

// ---------- 操作 ----------

function setBand(band) {
  state.band = band;
  for (const b of document.querySelectorAll('[data-band]')) b.classList.toggle('on', b.dataset.band === band);
  state.spectrumDirty = true;
}

function setTimebase(sec) {
  state.timebase = sec;
  for (const b of document.querySelectorAll('[data-tb]')) b.classList.toggle('on', Number(b.dataset.tb) === sec);
}

function toggleHold() {
  state.hold = state.hold ? null : Date.now();
  const btn = $('hold');
  btn.classList.toggle('on', !!state.hold);
  btn.textContent = state.hold ? '再開' : '一時停止';
}

function exportCsv() {
  const csv = toCsv(state.series.items, [
    { label: '時刻', get: (s) => new Date(s.t).toISOString() },
    { label: 'RSSI(dBm)', get: (s) => s.rssi },
    { label: 'ノイズ(dBm)', get: (s) => s.noise },
    { label: 'SNR(dB)', get: (s) => (s.rssi != null && s.noise != null ? s.rssi - s.noise : null) },
    { label: '送信レート(Mbps)', get: (s) => s.rate },
  ]);
  const blob = new Blob(['﻿' + csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wifi-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.querySelectorAll('[data-band]').forEach((b) => b.addEventListener('click', () => { state.bandAuto = false; setBand(b.dataset.band); }));
document.querySelectorAll('[data-tb]').forEach((b) => b.addEventListener('click', () => setTimebase(Number(b.dataset.tb))));
$('hold').addEventListener('click', toggleHold);
$('csv').addEventListener('click', exportCsv);
window.addEventListener('resize', () => { state.spectrumDirty = true; });

// ---------- ループ ----------

let lastFrame = performance.now();
let lastReadout = 0;
function frame(ts) {
  const dt = (ts - lastFrame) / 1000;
  lastFrame = ts;
  tick(dt);
  requestAnimationFrame(frame);
}

function tick(dt) {
  const now = state.hold ?? Date.now();
  const target = state.link?.rssi ?? DBM_MIN - 3; // 未接続なら針は左に寝る
  if (!state.hold) state.needle = stepNeedle(state.needle, target, dt);
  drawMeter(now);
  drawScope(now);
  if (state.spectrumDirty) {
    drawSpectrum();
    state.spectrumDirty = false;
  }
  if (performance.now() - lastReadout > 100) {
    lastReadout = performance.now();
    renderReadouts(now);
    state.spectrumDirty = true; // 接続中の印を追従させる
  }
}

// ヘッドレス検証用
window.__app = { state, receive, tick, groupNets };

connect();
requestAnimationFrame(frame);
