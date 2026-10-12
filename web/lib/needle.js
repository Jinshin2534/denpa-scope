// アナログメーターの針。ばね＋ダンパで目標値を追いかけ、少し行き過ぎて戻る。
// dt は秒。大きな dt でも発散しないよう内部で刻む。

export function createNeedle(value) {
  return { value, velocity: 0 };
}

export function stepNeedle(needle, target, dt, { stiffness = 60, damping = 9 } = {}) {
  let { value, velocity } = needle;
  const h = 1 / 240;
  let remaining = Math.min(dt, 0.5);
  while (remaining > 1e-9) {
    const s = Math.min(h, remaining);
    const accel = stiffness * (target - value) - damping * velocity;
    velocity += accel * s;
    value += velocity * s;
    remaining -= s;
  }
  return { value, velocity };
}
