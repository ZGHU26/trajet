// src/utils/streamSim.js
import { meters } from './roadSimLite';
import { buildDemandCurve } from './trafficDemand';

/** Poisson 采样（Knuth/正态近似） */
function samplePoisson(mu) {
  if (mu <= 0) return 0;
  if (mu > 30) {
    const std = Math.sqrt(mu);
    const z = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2*Math.PI*Math.random());
    return Math.max(0, Math.round(mu + std * z));
  }
  let L = Math.exp(-mu), k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

const keyOf = p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

/** 根据 highway/maxspeed 选速度（m/s） */
function pickSpeed(edge) {
  let kmh = edge.maxspeed || null;
  if (!kmh) {
    const h = (edge.highway || '').toLowerCase();
    if (h.includes('motorway')) kmh = 110;
    else if (h.includes('trunk') || h.includes('primary')) kmh = 80;
    else if (h.includes('secondary')) kmh = 60;
    else if (h.includes('residential') || h.includes('tertiary')) kmh = 40;
    else kmh = 30;
  }
  const ms = kmh / 3.6;
  return ms * (0.8 + 0.4*Math.random()); // 0.8~1.2 抖动
}

/** 秒容量：车道数 × 0.5veh/s × 绿灯比例 */
function capacityPerSec(edge, signalMap) {
  const lanes = Math.max(1, edge.lanesDir || edge.lanesForward || edge.lanes || 1);
  let greenRatio = 1;
  if (signalMap && edge.toKey && signalMap.has(edge.toKey)) {
    const sig = signalMap.get(edge.toKey);
    greenRatio = Math.min(1, Math.max(0.05, (sig.green||20) / (sig.cycle||60)));
  }
  return 0.5 * lanes * greenRatio;
}

/**
 * 流式仿真：相对时钟 tAbs（秒）。TripsLayer 使用秒级 timestamp。
 * - Poisson 发车保证“在线 ≈ 目标在线数(需求 × baseOnline)”
 * - 单/双向、车道加权、道路类型限速
 * - 红灯等待 + 容量放行
 * - 支持倍速：timeScale（0=暂停）
 */
