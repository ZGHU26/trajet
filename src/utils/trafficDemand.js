// src/utils/trafficDemand.js
export function buildDemandCurve({
  base = 0.60,
  ampMorning = 0.50,
  ampEvening = 0.55,
  muM = 8.5 * 60,     // 8:30
  sigmaM = 45,        // ~1.5h
  muE = 18.0 * 60,    // 18:00
  sigmaE = 60         // ~2h
} = {}) {
  const g = (x, mu, s) => Math.exp(-0.5 * ((x - mu) / s) ** 2);
  const arr = new Array(1440).fill(0);
  for (let m = 0; m < 1440; m++) {
    let v = base * (m >= 6 * 60 && m <= 22 * 60 ? 1 : 0.5); // 夜间更低
    v += ampMorning * g(m, muM, sigmaM);
    v += ampEvening * g(m, muE, sigmaE);
    arr[m] = Math.max(0.15, Math.min(1.6, v));
  }
  const avg = arr.reduce((a,b)=>a+b,0) / 1440;
  return arr.map(v => v / avg);
}
