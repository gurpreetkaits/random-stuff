// 2D vehicle physics. Pixel units, y pointing down; 40 px = 1 m.
// The renderer maps x → x/40 and y → -y/40.

export const PX_PER_M = 40;
export const START_X = 160;
export const SUB = 1 / 600;

const G = 700;
const KX = 4000, CX = 80;          // suspension: lateral stiffness / damping
const KY = 180, CY = 25;           // suspension: vertical spring / damping
const KSTOP = 12000, SUSP = 14;
const TORQUE = 30000, BRAKE_T = 42000, WMAX = 50, REACT = 0.5, AIR = 7, MU = 1.15;

const BODY_M = 5, BODY_I = BODY_M * (124 * 124 + 28 * 28) / 12;
export const HULL = [[-62, -6], [62, -6], [-60, 14], [60, 14], [0, 16], [-30, -38]];
export const HEAD = { x: -8, y: -46, r: 11 };
export const ANCHORS = [[-40, 20], [42, 20]];
export const WHEEL_R = 18;
const WHEEL_M = 1, WHEEL_I = 0.5 * WHEEL_M * WHEEL_R * WHEEL_R;
export const WHEEL_MAX_W = WMAX;

export function groundY(x) {
  if (x < -40) return 400 - (-40 - x) * 2.5;   // wall behind the start
  const ramp = Math.min(1, Math.max(0, (x - 350) / 700));
  const a = (30 + Math.min(70, Math.max(0, x) * 0.004)) * ramp;
  const h = Math.sin(x * 0.0025) + 0.55 * Math.sin(x * 0.0061 + 1.3)
          + 0.18 * Math.sin(x * 0.0137 + 0.7) + 1.6 * Math.sin(x * 0.00083 + 2) - 1.6 * Math.sin(2);
  return 400 - a * h;
}

export function ground(x) {
  const s = (groundY(x + 1) - groundY(x - 1)) / 2, L = Math.hypot(1, s);
  return { y: groundY(x), L, nx: s / L, ny: -1 / L, tx: 1 / L, ty: s / L };
}

export class Car {
  constructor(x = START_X) {
    const y0 = groundY(x) - 62;
    this.body = { x, y: y0, vx: 0, vy: 0, a: 0, w: 0 };
    this.wheels = ANCHORS.map(([ax, ay]) => ({ ax, ay, x: x + ax, y: y0 + ay, vx: 0, vy: 0, a: 0, w: 0, contact: false }));
    this.simTime = 0;
    this.lastContact = 0;
    this.resetTelemetry();
  }

  // Per-frame audio/fx signals, reset by the caller after reading.
  resetTelemetry() { this.impact = 0; this.slip = 0; this.hullImpact = 0; }

  get airborne() { return this.simTime - this.lastContact > 0.08; }

