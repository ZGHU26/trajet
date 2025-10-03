// src/utils/roadSimLite.js

/** —— 工具：经纬度估长（米） —— */
function lengthMetersOfLine(coords) {
  let L = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1], [lng2, lat2] = coords[i];
    const dx = (lng2 - lng1) * 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    const dy = (lat2 - lat1) * 110540;
    L += Math.hypot(dx, dy);
  }
  return L;
}
const nodeKey = c => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

/** —— 解析：限速（km/h） —— */
function parseMaxspeedKmh(raw, highway) {
  if (raw == null) {
    const DEF = { motorway: 110, trunk: 90, primary: 80, secondary: 80, tertiary: 80, residential: 50, unclassified: 50, service: 30 };
    return DEF[highway] ?? 50;
  }
  const s = String(raw);
  const m = s.match(/\d+(\.\d+)?/g);
  if (m && m.length) return Number(m[0]);         // "50" / "50;70" -> 50
  if (/rural/i.test(s)) return 80;                // "FR:rural" 兜底
  if (/urban/i.test(s)) return 50;                // "FR:urban"
  return 50;
}

/** —— 解析：车道 —— */
function parseLanesFields(props) {
  const toInt = v => {
    if (v == null) return null;
    const parts = String(v).split(';').map(x => Number(x)).filter(x => !Number.isNaN(x));
    if (!parts.length) return null;
    return parts.reduce((a, b) => a + b, 0);
  };
  return {
    total: toInt(props.lanes),
    fwd: toInt(props['lanes:forward']),
    bwd: toInt(props['lanes:backward'])
  };
}

/** —— 按方向推断：每方向车道数 —— */
function inferLanesPerDir({ oneway, highway, lanesTotal, lanesFwd, lanesBwd }) {
  const DEF = { motorway: 2, trunk: 1, primary: 1, secondary: 1, tertiary: 1, residential: 1, unclassified: 1, service: 1 };
  if (oneway === true) {
    const n = lanesTotal ?? DEF[highway] ?? 1;
    return { fwd: Math.max(1, n), bwd: 0 };
  }
  // 双向
  if (lanesFwd != null || lanesBwd != null) {
    return { fwd: Math.max(1, lanesFwd ?? 1), bwd: Math.max(1, lanesBwd ?? 1) };
  }
  if (lanesTotal != null) {
    if (lanesTotal >= 2) return { fwd: Math.floor(lanesTotal / 2), bwd: Math.ceil(lanesTotal / 2) };
    return { fwd: 1, bwd: 1 };
  }
  const d = DEF[highway] ?? 1;
  return { fwd: d, bwd: d };
}

/** —— 对外：GeoJSON -> segments（方向化） —— */
export function segmentsFromGeoJSON(geojson) {
  const feats = geojson?.type === 'FeatureCollection' ? geojson.features : [geojson];
  const segs = [];
  for (const f of feats) {
    if (!f || !f.geometry || f.geometry.type !== 'LineString') continue;
    const props = f.properties || {};
    const hw = props.highway;
    if (!hw) continue;

    const oneway =
      props.oneway === true ||
      String(props.oneway).toLowerCase() === 'true' ||
      String(props.oneway) === '1';

    const maxspeedKmh = parseMaxspeedKmh(props.maxspeed, hw);
    const maxspeedMps = maxspeedKmh / 3.6;

    const { total, fwd, bwd } = parseLanesFields(props);
    const { fwd: lanesFwd, bwd: lanesBwd } = inferLanesPerDir({
      oneway, highway: hw, lanesTotal: total, lanesFwd: fwd, lanesBwd: bwd
    });

    const coords = f.geometry.coordinates;
    const L = props.length ?? lengthMetersOfLine(coords);
    const a = coords[0], b = coords[coords.length - 1];

    // 正向段 a->b
    if (lanesFwd > 0) {
      segs.push({
        osmid: props.osmid,
        highway: hw,
        a, b,
        aKey: nodeKey(a),
        bKey: nodeKey(b),
        lengthMeters: L,
        lanes: lanesFwd,          // 本方向车道数
        maxspeedKmh,
        maxspeedMps,
        oneway                    // 原始 oneway 标记（供参考）
      });
    }
    // 反向段 b->a（仅双向）
    if (!oneway && lanesBwd > 0) {
      segs.push({
        osmid: props.osmid,
        highway: hw,
        a: b, b: a,
        aKey: nodeKey(b),
        bKey: nodeKey(a),
        lengthMeters: L,
        lanes: lanesBwd,
        maxspeedKmh,
        maxspeedMps,
        oneway
      });
    }
  }
  return segs;
}

