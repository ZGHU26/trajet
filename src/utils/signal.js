// src/utils/signal.js

/** 加载 GeoJSON（可用 fetch 结果直接传入，不一定非要读文件） */
export async function loadSignalsGeoJSON(urlOrGeojson) {
  if (typeof urlOrGeojson === 'string') {
    const res = await fetch(urlOrGeojson);
    return await res.json();
  }
  return urlOrGeojson;
}

/** 将 Point 信号吸附到最近的路网节点；返回 Map(nodeKey -> signals[]) 和位置数组用于可视化 */
export function buildSignalMapForNodes(nodes /* Array<{id,coord:[lng,lat]}> */, signalsGeojson, snapRadiusMeters = 50) {
  const feats = signalsGeojson?.type === 'FeatureCollection' ? signalsGeojson.features : [signalsGeojson];
  const points = feats.filter(f => f?.geometry?.type === 'Point');

  const k = c => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
  const mPerLng = lng => 111320;
  const mPerLat = 110540;

  // 预构建 nodes 数组
  const nodeArr = nodes.map(n => ({ key: n.id ?? k(n.coord), coord: n.coord }));

  const signalMap = new Map();
  const signalPositions = [];

  for (const s of points) {
    const [sx, sy] = s.geometry.coordinates;
    let best = null, bestD = 1e12;

    for (const n of nodeArr) {
      const dx = (n.coord[0] - sx) * mPerLng((n.coord[0] + sx) / 2) * Math.cos((n.coord[1] * Math.PI) / 180);
      const dy = (n.coord[1] - sy) * mPerLat;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (best && bestD <= snapRadiusMeters) {
      if (!signalMap.has(best.key)) signalMap.set(best.key, []);
      signalMap.get(best.key).push(s);
      signalPositions.push({ id: s.properties?.osmid ?? s.id ?? Math.random().toString(36).slice(2), coord: [sx, sy] });
    }
  }

  return { signalMap, signalPositions };
}

/** 计算该时刻是否绿灯（true=绿灯可通行；false=红灯需等待） */
export function isGreenAt(epochSec, sigFeature, defaults = { cycle_s: 80, green_s: 40 }) {
  const props = sigFeature.properties || {};
  const cycle = Number(props.cycle_s ?? defaults.cycle_s) || 60;
  const green = Number(props.green_s ?? defaults.green_s) || Math.max(10, Math.floor(cycle / 2));
  const offset = Number(props.offset_s ?? 0) || 0;

  const phase = (epochSec + offset) % cycle;
  return phase < green;
}
