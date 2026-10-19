// Real rigid-body car physics on Rapier: a dynamic chassis on four raycast
// wheels with sprung, damped suspension and per-tyre friction, plus engine,
// gearbox, brakes, handbrake, aero downforce and optional driving assists.
// Plain JS (runs in Node for the tests).
//
// Axes match three.js: y up; a car with heading h faces (sin h, 0, cos h);
// its left is (cos h, 0, -sin h). Steer > 0 is left, yaw rate > 0 turns left.

import RAPIER from '@dimforge/rapier3d-compat';
import { ROAD_HALF, KERB, CORRIDOR } from './track.js';

export const DT = 1 / 120;
export const initPhysics = () => RAPIER.init();

const G = 9.81;
const MASS = 1250;
const IY = MASS * (4.3 ** 2 + 1.84 ** 2) / 12;
const WHEEL_R = 0.34, WHEEL_X = 0.84, WHEEL_Z = 1.35, CONNECT_Y = 0.5, REST = 0.24;
const GEARS = [3.25, 2.25, 1.7, 1.36, 1.12, 0.94], FINAL = 3.6, REVERSE = 3.0;
const IDLE = 950, REDLINE = 8000, SHIFT_UP = 7500, SHIFT_DOWN = 3900;
const DRAG = 0.42, DOWNFORCE = 1.4;
const MAX_STEER = 0.55;
const GRIP_ROAD = 2.3, GRIP_GRASS = 1.05;

function torque(rpm) {                       // N·m, peaky in the mid range
  const x = rpm / 1000;
  return Math.max(180, 560 - 22 * (x - 5.2) ** 2);
}

function yawQuat(h) { return { x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }; }
function rotate(q, v) {                      // rotate vector v by quaternion q
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y, iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x, iw = -x * v.x - y * v.y - z * v.z;
  return { x: ix * w + iw * -x + iy * -z - iz * -y, y: iy * w + iw * -y + iz * -x - ix * -z, z: iz * w + iw * -z + ix * -y - iy * -x };
}

// ---------------------------------------------------------------- world
export class Physics {
  constructor(track) {
    this.track = track;
    this.world = new RAPIER.World({ x: 0, y: -G, z: 0 });
    this.world.timestep = DT;
    this.events = new RAPIER.EventQueue(true);
    this.cars = new Map();                   // collider handle → car
    this.buildTrack();
  }

  buildTrack() {
    const t = this.track, n = t.count;
    // drivable surface: one trimesh across the whole corridor
    const lats = [-(CORRIDOR + 1.5), -(ROAD_HALF + KERB), -ROAD_HALF, ROAD_HALF, ROAD_HALF + KERB, CORRIDOR + 1.5];
    const dys = [-0.06, -0.01, 0, 0, -0.01, -0.06];
    const verts = new Float32Array(n * lats.length * 3), idx = [];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < lats.length; k++) {
        const o = (i * lats.length + k) * 3;
        verts[o] = t.x[i] + t.leftX(i) * lats[k];
        verts[o + 1] = t.y[i] + dys[k];
        verts[o + 2] = t.z[i] + t.leftZ(i) * lats[k];
      }
    }
    const L = lats.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      for (let k = 0; k < L - 1; k++) {
        const a = i * L + k, b = j * L + k;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const ground = RAPIER.ColliderDesc.trimesh(verts, new Uint32Array(idx)).setFriction(0.9);
    this.world.createCollider(ground);

    // barrier walls: a solid block per track segment on each side
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const len = Math.hypot(t.x[j] - t.x[i], t.z[j] - t.z[i]);
      const h = Math.atan2(t.tx[i], t.tz[i]);
      for (const side of [1, -1]) {
        const lat = side * (CORRIDOR + 0.6);
        const cx = (t.x[i] + t.x[j]) / 2 + t.leftX(i) * lat, cz = (t.z[i] + t.z[j]) / 2 + t.leftZ(i) * lat;
        const wall = RAPIER.ColliderDesc.cuboid(0.6, 2.2, len / 2 + 0.15)
          .setTranslation(cx, (t.y[i] + t.y[j]) / 2 + 1.6, cz)
          .setRotation(yawQuat(h))
          .setFriction(0.25).setRestitution(0.15);
        this.world.createCollider(wall);
      }
    }
  }

  // One fixed physics tick: every car applies its controls, then the world steps.
  step(drivers) {
    for (const [car, input] of drivers) car.control(input, DT);
    this.world.step(this.events);
    this.events.drainContactForceEvents(e => {
      const f = e.totalForceMagnitude();
      for (const h of [e.collider1(), e.collider2()]) {
        const car = this.cars.get(h);
        if (car) car.impactForce = Math.max(car.impactForce, f);
      }
    });
    for (const [car] of drivers) car.readState(DT);
  }
}

