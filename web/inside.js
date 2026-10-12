// 「受信の内側」パネル: 届いた電力 → 順番待ち → 復調 → 速度 の 4 段を描く。
import { clamp } from './lib/wifi.js';
import { analyzeReception, CCA_PREAMBLE_DBM, CCA_ENERGY_DBM } from './lib/receiver.js';
import { MCS_INFO, inferMcs, bestMcsForSnr, phyRate, rateTable } from './lib/mcs.js';
import { rng, axisLevels, simulateSymbols, symbolErrorRate } from './lib/qam.js';
import { createCsma, stepCsma, shares, trimLog } from './lib/csma.js';

const SLOT_US = 9; // 5/6 GHz の 1 スロット
const SLOTS_PER_SEC = 120; // 画面での進み（スローモーション）
const VIEW_SLOTS = 320;
const SHARE_WINDOW = 20000;
const MAX_LANES = 7;
const MAC_EFFICIENCY = 0.65; // ヘッダ・確認応答・待ち時間で消える分を除いた目安
const QAM_POINTS = 900;

const css = getComputedStyle(document.documentElement);
const C = {
  phosphor: css.getPropertyValue('--phosphor').trim(),
  amber: css.getPropertyValue('--amber').trim(),
  red: css.getPropertyValue('--red').trim(),
  dim: css.getPropertyValue('--dim').trim(),
  ink: css.getPropertyValue('--ink').trim(),
};
const LANE_COLORS = ['#ffb54a', '#6bc7ff', '#ff7ab8', '#c59bff', '#ffe36b', '#7affea', '#ff9a6b'];
const FONT = '-apple-system, "Hiragino Sans", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

const $ = (id) => document.getElementById(id);

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  const h = canvas.clientHeight || 190;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function setHtml(id, html) {
  const e = $(id);
  if (e.innerHTML !== html) e.innerHTML = html;
}

const fmt = (v, d = 1) => (v == null ? '--' : v.toFixed(d));
const netLabel = (n) => (n.ssid ? n.ssid : `ch${n.channel}/${n.width}M`);

