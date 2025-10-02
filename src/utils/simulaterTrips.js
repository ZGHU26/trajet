// src/utils/simulateTrips.js
function randIn(min, max) { return min + Math.random() * (max - min); }
function sampleTarget(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return [randIn(minLng, maxLng), randIn(minLat, maxLat)];
}

export function generateSyntheticTrips({
  n = 2000,
  durationSec = 600,
  stepSec = 1,
  bbox = [121.30, 31.15, 121.45, 31.25],
  vMean = 8
} = {}) {
  const trips = [];
  const steps = Math.max(2, Math.floor(durationSec / stepSec));
  const [minLng, minLat, maxLng, maxLat] = bbox;

  const degPerMeterLng = 1 / 96000;
  const degPerMeterLat = 1 / 111000;
  const stepLng = vMean * stepSec * degPerMeterLng;
  const stepLat = vMean * stepSec * degPerMeterLat;

  for (let i = 0; i < n; i++) {
    let lng = randIn(minLng, maxLng);
    let lat = randIn(minLat, maxLat);
    let [tx, ty] = sampleTarget(bbox);

    const coords = [[lng, lat]];
    const timestamps = [0]; // 秒

    for (let k = 1; k < steps; k++) {
      const dx = tx - lng, dy = ty - lat;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist, uy = dy / dist;
      const noise = 0.2;

      lng += (ux + (Math.random() - 0.5) * noise) * stepLng;
      lat += (uy + (Math.random() - 0.5) * noise) * stepLat;

      // 边界裁剪
      if (lng < minLng) lng = minLng;
      if (lng > maxLng) lng = maxLng;
      if (lat < minLat) lat = minLat;
      if (lat > maxLat) lat = maxLat;

      // 接近目标则换目标
      if (Math.hypot(tx - lng, ty - lat) < 0.002) [tx, ty] = sampleTarget(bbox);

      coords.push([lng, lat]);
      timestamps.push(k * stepSec); // 秒
    }

    trips.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { timestamp: timestamps } // 秒
    });
  }

  return {
    trips,
    starttime: Math.floor(Date.now() / 1000), // 秒
    loopLength: durationSec                   // 秒
  };
}
