// 時系列バッファと統計。サンプルは { t: ミリ秒, ...値 }。

export function createSeries(maxAgeMs) {
  return { maxAgeMs, items: [] };
}

export function pushSample(series, sample) {
  const items = series.items;
  // 時刻が巻き戻ったサンプルは捨てる（並び順を保つため）
  if (items.length && sample.t < items[items.length - 1].t) return series;
  items.push(sample);
  const cutoff = sample.t - series.maxAgeMs;
  let drop = 0;
  while (drop < items.length && items[drop].t < cutoff) drop++;
  if (drop) items.splice(0, drop);
  return series;
}

// [from, to] に入るサンプル
export function windowOf(series, from, to) {
  return series.items.filter((s) => s.t >= from && s.t <= to);
}

export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  let min = Infinity, max = -Infinity, sum = 0;
  for (const x of v) {
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }
  const mean = sum / v.length;
  let sq = 0;
  for (const x of v) sq += (x - mean) ** 2;
  return { min, max, mean, std: Math.sqrt(sq / v.length), n: v.length };
}

// CSV（Excel で文字化けしないよう BOM を付けるのは呼び出し側）
export function toCsv(items, columns) {
  const head = columns.map((c) => c.label).join(',');
  const rows = items.map((s) => columns.map((c) => {
    const v = c.get(s);
    return v == null ? '' : String(v);
  }).join(','));
  return [head, ...rows].join('\n');
}
