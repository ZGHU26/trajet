// src/utils/roadSimLite.js
export function segmentsFromGeoJSON(gj) {
  const segs = [];
  if (!gj || !gj.features) return segs;
  const pushSeg = (a, b) => {
    if (!a || !b) return;
    if (!Array.isArray(a) || !Array.isArray(b)) return;
    if (a.length < 2 || b.length < 2) return;
    const dx = (b[0] - a[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
    const dy = (b[1] - a[1]) * 110540;
    const len = Math.hypot(dx, dy);
    if (len > 1) segs.push({ a, b, len });
  };
  for (const f of gj.features) {
    const g = f && f.geometry;
    if (!g) continue;
    if (g.type === 'LineString') {
      const cs = g.coordinates || [];
      for (let i = 0; i < cs.length - 1; i++) pushSeg(cs[i], cs[i + 1]);
    } else if (g.type === 'MultiLineString') {
      for (const line of g.coordinates || []) {
        for (let i = 0; i < line.length - 1; i++) pushSeg(line[i], line[i + 1]);
      }
    }
  }
  return segs;
}

export function simulateTripsOnRoads({ segs, numCars = 1000, durationSec = 600, stepSec = 1 }) {
  if (!segs || segs.length === 0) {
    return { trips: [], starttime: Math.floor(Date.now() / 1000), loopLength: durationSec };
  }
  const key = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const adj = new Map();
  for (const s of segs) {
    const ka = key(s.a), kb = key(s.b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push(s);
    adj.get(kb).push({ a: s.b, b: s.a, len: s.len });
  }
  const randomNext = (k) => {
    const list = adj.get(k);
    if (!list || list.length === 0) return null;
    return list[Math.floor(Math.random() * list.length)];
  };

  function walk(startSeg, seconds) {
    const coords = [], ts = [];
    let t = 0;
    let segStart = startSeg.a, segEnd = startSeg.b;
    let currKey = key(segEnd);
    coords.push(segStart); ts.push(0);
    while (t < seconds) {
      const speed = 8 + Math.random() * 6; // m/s
      let remain = speed * stepSec;
      while (remain > 0) {
        const dx = (segEnd[0] - segStart[0]) * 111320 * Math.cos(((segStart[1] + segEnd[1]) / 2) * Math.PI / 180);
        const dy = (segEnd[1] - segStart[1]) * 110540;
        const segMeters = Math.max(1, Math.hypot(dx, dy));
        if (remain < segMeters) {
          const r = remain / segMeters;
          const p = [segStart[0] + (segEnd[0] - segStart[0]) * r,
                     segStart[1] + (segEnd[1] - segStart[1]) * r];
          coords.push(p); remain = 0; segStart = p;
        } else {
          coords.push(segEnd);
          remain -= segMeters;
          const nxt = randomNext(currKey);
          if (!nxt) {
            const any = segs[Math.floor(Math.random() * segs.length)];
            segStart = any.a; segEnd = any.b; currKey = key(any.b);
          } else {
            segStart = nxt.a; segEnd = nxt.b; currKey = key(nxt.b);
          }
        }
      }
      t += stepSec; ts.push(t);
    }
    return { coords, ts };
  }

  const trips = [];
  for (let i = 0; i < numCars; i++) {
    const seed = segs[Math.floor(Math.random() * segs.length)];
    const { coords, ts } = walk(seed, durationSec);
    trips.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { timestamp: ts } });
  }
  return { trips, starttime: Math.floor(Date.now() / 1000), loopLength: durationSec };
}