export function createStreamSim({
  segs,
  baseOnline = 800,
  stepSec = 2,
  trailSec = 120,
  tripMinSec = 180,
  tripMaxSec = 480,
  demand = buildDemandCurve(),
  jitterPct = 0.05,
  jitterSeed = 12345,
  signalMap = null,
  isRedAt = null
} = {}) {
  if (!segs || !segs.length) throw new Error('createStreamSim: empty segs');

  // === 邻接：生成有向出边（尊重单行/反向车道） ===
  const adj = new Map();   // nodeKey -> [edgeOut...]
  const edges = [];
  const addOut = (fromKey, edge) => {
    if (!adj.has(fromKey)) adj.set(fromKey, []);
    adj.get(fromKey).push(edge); edges.push(edge);
  };

  for (const s of segs) {
    const forward = {
      from: s.a, to: s.b, fromKey: s.aKey, toKey: s.bKey,
      len: s.len, highway: s.highway, maxspeed: s.maxspeed,
      lanes: s.lanes, lanesDir: s.lanesForward || s.lanes || 1, dir: +1
    };
    addOut(s.aKey, forward);

    if (!s.oneway && (s.lanesBackward === null || s.lanesBackward > 0)) {
      const back = {
        from: s.b, to: s.a, fromKey: s.bKey, toKey: s.aKey,
        len: s.len, highway: s.highway, maxspeed: s.maxspeed,
        lanes: s.lanes, lanesDir: s.lanesBackward || s.lanes || 1, dir: -1
      };
      addOut(s.bKey, back);
    }
  }

  // 选路：车道权重
  function pickNextEdge(fromKey) {
    const list = adj.get(fromKey);
    if (!list || !list.length) return null;
    const weights = list.map(e => Math.max(1, e.lanesDir || 1));
    const sum = weights.reduce((a,b)=>a+b,0);
    let r = Math.random()*sum;
    for (let i=0;i<list.length;i++){ r -= weights[i]; if (r<=0) return list[i]; }
    return list[list.length-1];
  }

  // 车辆池
  const cars = new Map();
  let nextId = 1;
  let tAbs = 0; // 相对秒
  const now0 = Math.floor(Date.now()/1000); // 仅用于 starttime 字段

  // 可复现分钟抖动
  function minuteJitter(minute) {
    let x = (minute + jitterSeed) | 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return (x >>> 0) / 2**32; // 0..1
  }

  const ETrip = 0.5 * (tripMinSec + tripMaxSec);

  function spawnByPoisson(effStep) {
    const m = ((tAbs/60)|0) % 1440;
    const jit = jitterPct ? ((minuteJitter(m) * 2 - 1) * jitterPct) : 0;
    const lambda = (baseOnline * demand[m] * (1 + jit)) / ETrip; // 每秒发车率
    const k = samplePoisson(lambda * effStep);
    for (let i=0;i<k;i++) {
      const e = edges[(Math.random()*edges.length)|0];
      const id = nextId++;
      const v = pickSpeed(e);
      cars.set(id, {
        id, edge: e, pos: 0,
        speed: v,
        leftSec: (tripMinSec + Math.random()*(tripMaxSec - tripMinSec))|0,
        coords: [e.from],
        ts: [tAbs],
      });
    }
  }

  let timeScale = 1; // 倍速：0=暂停, 0.5/1/2/4...

  function stepOnce() {
    const effStep = stepSec * timeScale;
    if (effStep <= 0) return;

    tAbs += effStep;
    spawnByPoisson(effStep);

    // 本步容量缓存（简化：按“进入下一条边的容量”）
    const passQuota = new Map();
    const quotaKey = (edge) => edge.toKey + '|' + edge.fromKey;
    const edgeQuota = (edge) => {
      const k = quotaKey(edge);
      if (!passQuota.has(k)) {
        const cap = capacityPerSec(edge, signalMap) * effStep;
        passQuota.set(k, cap);
      }
      return passQuota.get(k);
    };

    for (const car of cars.values()) {
      const nearEnd = (car.edge.len - car.pos) <= Math.max(6, car.speed * effStep * 0.25);
      let stoppedByRed = false;
      if (nearEnd && signalMap && isRedAt) {
        const red = isRedAt(car.edge.toKey, now0 + tAbs, signalMap);
        if (red) stoppedByRed = true;
      }

      if (!stoppedByRed) {
        let dist = car.speed * effStep;
        while (dist > 0) {
          const remain = car.edge.len - car.pos;
          if (dist < remain) { car.pos += dist; dist = 0; }
          else {
            // 到端点，尝试切换
            const q = edgeQuota(car.edge);
            if (q >= 1) {
              passQuota.set(quotaKey(car.edge), q - 1);
              // 记录节点点
              car.coords.push([car.edge.to[0], car.edge.to[1]]);
              car.ts.push(tAbs);
              const next = pickNextEdge(car.edge.toKey);
              if (!next) { car.pos = car.edge.len; dist = 0; break; }
              car.edge = next;
              car.pos = 0;
              car.speed = pickSpeed(next);
              dist -= remain;
            } else {
              // 无配额：排队
              car.pos = Math.max(0, car.edge.len - 0.1);
              dist = 0;
              break;
            }
          }
        }
      }

      // 本步轨迹点（边内）
      const t = car.pos / car.edge.len;
      const x = car.edge.from[0] + (car.edge.to[0] - car.edge.from[0]) * t;
      const y = car.edge.from[1] + (car.edge.to[1] - car.edge.from[1]) * t;
      car.coords.push([x, y]);
      car.ts.push(tAbs);

      // 剪尾
      const cut = tAbs - trailSec;
      while (car.ts.length && car.ts[0] < cut) {
        car.ts.shift(); car.coords.shift();
      }

      car.leftSec -= effStep;
      if (car.leftSec <= 0) cars.delete(car.id);
    }
  }

  function getTrips() {
    const trips = [];
    for (const car of cars.values()) {
      if (car.coords.length < 2) continue;
      trips.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: car.coords.slice() },
        properties: { timestamp: car.ts.slice() }
      });
    }
    return { trips, starttime: now0, loopLength: 24*3600, nowSec: tAbs };
  }

  let timer = null;
  let onUpdateRef = null;

  function start(cb) {
    if (timer) return;
    onUpdateRef = cb;
    // 预热：按当前分钟发一波
    spawnByPoisson(stepSec);
    cb && cb(getTrips());
    timer = setInterval(() => { stepOnce(); cb && cb(getTrips()); }, stepSec * 1000);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // 运行期调参
  function setBaseOnline(x) { baseOnline = Math.max(0, x|0); }
  function setJitter(pct) { jitterPct = Math.max(0, Math.min(0.3, +pct || 0)); }
  function setTrail(s) { trailSec = Math.max(10, s|0); }
  function setStep(s) { const v = Math.max(1, s|0); if (v!==stepSec){ stepSec=v; if (timer){ stop(); start(onUpdateRef);} } }
  function setClockSeconds(sec) { tAbs = ((+sec)||0) % (24*3600); }
  function setTimeScale(scale) { timeScale = Math.max(0, +scale || 0); } // ✅ 倍速

  return { start, stop, getTrips, setBaseOnline, setJitter, setTrail, setStep, setClockSeconds, setTimeScale };
}
