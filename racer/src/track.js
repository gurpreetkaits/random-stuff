// The circuit: a closed Catmull-Rom loop through control points with
// elevation, sampled every ~2 m. Plain JS (no three.js) so the physics and
// the tests can use it too.
//
// World axes match three.js: x/z is the ground plane, y is up.

export const ROAD_HALF = 6.5;        // asphalt half width (m)
export const KERB = 1.1;             // kerb strip width beyond the asphalt
export const CORRIDOR = 15;          // centreline → barrier wall
export const STEP = 2;               // sample spacing (m)

// Hand-laid circuit: start/finish straight, a fast kink, a climbing left,
// a hairpin, esses, a crest, a downhill sweeper and back onto the straight.
const POINTS = [
  [0, 0, 0], [140, 0, 0], [260, 0, 1], [380, 12, 3], [470, 70, 6], [510, 160, 10],
  [500, 250, 13], [440, 310, 15], [360, 300, 14], [320, 240, 12], [270, 200, 10],
  [205, 225, 8], [160, 290, 9], [80, 345, 12], [-30, 350, 14], [-140, 320, 10],
  [-230, 250, 5], [-270, 150, 2], [-240, 60, 0], [-160, 8, 0], [-80, 0, 0],
];

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export class Track {
  constructor(points = POINTS) {
    // dense polyline through the control points
    const dense = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n];
      for (let k = 0; k < 40; k++) {
        const t = k / 40;
        dense.push([catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[2], p1[2], p2[2], p3[2], t), catmull(p0[1], p1[1], p2[1], p3[1], t)]);
      }
    }
    // resample at an even spacing
    let total = 0;
    const segLen = dense.map((p, i) => {
      const q = dense[(i + 1) % dense.length];
      const l = Math.hypot(q[0] - p[0], q[2] - p[2]);
      total += l;
      return l;
    });
    const count = Math.round(total / STEP);
    this.length = total;
    this.count = count;
    const step = total / count;
    this.step = step;
    this.x = new Float64Array(count); this.y = new Float64Array(count); this.z = new Float64Array(count);
    let seg = 0, segStart = 0;
    for (let i = 0; i < count; i++) {
      const s = i * step;
      while (segStart + segLen[seg] < s) { segStart += segLen[seg]; seg++; }
      const t = (s - segStart) / segLen[seg];
      const a = dense[seg], b = dense[(seg + 1) % dense.length];
      this.x[i] = a[0] + (b[0] - a[0]) * t;
      this.y[i] = a[1] + (b[1] - a[1]) * t;
      this.z[i] = a[2] + (b[2] - a[2]) * t;
    }
    // tangent, left normal, curvature
    this.tx = new Float64Array(count); this.tz = new Float64Array(count);
    this.curv = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const p = this.wrap(i - 1), q = this.wrap(i + 1);
      const dx = this.x[q] - this.x[p], dz = this.z[q] - this.z[p], l = Math.hypot(dx, dz);
      this.tx[i] = dx / l; this.tz[i] = dz / l;
    }
    for (let i = 0; i < count; i++) {
      const p = this.wrap(i - 2), q = this.wrap(i + 2);
      const cross = this.tx[p] * this.tz[q] - this.tz[p] * this.tx[q];
      this.curv[i] = cross / (4 * step);           // signed: negative = left-hand bend, positive = right-hand
    }
  }

  wrap(i) { return ((i % this.count) + this.count) % this.count; }

  // Left of the direction of travel. With x right, y up, z toward the viewer,
  // forward (tx, tz) has its left at (tz, -tx).
  leftX(i) { return this.tz[i]; }
  leftZ(i) { return -this.tx[i]; }

  // Nearest point on the centreline. `hint` (last index) keeps it local and fast.
  locate(x, z, hint = -1) {
    let best = -1, bestD = Infinity;
    if (hint >= 0) {
      for (let k = -30; k <= 30; k++) {
        const i = this.wrap(hint + k);
        const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best < 0 || bestD > 40 * 40) {
      for (let i = 0; i < this.count; i++) {
        const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    // project onto the segment to the next sample for a smooth s and height
    const i = best, j = this.wrap(i + 1);
    const dx = x - this.x[i], dz = z - this.z[i];
    let t = dx * this.tx[i] + dz * this.tz[i];
    let a = i, b = j;
    if (t < 0) { a = this.wrap(i - 1); b = i; t += this.step; }
    const f = Math.max(0, Math.min(1, t / this.step));
    const cx = this.x[a] + (this.x[b] - this.x[a]) * f, cz = this.z[a] + (this.z[b] - this.z[a]) * f;
    const lat = (x - cx) * this.leftX(a) + (z - cz) * this.leftZ(a);
    return {
      i: best,
      s: (a + f) * this.step,
      lat,                                                   // + is left of the racing direction
      y: this.y[a] + (this.y[b] - this.y[a]) * f,
      tx: this.tx[a], tz: this.tz[a],
      grade: (this.y[b] - this.y[a]) / this.step,           // rise per metre along the track
    };
  }

  // A point at distance s along the track, `lat` metres to the left.
  pointAt(s, lat = 0) {
    const L = this.length;
    s = ((s % L) + L) % L;
    const i = Math.floor(s / this.step), j = this.wrap(i + 1), f = s / this.step - i;
    const x = this.x[i] + (this.x[j] - this.x[i]) * f, z = this.z[i] + (this.z[j] - this.z[i]) * f;
    const y = this.y[i] + (this.y[j] - this.y[i]) * f;
    return { x: x + this.leftX(i) * lat, y, z: z + this.leftZ(i) * lat, tx: this.tx[i], tz: this.tz[i] };
  }

  // signed distance from a to b along the loop, in (-L/2, L/2]
  delta(sa, sb) {
    const L = this.length;
    let d = (sb - sa) % L;
    if (d > L / 2) d -= L;
    if (d <= -L / 2) d += L;
    return d;
  }
}