// ---------------------------------------------------------------- the car
const CHASSIS = { hx: 0.92, hy: 0.3, hz: 2.15, y: 0.6 };

export class Car {
  constructor(physics, s = 0, lat = 0) {
    this.physics = physics;
    this.track = physics.track;
    const world = physics.world;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setAngularDamping(0.4).setLinearDamping(0.02));
    // chassis box, low centre of mass
    const col = RAPIER.ColliderDesc.cuboid(CHASSIS.hx, CHASSIS.hy, CHASSIS.hz).setTranslation(0, CHASSIS.y, 0)
      .setMass(MASS).setFriction(0.3).setRestitution(0.1)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(15000);
    this.collider = world.createCollider(col, this.body);
    this.body.setAdditionalMassProperties(0, { x: 0, y: -0.25, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, true);
    physics.cars.set(this.collider.handle, this);

    const v = this.vehicle = world.createVehicleController(this.body);
    v.indexUpAxis = 1;
    v.setIndexForwardAxis = 2;
    for (const [x, z] of [[WHEEL_X, WHEEL_Z], [-WHEEL_X, WHEEL_Z], [WHEEL_X, -WHEEL_Z], [-WHEEL_X, -WHEEL_Z]]) {
      v.addWheel({ x, y: CONNECT_Y, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, REST, WHEEL_R);
    }
    for (let i = 0; i < 4; i++) {
      v.setWheelSuspensionStiffness(i, 34);
      v.setWheelSuspensionCompression(i, 3.2);
      v.setWheelSuspensionRelaxation(i, 3.6);
      v.setWheelMaxSuspensionForce(i, 60000);
      v.setWheelMaxSuspensionTravel(i, 0.22);
      v.setWheelFrictionSlip(i, GRIP_ROAD);
      v.setWheelSideFrictionStiffness(i, 1.0);
    }
    this.assists = true;
    this.reset(s, lat);
  }

  reset(s, lat = 0) {
    const p = this.track.pointAt(s, lat);
    const h = Math.atan2(p.tx, p.tz);
    this.body.setTranslation({ x: p.x, y: p.y + 0.12, z: p.z }, true);
    this.body.setRotation(yawQuat(h), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.gear = 1; this.rpm = IDLE; this.shiftTimer = 0; this.shifted = 0;
    this.steer = 0; this.hint = -1; this.flipped = 0;
    this.impactForce = 0; this.impact = 0; this.wheelspin = 0; this.slipR = 0;
    this.ax = 0; this.ay = 0; this.prevV = null;
    this.readState(0);
  }

  // ---------------------------------------------------------- controls
  control(input, dt) {
    const v = this.vehicle, speed = this.speed, vlong = this.forwardSpeed;

    // steering, with an optional assist that limits lock to what the tyres can use
    let maxSteer = MAX_STEER / (1 + speed / 40);
    if (this.assists) maxSteer = Math.min(maxSteer, Math.max(0.05, GRIP_ROAD * 0.6 * G * 2.7 / Math.max(1, speed * speed) * 1.8));
    const target = -(input.steer || 0) * maxSteer;
    const rate = 3.4 + (Math.sign(target) !== Math.sign(this.steer) ? 2 : 0);
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, target - this.steer));
    v.setWheelSteering(0, this.steer);
    v.setWheelSteering(1, this.steer);

    // gearbox
    const reversing = this.gear === -1;
    const ratio = (reversing ? REVERSE : GEARS[this.gear - 1]) * FINAL;
    const wheelRpm = Math.abs(vlong) / WHEEL_R * 60 / (2 * Math.PI);
    let rpm = Math.max(IDLE, wheelRpm * ratio);
    if (input.throttle > 0 && this.gear === 1 && rpm < 3500) rpm = Math.max(rpm, IDLE + 2800 * input.throttle);   // clutch slip
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (!reversing && this.shiftTimer === 0) {
      if (rpm > SHIFT_UP && this.gear < GEARS.length) { this.gear++; this.shiftTimer = 0.22; this.shifted = 1; }
      else if (rpm < SHIFT_DOWN && this.gear > 1) { this.gear--; this.shiftTimer = 0.18; }
    }
    if (input.brake > 0.5 && !input.throttle && vlong < 0.6 && !reversing) this.gear = -1;
    if (reversing && (input.throttle > 0 || vlong > 1)) this.gear = 1;
    this.rpm += (Math.min(rpm, REDLINE + 100) - this.rpm) * Math.min(1, dt * 18);

    // engine → rear wheels (rear-wheel drive)
    let drive = 0;
    if (this.gear === -1) {
      if (input.brake > 0 && vlong > -12) drive = -torque(this.rpm) * REVERSE * FINAL / WHEEL_R * 0.45 * input.brake;
    } else if (input.throttle > 0 && this.shiftTimer < 0.1 && this.rpm < REDLINE + 50) {
      drive = torque(this.rpm) * ratio / WHEEL_R * 0.76 * input.throttle;
    }
    // simple traction control so launches don't just smoke the tyres
    if (this.assists && this.wheelspin > 0.25) drive *= 0.6;
    v.setWheelEngineForce(2, drive / 2);
    v.setWheelEngineForce(3, drive / 2);

    // brakes (front-biased) and handbrake
    const braking = input.brake > 0 && this.gear !== -1 && vlong > 0.5 ? input.brake : 0;
    const bf = 62 * braking;
    v.setWheelBrake(0, bf * 0.62); v.setWheelBrake(1, bf * 0.62);
    v.setWheelBrake(2, bf * 0.38 + (input.handbrake ? 30 : 0)); v.setWheelBrake(3, bf * 0.38 + (input.handbrake ? 30 : 0));
    const rearSide = input.handbrake ? 0.35 : 1;
    const grip = this.surface === 'grass' ? GRIP_GRASS : GRIP_ROAD;
    for (let i = 0; i < 4; i++) v.setWheelFrictionSlip(i, grip);
    v.setWheelSideFrictionStiffness(2, rearSide); v.setWheelSideFrictionStiffness(3, rearSide);

    // aero: drag and downforce, plus grass drag
    const lin = this.body.linvel();
    const k = DRAG * speed + (this.surface === 'grass' ? 120 / Math.max(2, speed) : 0);
    const down = DOWNFORCE * speed * speed;
    const up = this.up;
    this.body.applyImpulse({ x: (-lin.x * k - up.x * down) * dt, y: (-lin.y * k * 0.2 - up.y * down) * dt, z: (-lin.z * k - up.z * down) * dt }, true);

    // stability assist: pull yaw rate toward what the steering asks for.
    // The handbrake turns it off so you can throw the car into a drift.
    if (this.assists && !input.handbrake && Math.abs(vlong) > 4 && this.grounded) {
      const w = this.body.angvel().y, wanted = vlong * this.steer / 2.7;
      this.body.applyTorqueImpulse({ x: 0, y: -IY * 2.2 * (w - wanted) * Math.min(1, Math.abs(vlong) / 15) * dt, z: 0 }, true);
    }

    v.updateVehicle(dt);
  }