  step(dt, input) {
    const c = this.body;
    this.simTime += dt;
    c.vy += G * dt;
    c.vx *= 1 - 0.04 * dt;
    let cos = Math.cos(c.a), sin = Math.sin(c.a);

    // suspension springs between chassis anchors and wheels
    for (const wh of this.wheels) {
      wh.vy += G * dt;
      const rx = wh.ax * cos - wh.ay * sin, ry = wh.ax * sin + wh.ay * cos;
      const avx = c.vx - c.w * ry, avy = c.vy + c.w * rx;
      const dx = wh.x - (c.x + rx), dy = wh.y - (c.y + ry);
      const dvx = wh.vx - avx, dvy = wh.vy - avy;
      const ox = dx * cos + dy * sin, oy = -dx * sin + dy * cos;
      const vxl = dvx * cos + dvy * sin, vyl = -dvx * sin + dvy * cos;
      const fx = -KX * ox - CX * vxl;
      let fy = -KY * oy - CY * vyl;
      if (oy < -SUSP) fy -= KSTOP * (oy + SUSP);
      if (oy > SUSP) fy -= KSTOP * (oy - SUSP);
      const Fx = fx * cos - fy * sin, Fy = fx * sin + fy * cos;
      wh.vx += Fx / WHEEL_M * dt; wh.vy += Fy / WHEEL_M * dt;
      c.vx -= Fx / BODY_M * dt; c.vy -= Fy / BODY_M * dt;
      c.w += (rx * -Fy - ry * -Fx) / BODY_I * dt;
      wh.compression = -oy;
    }

    // engine & brakes
    const gas = input.gas, brake = input.brake;
    const airborne = this.airborne;
    for (const wh of this.wheels) {
      let T = 0;
      if (gas) { if (wh.w < WMAX) T = TORQUE; }
      else if (brake) { if (wh.w > 0.5) T = -BRAKE_T; else if (wh.w > -WMAX * 0.5) T = -TORQUE * 0.7; }
      else wh.w *= 1 - 0.5 * dt;
      wh.w += T / WHEEL_I * dt;
      c.w -= T / BODY_I * dt * REACT;
    }
    if (airborne) {
      if (gas) c.w -= AIR * dt;
      else if (brake) c.w += AIR * dt;
    }
    c.w *= 1 - 0.3 * dt;

    // integrate
    c.x += c.vx * dt; c.y += c.vy * dt; c.a += c.w * dt;
    for (const wh of this.wheels) { wh.x += wh.vx * dt; wh.y += wh.vy * dt; wh.a += wh.w * dt; }

    // wheel / ground contact
    for (const wh of this.wheels) {
      const g = ground(wh.x), dist = (g.y - wh.y) / g.L;
      wh.contact = dist < WHEEL_R + 0.5;
      if (dist >= WHEEL_R) continue;
      this.lastContact = this.simTime;
      const pen = WHEEL_R - dist;
      wh.x += g.nx * pen; wh.y += g.ny * pen;
      const vn = wh.vx * g.nx + wh.vy * g.ny;
      let jn = 0;
      if (vn < 0) {
        jn = -vn * WHEEL_M * 1.1;
        wh.vx += g.nx * jn / WHEEL_M; wh.vy += g.ny * jn / WHEEL_M;
        this.impact = Math.max(this.impact, -vn);
      }
      const slip = wh.vx * g.tx + wh.vy * g.ty - wh.w * WHEEL_R;
      this.slip = Math.max(this.slip, Math.abs(slip));
      let jt = -slip / (1 / WHEEL_M + WHEEL_R * WHEEL_R / WHEEL_I);
      const cap = MU * (jn + WHEEL_M * G * dt * 0.3);
      jt = Math.max(-cap, Math.min(cap, jt));
      wh.vx += g.tx * jt / WHEEL_M; wh.vy += g.ty * jt / WHEEL_M;
      wh.w -= WHEEL_R * jt / WHEEL_I;
    }

    // chassis hull / ground contact
    cos = Math.cos(c.a); sin = Math.sin(c.a);
    for (const [lx, ly] of HULL) {
      const rx = lx * cos - ly * sin, ry = lx * sin + ly * cos;
      const g = ground(c.x + rx), dist = (g.y - (c.y + ry)) / g.L;
      if (dist >= 0) continue;
      this.lastContact = this.simTime;
      c.x -= g.nx * dist; c.y -= g.ny * dist;
      const vpx = c.vx - c.w * ry, vpy = c.vy + c.w * rx;
      const vn = vpx * g.nx + vpy * g.ny;
      if (vn >= 0) continue;
      this.hullImpact = Math.max(this.hullImpact, -vn);
      const rn = rx * g.ny - ry * g.nx;
      const j = -1.2 * vn / (1 / BODY_M + rn * rn / BODY_I);
      c.vx += j * g.nx / BODY_M; c.vy += j * g.ny / BODY_M; c.w += rn * j / BODY_I;
      const vt = (c.vx - c.w * ry) * g.tx + (c.vy + c.w * rx) * g.ty;
      const rt = rx * g.ty - ry * g.tx;
      let jt = -vt / (1 / BODY_M + rt * rt / BODY_I);
      jt = Math.max(-0.6 * j, Math.min(0.6 * j, jt));
      c.vx += jt * g.tx / BODY_M; c.vy += jt * g.ty / BODY_M; c.w += rt * jt / BODY_I;
    }
  }

  headHitsGround() {
    const c = this.body, cos = Math.cos(c.a), sin = Math.sin(c.a);
    const hx = c.x + HEAD.x * cos - HEAD.y * sin, hy = c.y + HEAD.x * sin + HEAD.y * cos;
    const g = ground(hx);
    return (g.y - hy) / g.L < HEAD.r;
  }

  // world position of a point given in chassis-local px
  local(lx, ly) {
    const c = this.body, cos = Math.cos(c.a), sin = Math.sin(c.a);
    return { x: c.x + lx * cos - ly * sin, y: c.y + lx * sin + ly * cos };
  }
}
