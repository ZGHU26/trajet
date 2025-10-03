// src/utils/simParisFlows.js
// 轻量随机版：不做最短路，只做走廊偏好 + 巴黎进出 + 红绿灯 + 限速/车道/单双向

const nodeKey = c => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

function havDistMeters(a, b) {
  const R = 6371000;
  const [lon1, lat1] = [a[0]*Math.PI/180, a[1]*Math.PI/180];
  const [lon2, lat2] = [b[0]*Math.PI/180, b[1]*Math.PI/180];
  const dlon = lon2 - lon1, dlat = lat2 - lat1;
  const h = Math.sin(dlat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dlon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}

function metersPerSecond(seg, carsOnSeg) {
  const vMax = Math.max(2, seg.maxspeedMps || (50/3.6));
  const N = carsOnSeg.get(seg) || 0;
  const lanes = Math.max(1, seg.lanes || 1);
  const density = N / Math.max(1, lanes * seg.lengthMeters);
  const v = Math.max(2, vMax * Math.exp(-3 * density * 1000));
  return Math.min(vMax, v);
}

/** 找靠巴黎的“Gate”（朝巴黎最近的若干节点，偏向干线） */
function findParisGates(segs, parisCenter=[2.3522,48.8566], k=10) {
  const PREFERRED = new Set(['motorway','trunk','primary','secondary']);
  const score = new Map(); // key -> {coord, s}
  for (const s of segs) {
    if (!PREFERRED.has(s.highway)) continue;
    const dA = havDistMeters(s.a, parisCenter);
    const dB = havDistMeters(s.b, parisCenter);
    const push=(key,coord,d)=>{ const sc=-d; const cur=score.get(key); if(!cur||sc>cur.s) score.set(key,{coord,s:sc}); };
    push(s.aKey, s.a, dA); push(s.bKey, s.b, dB);
  }
  return Array.from(score.entries())
    .sort((a,b)=>b[1].s - a[1].s)
    .slice(0,k)
    .map(([key,v])=>({ key, coord:v.coord }));
}

/** 识别走廊段（A1/N31/N2） */
function corridorSetFromRefs(segs, corridorRefs=['A1','N31','N2']) {
  const set = new Set();
  for (const s of segs) {
    const ref = Array.isArray(s.ref) ? s.ref.join(';') : (s.ref || '');
    if (corridorRefs.some(r => new RegExp(`\\b${r.replace(/\s/g,'\\s?')}\\b`, 'i').test(String(ref)))) {
      set.add(s);
    }
  }
  return set;
}

/** 加权随机（干线 + 走廊偏好） */
function weightedPick(list, weightFn) {
  if (!list.length) return null;
  const w = list.map(weightFn);
  const sum = w.reduce((a,b)=>a+b,0) || 1;
  let r = Math.random()*sum;
  for (let i=0;i<list.length;i++){ r -= w[i]; if (r<=0) return list[i]; }
  return list[0];
}

/** 公开主函数：随机游走 + 走廊偏好 + 巴黎进出 + 稀疏存点 */
export function simulateParisFlows({
  segs,
  numCars = 1200,
  durationSec = 600,
  stepSec = 5,                 // 建议>=5 更顺滑
  sampleEvery = 1,             // 每 N 步才记录一次位置（减小数据量）。1=每步都记
  signalMap = null,
  isGreenAt = null,
  parisCenter = [2.3522, 48.8566],
  parisGateCount = 10,         // Gate 数量
  parisFlow = { shareOut: 0.35, shareIn: 0.35, shareLocal: 0.30 },
  corridorRefs = ['A1','N31','N2'],
  spawnBias = { corridor: 0.6, local: 0.4 } // 初始更偏向走廊段
}) {
  if (!segs || !segs.length) {
    return { trips: [], starttime: Math.floor(Date.now()/1000), loopLength: durationSec };
  }

  // 索引
  const segsByAKey = new Map();
  for (const s of segs) {
    if (!segsByAKey.has(s.aKey)) segsByAKey.set(s.aKey, []);
    segsByAKey.get(s.aKey).push(s);
  }
  const PREFERRED = new Set(['motorway','trunk','primary','secondary']);

  // Gate & 走廊集合
  const gates = findParisGates(segs, parisCenter, parisGateCount);
  const gateKeys = gates.map(g=>g.key);
  const gateSet = new Set(gateKeys);
  const corrSet = corridorSetFromRefs(segs, corridorRefs);
  const corrSegs = segs.filter(s => corrSet.has(s));
  const otherSegs = segs.filter(s => !corrSet.has(s));

  // 初始 spawn 权重（走廊&干线更可能被选中）
  const spawnWeight = (s, isCorr) => {
    const base = isCorr ? spawnBias.corridor : spawnBias.local;
    const cls = s.highway==='motorway'?3 : s.highway==='trunk'?2.5 : s.highway==='primary'?2 : s.highway==='secondary'?1.5 : 1;
    return base * cls;
  };
  const pickSpawnSeg = () => {
    const pickCorr = Math.random() < (spawnBias.corridor/(spawnBias.corridor+spawnBias.local));
    const pool = (pickCorr && corrSegs.length) ? corrSegs : otherSegs;
    return weightedPick(pool, s => spawnWeight(s, corrSet.has(s)));
  };

  // 车辆
  const startEpoch = Math.floor(Date.now()/1000);
  const cars = [];
  const carsOnSeg = new Map();
  const inc = s => carsOnSeg.set(s, (carsOnSeg.get(s)||0)+1);
  const dec = s => carsOnSeg.set(s, Math.max(0,(carsOnSeg.get(s)||0)-1));

  const nOut = Math.floor(numCars*(parisFlow.shareOut??0.35));
  const nIn  = Math.floor(numCars*(parisFlow.shareIn ??0.35));
  const nLocal = Math.max(0, numCars - nOut - nIn);

  // OUT：省内 → 朝 gate 随机游走（边界处消失）
  for (let i=0;i<nOut;i++){
    const s0 = pickSpawnSeg() || segs[(Math.random()*segs.length)|0];
    cars.push({ seg:s0, prev:null, pos:0, path:[s0.a.slice()], ts:[0], mode:'OUT' });
    inc(s0);
  }
  // IN：从 gate 进入 → 省内随机游走
  for (let i=0;i<nIn;i++){
    const g = gateKeys[(Math.random()*gateKeys.length)|0];
    const outs = segsByAKey.get(g) || [];
    const s0 = weightedPick(outs, s => PREFERRED.has(s.highway)?2:1) || outs[0] || segs[(Math.random()*segs.length)|0];
    cars.push({ seg:s0, prev:null, pos:0, path:[s0.a.slice()], ts:[0], mode:'IN' });
    inc(s0);
  }
  // LOCAL：省内随机游走
  for (let i=0;i<nLocal;i++){
    const s0 = pickSpawnSeg() || segs[(Math.random()*segs.length)|0];
    cars.push({ seg:s0, prev:null, pos:0, path:[s0.a.slice()], ts:[0], mode:'LOCAL' });
    inc(s0);
  }

  // 选下一段（随机 + 干线偏好 + 不轻易掉头）
  function pickNextSeg(currentSeg, prevSeg, outs) {
    const filtered = outs.filter(s => !(prevSeg && s.aKey===currentSeg.bKey && s.bKey===currentSeg.aKey));
    const list = filtered.length ? filtered : outs;
    return weightedPick(list, s => {
      let w = PREFERRED.has(s.highway)?2:1;
      if (corrSet.has(s)) w *= 1.8;    // 走廊加权
      return w;
    }) || list[0] || null;
  }

  // 模拟
  const steps = Math.max(1, Math.floor(durationSec/stepSec));
  for (let step=1; step<=steps; step++){
    const tSim = step*stepSec;
    for (let i=0;i<cars.length;i++){
      let car = cars[i]; if (!car) continue;
      const v = metersPerSecond(car.seg, carsOnSeg);
      let remain = v * stepSec;

      while (remain > 0) {
        const seg = car.seg;
        const left = Math.max(0, seg.lengthMeters - car.pos);
        if (remain < left) { car.pos += remain; remain = 0; }
        else {
          const nodeK = seg.bKey;

          // 红灯阻塞
          if (signalMap && isGreenAt && signalMap.has(nodeK)) {
            const sigs = signalMap.get(nodeK);
            const anyRed = sigs.some(sig => !isGreenAt(startEpoch + tSim, sig, {cycle_s:80, green_s:40}));
            if (anyRed) { car.pos = seg.lengthMeters; remain = 0; break; }
          }

          // 穿越路口
          remain -= left; dec(seg);

          // OUT：到 gate 就消失（稍后补一辆 IN 车）
          if (car.mode==='OUT' && gateSet.has(nodeK)) { cars[i] = null; break; }

          const outs = segsByAKey.get(nodeK) || [];
          const next = pickNextSeg(seg, car.prev, outs);
          if (!next) { car.pos = seg.lengthMeters; inc(seg); remain = 0; break; }
          car.prev = seg; car.seg = next; car.pos = 0; inc(next);
        }
      }

      // 记录轨迹（稀疏）
      if (cars[i]) {
        car = cars[i];
        if (step % sampleEvery === 0 || step === steps) {
          const ratio = car.pos / Math.max(1, car.seg.lengthMeters);
          const lng = car.seg.a[0] + (car.seg.b[0]-car.seg.a[0]) * ratio;
          const lat = car.seg.a[1] + (car.seg.b[1]-car.seg.a[1]) * ratio;
          car.path.push([lng, lat]); car.ts.push(tSim);
        }
      } else {
        // OUT 消失后立即补一辆 IN 车，保持总量恒定
        const g = gateKeys[(Math.random()*gateKeys.length)|0];
        const outs = segsByAKey.get(g) || [];
        const s0 = weightedPick(outs, s => PREFERRED.has(s.highway)?2:1) || outs[0] || segs[(Math.random()*segs.length)|0];
        const newCar = { seg:s0, prev:null, pos:0, path:[s0.a.slice()], ts:[tSim], mode:'IN' };
        cars[i] = newCar; inc(s0);
      }
    }
  }

  // 输出 TripsLayer 结构
  const trips = cars.filter(Boolean).map(c => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: c.path },
    properties: { timestamp: c.ts }
  }));
  return { trips, starttime: startEpoch, loopLength: durationSec };
}