  // ---------------------------------------------------------- state
  readState(dt) {
    const p = this.body.translation(), q = this.body.rotation(), lin = this.body.linvel();
    this.x = p.x; this.y = p.y; this.z = p.z; this.q = q;
    this.vx = lin.x; this.vz = lin.z; this.vy = lin.y;
    const f = rotate(q, { x: 0, y: 0, z: 1 });
    this.up = rotate(q, { x: 0, y: 1, z: 0 });
    this.h = Math.atan2(f.x, f.z);
    this.fwd = f;
    this.loc = this.track.locate(this.x, this.z, this.hint);
    this.hint = this.loc.i;
    this.surface = Math.abs(this.loc.lat) < ROAD_HALF + KERB * 0.6 ? 'road' : 'grass';
    this.slope = this.loc.grade * (Math.sin(this.h) * this.loc.tx + Math.cos(this.h) * this.loc.tz);

    const v = this.vehicle;
    let contacts = 0;
    for (let i = 0; i < 4; i++) if (v.wheelIsInContact(i)) contacts++;
    this.grounded = contacts >= 2;

    // rear slide angle (smoke, squeal) and wheelspin
    const w = this.body.angvel().y;
    const left = { x: Math.cos(this.h), z: -Math.sin(this.h) };
    const vlong = this.forwardSpeed;
    const vlatRear = lin.x * left.x + lin.z * left.z - WHEEL_Z * w;   // sideways speed at the rear axle
    this.slipR = this.grounded ? Math.abs(vlatRear) / Math.max(Math.abs(vlong), 4) : 0;
    const rot = v.wheelRotation(2) || 0;
    if (dt > 0 && this.prevRot != null) {
      const surfaceSpeed = Math.abs(rot - this.prevRot) / dt * WHEEL_R;
      this.wheelspin = this.grounded ? Math.max(0, (surfaceSpeed - Math.abs(vlong) - 1.5) / Math.max(4, Math.abs(vlong))) : 0;
    }
    this.prevRot = rot;
    this.wheelSpin = -rot;

    // accelerations (for HUD/camera feel) and impacts
    if (dt > 0 && this.prevV) {
      const axw = (lin.x - this.prevV.x) / dt, azw = (lin.z - this.prevV.z) / dt;
      this.ax += ((axw * f.x + azw * f.z) - this.ax) * Math.min(1, dt * 6);
      this.ay += ((axw * left.x + azw * left.z) - this.ay) * Math.min(1, dt * 6);
    }
    this.prevV = { x: lin.x, z: lin.z };
    this.impact = this.impactForce > 0 ? Math.min(25, this.impactForce / 40000) : 0;   // rough hit strength for sound/shake
    this.impactForce = 0;

    // upside down for a while → put back on the track
    this.flipped = this.up.y < 0.25 ? this.flipped + dt : 0;
  }