/** —— 速度模型：限速为上限 + 车道/密度指数降速（保底2m/s） —— */
function metersPerSecond(seg, carsOnSeg) {
  const vMax = Math.max(2, seg.maxspeedMps || (50 / 3.6));
  const N = carsOnSeg.get(seg) || 0;
  const lanes = Math.max(1, seg.lanes || 1);
  const density = N / Math.max(1, lanes * seg.lengthMeters); // veh / m / dir
  const v = Math.max(2, vMax * Math.exp(-3 * density * 1000));
  return Math.min(vMax, v);
}

/** —— 选下一段：尽量避免原地 U-turn —— */
function pickNextSeg(currentSeg, prevSeg, candidates) {
  // 排除“直接掉头”的段（如果不是死路）
  const filtered = candidates.filter(s => !(prevSeg && s.aKey === currentSeg.bKey && s.bKey === currentSeg.aKey));
  const list = filtered.length ? filtered : candidates;
  return list[(Math.random() * list.length) | 0];
}

/** —— 对外：基于路段生成 Trips（支持红绿灯） —— */
export function simulateTripsOnRoads({
  segs,
  numCars = 800,
  durationSec = 600,
  stepSec = 1,
  signalMap = null,        // Map(nodeKey -> signals[])
  isRedAt = null           // function(epochSec, signalFeature, defaults) => boolean
}) {
  if (!Array.isArray(segs) || segs.length === 0) {
    return { trips: [], starttime: Math.floor(Date.now()/1000), loopLength: durationSec };
  }

  const startEpoch = Math.floor(Date.now() / 1000);

  // 建图：aKey -> 出度段集合
  const segsByAKey = new Map();
  for (const s of segs) {
    if (!segsByAKey.has(s.aKey)) segsByAKey.set(s.aKey, []);
    segsByAKey.get(s.aKey).push(s);
  }

  // 车辆集合 + 段拥堵计数
  const cars = [];
  const carsOnSeg = new Map();
  const inc = seg => carsOnSeg.set(seg, (carsOnSeg.get(seg) || 0) + 1);
  const dec = seg => carsOnSeg.set(seg, Math.max(0, (carsOnSeg.get(seg) || 0) - 1));

  // 初始化车辆
  for (let i = 0; i < numCars; i++) {
    const seg = segs[(Math.random() * segs.length) | 0];
    const car = {
      seg, prevSeg: null, pos: 0,
      path: [seg.a.slice()],
      ts: [0]
    };
    cars.push(car);
    inc(seg);
  }

  const steps = Math.floor(durationSec / stepSec);
  for (let step = 1; step <= steps; step++) {
    const tSim = step * stepSec;
    const tEpoch = startEpoch + tSim;

    for (const car of cars) {
      // 速度
      const v = metersPerSecond(car.seg, carsOnSeg);
      let remain = v * stepSec;

      while (remain > 0) {
        const seg = car.seg;
        const left = Math.max(0, seg.lengthMeters - car.pos);

        if (remain < left) {
          car.pos += remain;
          remain = 0;
        } else {
          // 将到路口：看红绿灯
          const nodeK = seg.bKey;
          let blocked = false;
          if (signalMap && isRedAt && signalMap.has(nodeK)) {
            const sigs = signalMap.get(nodeK);
            // 任一红灯，视为禁止通行（简化）
            const anyRed = sigs.some(sig => !isRedAt(tEpoch, sig, { cycle_s: 80, green_s: 40 }));
            if (anyRed) blocked = true;
          }

          if (blocked) {
            // 停在路口，记录一个点（保持时间步）
            remain = 0;
            car.pos = seg.lengthMeters;
          } else {
            // 穿越路口，进入下一段
            remain -= left;
            dec(car.seg);

            const candidates = segsByAKey.get(seg.bKey) || [];
            if (candidates.length === 0) {
              // 死路：停在端点
              car.pos = seg.lengthMeters;
              remain = 0;
              inc(car.seg); // 仍记在当前段末端
              break;
            } else {
              const next = pickNextSeg(seg, car.prevSeg, candidates);
              car.prevSeg = seg;
              car.seg = next;
              car.pos = 0;
              inc(car.seg);
            }
          }
        }
      }

      // 写“秒级”采样点
      const ratio = car.pos / Math.max(1, car.seg.lengthMeters);
      const lng = car.seg.a[0] + (car.seg.b[0] - car.seg.a[0]) * ratio;
      const lat = car.seg.a[1] + (car.seg.b[1] - car.seg.a[1]) * ratio;
      car.path.push([lng, lat]);
      car.ts.push(tSim);
    }
  }

  // 输出 TripsLayer 需要的结构
  const trips = cars.map(c => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: c.path },
    properties: { timestamp: c.ts }           // 秒
  }));

  return { trips, starttime: startEpoch, loopLength: durationSec };
}
