// src/utils/signals.js

// 近似米距
function meters(a, b) {
  const dx = (b[0] - a[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

// 加载 GeoJSON
export async function loadSignalsGeoJSON(url = '/oise-signals.geojson') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`load signals failed: ${res.status}`);
  return await res.json();
}

/**
 * 将红绿灯点吸附到最近的路口节点
 * @param nodes [{ id, coord:[lng,lat] }]
 * @param signalsGeoJSON geojson
 * @param snapRadiusM 吸附半径（米）
 * @returns { signalMap: Map(nodeId -> {hasSignal, cycle, green, offset, coord}), signalPositions: [{id, coord}] }
 */
export function buildSignalMapForNodes(nodes, signalsGeoJSON, snapRadiusM = 60) {
  const signalMap = new Map();
  const signalPositions = [];

  const sigFeatures = signalsGeoJSON?.features || [];
  if (!nodes?.length || !sigFeatures.length) return { signalMap, signalPositions };

  for (const f of sigFeatures) {
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const sc = f.geometry.coordinates;

    // 找最近节点
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      const d = meters(n.coord, sc);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (!best || bestD > snapRadiusM) continue;

    // 读取/生成周期参数（如果 geojson 没给就用默认）
    const cycle = f.properties?.cycle_s ?? 60;
    const green = f.properties?.green_s ?? 30;
    const offset = f.properties?.offset_s ?? Math.floor(Math.random() * cycle);

    const existed = signalMap.get(best.id);
    const cfg = { hasSignal: true, cycle, green, offset, coord: best.coord };
    if (!existed || cycle > existed.cycle) signalMap.set(best.id, cfg);
  }

  for (const [id, cfg] of signalMap.entries()) {
    signalPositions.push({ id, coord: cfg.coord });
  }
  return { signalMap, signalPositions };
}

// tSec 时刻是否红灯（简化：非绿即红）
export function isRedAt(nodeId, tSec, signalMap) {
  const cfg = signalMap?.get(nodeId);
  if (!cfg || !cfg.hasSignal) return false;
  const phase = (tSec + (cfg.offset || 0)) % cfg.cycle;
  return !(phase < cfg.green);
}
