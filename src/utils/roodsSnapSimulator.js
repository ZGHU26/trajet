// src/utils/roadsSnapSimulator.js

/**
 * 读取 public/oise-roads.geojson（你已经生成好的路网）
 * - 注意：文件必须放在项目 public 目录下，这样通过 fetch('/oise-roads.geojson') 能直接访问
 */
export async function loadRoadsGeoJSON() {
  const resp = await fetch('/oise-roads.geojson', { cache: 'no-cache' });
  if (!resp.ok) {
    throw new Error(`加载 oise-roads.geojson 失败：HTTP ${resp.status}`);
  }
  const gj = await resp.json();
  if (!gj || !Array.isArray(gj.features)) {
    throw new Error('oise-roads.geojson 格式异常：缺少 features');
  }
  return gj;
}

/**
 * 把 GeoJSON 的 LineString / MultiLineString 统一整理成“折线索引”
 * 每条折线附带：points、segLens（每段长度）、cumLens（累计长度）、totalLen（整条线长）
 */
export function prepareRoadIndex(geojson) {
  const polylines = [];

  for (const f of geojson.features) {
    if (!f || !f.geometry) continue;
    const g = f.geometry;

    if (g.type === 'LineString') {
      pushPolyline(g.coordinates);
    } else if (g.type === 'MultiLineString') {
      for (const line of g.coordinates) pushPolyline(line);
    }
  }

  function pushPolyline(points) {
    if (!Array.isArray(points) || points.length < 2) return;

    const segLens = [];
    const cumLens = [0];
    let total = 0;

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const d = haversine(a[1], a[0], b[1], b[0]); // meters
      segLens.push(d);
      total += d;
      cumLens.push(total);
    }

    // 过滤极短的线（避免速度较快时刚走就循环）
    if (total > 30) {
      polylines.push({
        points,    // [[lng,lat], ...]
        segLens,   // 每段长度（米）
        cumLens,   // 累积长度（米）
        totalLen: total // 总长（米）
      });
    }
  }

  return polylines;
}

/**
 * 沿折线按“累计距离 s（米）”取一个点（线性插值）
 */
function pointAtDistance(poly, s) {
  const { points, segLens, cumLens, totalLen } = poly;

  if (s <= 0) return points[0];
  if (s >= totalLen) return points[points.length - 1];

  // 找到所在的段
  let i = 1;
  while (i < cumLens.length && cumLens[i] < s) i++;
  const segIdx = Math.max(1, i);
  const segStart = segIdx - 1;

  const a = points[segStart];
  const b = points[segStart + 1];
  const segStartDist = cumLens[segStart];
  const segLen = segLens[segStart] || 1;

  const t = (s - segStartDist) / segLen; // 0..1
  const lng = a[0] + (b[0] - a[0]) * t;
  const lat = a[1] + (b[1] - a[1]) * t;
  return [lng, lat];
}

/**
 * 生成“贴道路”的 TripsLayer 轨迹（时间单位：秒）
 * - roadsIndex: prepareRoadIndex 的返回值
 * - n: 车辆数
 * - durationSec: 动画总时长（loopLength）
 * - stepSec: 轨迹采样间隔（建议 1 秒）
 * - vMean: 平均速度（m/s），缺省 8 m/s ≈ 28.8 km/h
 */
export function generateTripsSnapToRoad({
  roadsIndex,
  n = 2000,
  durationSec = 600,
  stepSec = 1,
  vMean = 8
}) {
  if (!roadsIndex || roadsIndex.length === 0) {
    return { trips: [], starttime: Math.floor(Date.now() / 1000), loopLength: durationSec };
  }

  const trips = [];
  const starttime = Math.floor(Date.now() / 1000);

  for (let k = 0; k < n; k++) {
    // 随机挑一条“足够长”的线
    let poly = null;
    for (let tries = 0; tries < 5; tries++) {
      const cand = roadsIndex[Math.floor(Math.random() * roadsIndex.length)];
      if (cand && cand.totalLen > 100) { poly = cand; break; }
    }
    if (!poly) poly = roadsIndex[Math.floor(Math.random() * roadsIndex.length)];

    // 每辆车给一点速度随机性（±30%）
    const v = vMean * (0.7 + 0.6 * Math.random()); // m/s
    const startOffset = Math.random() * Math.max(poly.totalLen - 1, 1);

    const coords = [];
    const timestamps = [];
    for (let t = 0; t <= durationSec; t += stepSec) {
      // 跑到 poly.totalLen 就从头开始（循环）
      const s = (startOffset + v * t) % poly.totalLen;
      coords.push(pointAtDistance(poly, s));
      timestamps.push(starttime + t); // 秒
    }

    trips.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { timestamp: timestamps }
    });
  }

  return { trips, starttime, loopLength: durationSec };
}

/* ----------------- 工具函数 ----------------- */
/** 简单的哈弗辛距离（米） */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; // 地球半径（米）
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