export function createInside(getState) {
  const r = rng(20261012);
  const st = {
    extraNoiseDb: 0,
    a: null, // 直近の analyzeReception
    mcs: null,
    sim: null,
    simKey: '',
    slotAcc: 0,
    qam: [], // 星座図の点
    qamKey: '',
    lastText: 0,
  };

  const slider = $('extra-noise');
  slider.addEventListener('input', () => {
    st.extraNoiseDb = Number(slider.value);
    $('extra-noise-out').textContent = `+${st.extraNoiseDb} dB`;
  });

  function analyze() {
    const { link, nets } = getState();
    st.a = analyzeReception(link, nets, { extraNoiseDb: st.extraNoiseDb });
    st.mcs = link && link.rssi != null ? inferMcs(link.rate, link.phy, link.width) : null;
  }

  // ---------- ② 順番待ち ----------

  function ensureSim() {
    const contend = st.a?.groups.contend ?? [];
    const lanes = contend.slice(0, MAX_LANES - 1);
    const key = lanes.map((n) => `${n.channel}/${n.width}/${n.rssi}`).join('|');
    // 台数が変わったときだけ作り直す（強さの小さな揺れでは作り直さない）
    if (st.sim && st.sim.stations.length === lanes.length + 1) { st.lanes = lanes; return; }
    st.simKey = key;
    st.lanes = lanes;
    st.sim = createCsma(['me', ...lanes.map((_, i) => `n${i}`)], rng(lanes.length + 1));
    for (let i = 0; i < SHARE_WINDOW; i++) stepCsma(st.sim); // 取り分が安定するまで先に回しておく
  }

  function drawAir(dt) {
    const { ctx, w, h } = fit($('st-air'));
    ctx.fillStyle = '#07100b';
    ctx.fillRect(0, 0, w, h);
    if (!st.a?.ok) return emptyNote(ctx, w, h);
    ensureSim();
    const sim = st.sim;
    st.slotAcc += dt * SLOTS_PER_SEC;
    while (st.slotAcc >= 1) { stepCsma(sim); st.slotAcc--; }
    trimLog(sim, SHARE_WINDOW);

    const ids = sim.stations.map((s) => s.id);
    const L = 62, R = 6, T = 6, B = 16;
    const laneH = Math.min(22, (h - T - B) / ids.length);
    const pw = w - L - R;
    const x0 = sim.slot - VIEW_SLOTS;
    const xOf = (slot) => L + ((slot - x0) / VIEW_SLOTS) * pw;
    ctx.font = `10px ${FONT}`;
    ctx.textBaseline = 'middle';
    ids.forEach((id, i) => {
      const y = T + i * laneH;
      const color = id === 'me' ? C.phosphor : LANE_COLORS[i - 1];
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(L, y + 1, pw, laneH - 2);
      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      const label = id === 'me' ? '自分の親機' : `${st.lanes[i - 1].rssi} dBm`;
      ctx.fillText(label, L - 6, y + laneH / 2);
    });
    for (const tx of sim.log) {
      if (tx.end < x0) continue;
      const i = ids.indexOf(tx.id);
      const y = T + i * laneH;
      const a = xOf(Math.max(tx.start, x0)), b = xOf(Math.min(tx.end, sim.slot));
      if (b <= a) continue;
      ctx.fillStyle = tx.collision ? C.red : (tx.id === 'me' ? C.phosphor : LANE_COLORS[i - 1]);
      ctx.globalAlpha = tx.collision ? 0.9 : 0.75;
      ctx.fillRect(a, y + 3, b - a, laneH - 6);
    }
    ctx.globalAlpha = 1;
    // いま
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(L + pw - 0.5, T);
    ctx.lineTo(L + pw - 0.5, T + laneH * ids.length);
    ctx.stroke();
    const slow = Math.round(1e6 / (SLOTS_PER_SEC * SLOT_US) / 100) * 100;
    ctx.fillStyle = C.dim;
    ctx.textAlign = 'left';
    ctx.font = `10px ${FONT}`;
    ctx.fillText(`← ${(VIEW_SLOTS * SLOT_US / 1000).toFixed(1)} ms（約${slow}倍のスロー） 赤 = 衝突`, L, h - 7);
  }

  // ---------- ③ 復調 ----------

  function qamParams() {
    const a = st.a;
    const { link } = getState();
    let idx = st.mcs ? st.mcs.mcs : bestMcsForSnr(a.sinr, link.phy);
    if (idx < 0) idx = 0;
    return { idx, info: MCS_INFO[idx], snr: a.sinr };
  }

  function drawQam() {
    const { ctx, w, h } = fit($('st-qam'));
    ctx.fillStyle = '#07100b';
    ctx.fillRect(0, 0, w, h);
    if (!st.a?.ok) return emptyNote(ctx, w, h);
    const { info, snr } = qamParams();
    const key = `${info.order}`;
    if (key !== st.qamKey) { st.qam = []; st.qamKey = key; }
    const add = simulateSymbols(info.order, snr, 30, r).pts;
    st.qam.push(...add);
    if (st.qam.length > QAM_POINTS) st.qam.splice(0, st.qam.length - QAM_POINTS);

    const size = Math.min(w, h) - 8;
    const cx = w / 2, cy = h / 2;
    const { i: li, q: lq } = axisLevels(info.order);
    const ext = info.order === 2 ? 1.6 : Math.abs(li[0]) * 1.25;
    const sx = (v) => cx + (v / ext) * (size / 2);
    const sy = (v) => cy - (v / ext) * (size / 2);
    // 判定の境界
    ctx.strokeStyle = 'rgba(116,255,163,0.13)';
    ctx.lineWidth = 1;
    const bounds = (lv) => lv.slice(1).map((v, k) => (v + lv[k]) / 2);
    if (li.length <= 32) {
      for (const b of bounds(li)) { ctx.beginPath(); ctx.moveTo(Math.round(sx(b)) + 0.5, cy - size / 2); ctx.lineTo(Math.round(sx(b)) + 0.5, cy + size / 2); ctx.stroke(); }
      for (const b of bounds(lq)) { ctx.beginPath(); ctx.moveTo(cx - size / 2, Math.round(sy(b)) + 0.5); ctx.lineTo(cx + size / 2, Math.round(sy(b)) + 0.5); ctx.stroke(); }
    }
    // 受信した点
    const dot = info.order >= 1024 ? 1.2 : info.order >= 256 ? 1.6 : 2.2;
    for (const p of st.qam) {
      ctx.fillStyle = p.ok ? 'rgba(116,255,163,0.55)' : 'rgba(255,106,92,0.9)';
      ctx.fillRect(sx(p.x) - dot / 2, sy(p.y) - dot / 2, dot, dot);
    }
    // 送った点（理想の位置）
    ctx.fillStyle = '#ffffff';
    const ideal = info.order >= 256 ? 1 : 2.5;
    for (const a of li) for (const b of lq) ctx.fillRect(sx(a) - ideal / 2, sy(b) - ideal / 2, ideal, ideal);
    ctx.fillStyle = C.dim;
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Q', cx + 3, 2);
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';
    ctx.fillText('I', w - 2, cy - 2);
  }

  // ---------- ① 届く電力 ----------

  function drawPower() {
    const { ctx, w, h } = fit($('st-power'));
    ctx.fillStyle = '#07100b';
    ctx.fillRect(0, 0, w, h);
    const a = st.a;
    if (!a?.ok) return emptyNote(ctx, w, h);
    const MIN = -100, MAX = -20;
    const L = 8, R = 8, T = 6, B = 18;
    const pw = w - L - R;
    const xOf = (dbm) => L + ((clamp(dbm, MIN, MAX) - MIN) / (MAX - MIN)) * pw;
    const floor = 10 * Math.log10(Math.pow(10, a.noise / 10) + (a.interfDbm != null ? Math.pow(10, a.interfDbm / 10) : 0));
    const rows = [
      { label: '自分の親機', v: a.signal, color: C.phosphor },
      { label: '混信（重なる電波の合計）', v: a.interfDbm, color: C.red },
      { label: `雑音${st.extraNoiseDb ? `（+${st.extraNoiseDb} dB 追加）` : ''}`, v: a.noise, color: C.amber },
      { label: '雑音＋混信', v: floor, color: '#d98a6a' },
    ];
    const rowH = (h - T - B) / rows.length;
    // 目盛り
    ctx.strokeStyle = 'rgba(116,255,163,0.08)';
    ctx.fillStyle = C.dim;
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let v = MIN; v <= MAX; v += 20) {
      const x = Math.round(xOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke();
      ctx.fillText(`${v}`, clamp(x, L + 10, w - R - 10), h - 4);
    }
    rows.forEach((row, i) => {
      const y = T + i * rowH;
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = `10px ${FONT}`;
      ctx.fillText(row.label, L, y + 2);
      const by = y + 16, bh = Math.max(6, rowH - 22);
      if (row.v == null) {
        ctx.fillStyle = C.dim;
        ctx.fillText('なし', L, by);
        return;
      }
      ctx.fillStyle = row.color;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(L, by, xOf(row.v) - L, bh);
      ctx.globalAlpha = 1;
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const tx = xOf(row.v) + 4;
      ctx.fillText(`${row.v.toFixed(1)} dBm`, Math.min(tx, w - R - 62), by + bh / 2);
    });
    // SINR の幅
    const ya = T + rowH * 3 + 14;
    const x1 = xOf(floor), x2 = xOf(a.signal);
    ctx.strokeStyle = C.phosphor;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, T + 16); ctx.lineTo(x1, ya + rowH - 14);
    ctx.moveTo(x2, T + 16); ctx.lineTo(x2, ya + rowH - 14);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---------- ④ 速度 ----------

  function rateRows() {
    const { link } = getState();
    const a = st.a;
    const nss = st.mcs?.nss ?? 2;
    const table = rateTable(link.phy, link.width);
    const top = table ? phyRate(link.phy, link.width, table.length - 1, nss) : null;
    const best = bestMcsForSnr(a.sinr, link.phy);
    const bySinr = table && best >= 0 ? phyRate(link.phy, link.width, best, nss) : 0;
    const usable = Math.min(link.rate || 0, bySinr ?? link.rate);
    const effective = usable * a.share * MAC_EFFICIENCY;
    return { nss, top, now: link.rate, bySinr, effective, best };
  }

  function drawRate() {
    const { ctx, w, h } = fit($('st-rate'));
    ctx.fillStyle = '#07100b';
    ctx.fillRect(0, 0, w, h);
    if (!st.a?.ok) return emptyNote(ctx, w, h);
    const rr = rateRows();
    const rows = [
      { label: `規格上の最高（${rr.nss} ストリーム）`, v: rr.top, color: '#5a6a62' },
      { label: 'いまの送信レート（実測）', v: rr.now, color: C.phosphor },
      { label: 'この SINR で出せる目安', v: rr.bySinr, color: C.amber },
      { label: '順番待ち後の実効の目安', v: rr.effective, color: '#6bc7ff' },
    ];
    const max = Math.max(...rows.map((x) => x.v || 0), 1);
    const L = 8, R = 8, T = 4;
    const rowH = (h - T - 4) / rows.length;
    rows.forEach((row, i) => {
      const y = T + i * rowH;
      ctx.fillStyle = C.ink;
      ctx.font = `10px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(row.label, L, y + 2);
      const by = y + 16, bh = Math.max(6, rowH - 22);
      const bw = ((row.v || 0) / max) * (w - L - R);
      ctx.fillStyle = row.color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(L, by, bw, bh);
      ctx.globalAlpha = 1;
      ctx.font = `11px ${MONO}`;
      ctx.textBaseline = 'middle';
      const text = row.v == null ? '--' : `${Math.round(row.v)} Mbps`;
      const tw = ctx.measureText(text).width;
      const inside = bw > tw + 10;
      ctx.fillStyle = inside && i > 0 ? '#08130c' : C.ink;
      ctx.fillText(text, inside ? L + 5 : L + bw + 4, by + bh / 2);
    });
  }

  function emptyNote(ctx, w, h) {
    ctx.fillStyle = C.dim;
    ctx.font = `12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('未接続', w / 2, h / 2);
  }

  // ---------- 文章 ----------

  function renderText() {
    const a = st.a;
    const { link, scanAt } = getState();
    if (!a?.ok) {
      setHtml('inside-lead', 'Wi-Fi に接続すると、受信機の内側の様子をここに出します。');
      for (const id of ['cap-power', 'cap-air', 'cap-qam', 'cap-rate']) setHtml(id, '');
      return;
    }
    const g = a.groups;
    const scanned = scanAt != null;
    const lossWarn = a.lossDb >= 3;
    const shareWarn = a.share < 0.5;
    const alone = !g.contend.length && !g.interfere.length;
    setHtml('inside-lead', scanned && alone
      ? `自分のチャンネルに重なる他の電波は見つかりません。SINR は <b>${fmt(a.sinr)} dB</b> で、チャンネルは独り占めです（混んだ場所ほどここが変わります）。`
      : scanned
      ? `この場所では、同じチャンネルで <b>${g.contend.length} 台</b>と順番を待ち合い、<b>${g.interfere.length} 個</b>の電波が雑音として混ざっています。`
        + ` SINR は <b>${fmt(a.sinr)} dB</b>${a.lossDb >= 0.05 ? `（混信で <span class="${lossWarn ? 'warn' : ''}">${fmt(a.lossDb)} dB</span> 悪化）` : ''}、`
        + (g.contend.length ? `チャンネルの時間は ${g.contend.length + 1} 等分（1 台 <b class="${shareWarn ? 'warn' : ''}">${Math.round(a.share * 100)}%</b>）になり得ます。` : 'チャンネルは独り占めです。')
      : 'スキャン結果を待っています（初回は数秒かかります）。');

    const top = g.interfere.slice(0, 3).map((n) => `${netLabel(n)} ${fmt(n.inBand)} dBm`).join('、');
    setHtml('cap-power',
      `アンテナには自分の親機だけでなく、周波数が重なる電波も全部いっしょに入ってきます。`
      + `受信機が使える余裕は <b>自分の親機 − (雑音＋混信) = SINR ${fmt(a.sinr)} dB</b>。`
      + (g.interfere.length ? ` 主な混信: ${top}。` : ' いまは混信になる電波はありません。'));

    const sh = st.sim ? shares(st.sim, SHARE_WINDOW) : null;
    const mine = sh ? sh.byStation.me : null;
    const hidden = g.contend.length - (st.lanes?.length ?? 0);
    setHtml('cap-air',
      `同じ主チャンネルで ${CCA_PREAMBLE_DBM} dBm 以上の電波は、送信の頭が読めるので「送り終わるまで待つ」相手になります（別チャンネルでも主チャンネルに ${CCA_ENERGY_DBM} dBm 以上入れば同じ）。`
      + ` ${g.contend.length ? `全員がずっと送りたいとき、自分の親機が実際に送れている時間は <b>${mine != null ? Math.round(mine * 100) : '--'}%</b>（残りは他の局・くじ引きの待ち時間・衝突 ${sh ? Math.round(sh.collided * 100) : '--'}%）。` : '<b>いまは待ち合う相手がいないので、チャンネルを独り占めできます。</b>'}`
      + (hidden > 0 ? ` ほか ${hidden} 台は図から省略。` : ''));

    const { info, snr, idx } = qamParams();
    const ser = symbolErrorRate(info.order, snr);
    const best = bestMcsForSnr(snr, link.phy);
    const src = st.mcs ? `送信レート ${Math.round(link.rate)} Mbps から逆算すると、いまは <b>${info.mod}（MCS ${idx}・${st.mcs.nss} ストリーム）</b>${st.mcs.exact ? '' : '付近'}` : `SINR から見ると <b>${info.mod}</b>`;
    setHtml('cap-qam',
      `電波の位相と振幅を 1 点として読み、いちばん近い白い点の値（${info.bits} ビット）だと判定します。${src}。`
      + ` 実測 SINR の雑音で揺らすと、読み間違い（赤）は ${ser < 1e-4 ? '<b>ほぼゼロ</b>' : `<b>${(ser * 100).toFixed(ser < 0.01 ? 2 : 1)}%</b>`}。`
      + (best >= 0 ? ` この SINR なら ${MCS_INFO[best].mod} まで使える目安です。` : ' この SINR ではいちばん頑丈な変調も厳しい状態です。')
      + (ser > 0.1 && idx > Math.max(best, 0) ? ' <b>この誤りの多さだと、親機はまもなく変調を粗くします（速度が落ちます）。</b>' : ''));

    const rr = rateRows();
    setHtml('cap-rate',
      `誤りが増えると親機は変調を粗くして速度を落とします。さらに順番待ちとヘッダ・確認応答で時間が削られ、実際に使える速さは <b>${Math.round(rr.effective)} Mbps 前後</b>（最悪の目安、効率 ${Math.round(MAC_EFFICIENCY * 100)}% と仮定）。`);
  }

  return {
    state: st,
    update(dt) {
      analyze();
      drawPower();
      drawAir(dt);
      drawQam();
      drawRate();
      if (performance.now() - st.lastText > 400) {
        st.lastText = performance.now();
        renderText();
      }
    },
  };
}
