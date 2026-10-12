// 同じチャンネルの順番待ち（CSMA/CA）を、スロット単位で動かす小さなシミュレーター。
// 各局は「空いている」と感じたスロットごとにバックオフを 1 減らし、0 になったら送る。
// 2 局が同じスロットで送り始めたら衝突。衝突した局は待ち時間の幅 (CW) を倍にする。

export const CW_MIN = 15;
export const CW_MAX = 1023;

export function createCsma(stations, r, { frameSlots = [12, 40], load = 1 } = {}) {
  return {
    r,
    frameSlots,
    load, // 1 スロットあたり送りたいものが生まれる確率（1 = いつも送りたい）
    slot: 0,
    busyUntil: 0,
    current: null, // { ids: [...], start, end, collision }
    log: [], // 送信の記録 { id, start, end, collision }
    stations: stations.map((id) => ({ id, cw: CW_MIN, backoff: Math.floor(r() * (CW_MIN + 1)), hasData: load >= 1, sent: 0, airtime: 0 })),
  };
}

export function stepCsma(sim) {
  const { r } = sim;
  const s = sim.slot;
  if (s < sim.busyUntil) { sim.slot++; return sim; }
  if (sim.current) {
    // 送信が終わった
    for (const id of sim.current.ids) {
      const st = sim.stations.find((x) => x.id === id);
      st.cw = sim.current.collision ? Math.min(CW_MAX, st.cw * 2 + 1) : CW_MIN;
      if (!sim.current.collision) { st.sent++; st.airtime += sim.current.end - sim.current.start; }
      st.backoff = Math.floor(r() * (st.cw + 1));
      st.hasData = sim.current.collision || sim.load >= 1 || r() < sim.load;
    }
    sim.current = null;
  }
  for (const st of sim.stations) if (!st.hasData && r() < sim.load) st.hasData = true;
  const ready = sim.stations.filter((st) => st.hasData && st.backoff === 0);
  if (ready.length) {
    const len = sim.frameSlots[0] + Math.floor(r() * (sim.frameSlots[1] - sim.frameSlots[0] + 1));
    const tx = { ids: ready.map((st) => st.id), start: s, end: s + len, collision: ready.length > 1 };
    sim.current = tx;
    sim.busyUntil = tx.end;
    for (const id of tx.ids) sim.log.push({ id, start: tx.start, end: tx.end, collision: tx.collision });
  } else {
    for (const st of sim.stations) if (st.hasData && st.backoff > 0) st.backoff--;
  }
  sim.slot++;
  return sim;
}

// 直近 window スロットのうち、各局が成功して送っていた割合
export function shares(sim, window) {
  const from = sim.slot - window;
  const out = {};
  let collided = 0;
  const seen = new Set(); // 衝突は局の数だけ記録されているので 1 回だけ数える
  for (const st of sim.stations) out[st.id] = 0;
  for (const tx of sim.log) {
    const a = Math.max(tx.start, from), b = Math.min(tx.end, sim.slot);
    if (b <= a) continue;
    if (!tx.collision) out[tx.id] += b - a;
    else if (!seen.has(tx.start)) { seen.add(tx.start); collided += b - a; }
  }
  for (const k in out) out[k] /= window;
  return { byStation: out, collided: collided / window };
}

// 古い記録を捨てる
export function trimLog(sim, keep) {
  const from = sim.slot - keep;
  if (sim.log.length && sim.log[0].end < from) sim.log = sim.log.filter((tx) => tx.end >= from);
}