  get speed() { return Math.hypot(this.vx, this.vz); }
  get forwardSpeed() { return this.vx * Math.sin(this.h) + this.vz * Math.cos(this.h); }

  // wheel poses in car space, for rendering
  wheelPoses() {
    const v = this.vehicle, out = [];
    for (let i = 0; i < 4; i++) {
      const len = v.wheelSuspensionLength(i) ?? REST;
      out.push({ y: CONNECT_Y - len, steer: i < 2 ? this.steer : 0, spin: -(v.wheelRotation(i) || 0) });
    }
    return out;
  }

  remove() {
    this.physics.cars.delete(this.collider.handle);
    this.physics.world.removeVehicleController?.(this.vehicle);
    this.physics.world.removeRigidBody(this.body);
  }
}

// An online opponent: a kinematic body driven by the network, so your car
// physically collides with it.
export class RemoteBody {
  constructor(physics) {
    this.physics = physics;
    this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(CHASSIS.hx, CHASSIS.hy, CHASSIS.hz).setTranslation(0, CHASSIS.y, 0).setFriction(0.3), this.body);
  }
  set(x, y, z, q) {
    this.body.setNextKinematicTranslation({ x, y, z });
    this.body.setNextKinematicRotation(q);
  }
  remove() { this.physics.world.removeRigidBody(this.body); }
}

export const SPEC = { WHEEL_R, WHEEL_X, WHEEL_Z, REDLINE, GEARS: GEARS.length };
