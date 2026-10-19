// Headless check on the real (Rapier) physics: the AI must lap the circuit,
// acceleration and braking must be in a sane range, the barriers must hold,
// and two cars must physically collide.
import { Track } from '../src/track.js';
import { Physics, Car, DT, initPhysics } from '../src/car.js';
import { aiInput } from '../src/ai.js';

await initPhysics();
const track = new Track();
console.log(`track: ${track.length.toFixed(0)} m, ${track.count} samples`);
let ok = true;
const fail = msg => { console.error('FAIL: ' + msg); ok = false; };

// 1. AI laps
{
  const phys = new Physics(track);
  const car = new Car(phys, 0, 0);
  let progress = 0, lastS = car.loc.s, t = 0, maxSpeed = 0, offTrack = 0, flips = 0, lapAt = null;
  while (progress < track.length * 2 && t < 240) {
    phys.step([[car, aiInput(car, track, 0.95)]]);
    progress += track.delta(lastS, car.loc.s);
    lastS = car.loc.s;
    t += DT;
    if (lapAt == null && progress >= track.length) lapAt = t;
    maxSpeed = Math.max(maxSpeed, car.speed);
    if (car.surface === 'grass') offTrack += DT;
    if (car.flipped > 2) { flips++; car.reset(car.loc.s, 0); }
    if (!Number.isFinite(car.x)) { fail('physics blew up'); break; }
  }
  console.log(`AI: lap 1 ${lapAt?.toFixed(1)} s, 2 laps ${t.toFixed(1)} s, top ${(maxSpeed * 3.6).toFixed(0)} km/h, ${offTrack.toFixed(1)} s off track, ${flips} flips`);
  if (progress < track.length * 2) fail('AI did not finish 2 laps in 240 s');
  if (flips) fail('AI flipped the car');
}

// 2. Acceleration and braking on the start straight
{
  const phys = new Physics(track);
  const car = new Car(phys, -100, 0);
  let t = 0, t100 = null;
  while (t < 7) {
    phys.step([[car, { throttle: 1, brake: 0, steer: 0 }]]);
    t += DT;
    if (t100 == null && car.speed * 3.6 >= 100) t100 = t;
  }
  const v0 = car.speed, s0 = car.loc.s;
  let tb = 0;
  while (car.speed > 0.5 && tb < 10) { phys.step([[car, { throttle: 0, brake: 1, steer: 0 }]]); tb += DT; }
  const dist = track.delta(s0, car.loc.s);
  console.log(`0-100 km/h: ${t100 ? t100.toFixed(2) + ' s' : 'not reached'}; braking from ${(v0 * 3.6).toFixed(0)} km/h: ${dist.toFixed(0)} m in ${tb.toFixed(1)} s`);
  if (!t100 || t100 > 6 || t100 < 2.3) fail('0-100 time out of range');
  const decel = v0 / tb;
  if (decel < 6 || decel > 16) fail(`braking decel ${decel.toFixed(1)} m/s² out of range`);
}

// 3. Barrier: full throttle with full lock must stay inside the walls
{
  const phys = new Physics(track);
  const car = new Car(phys, 50, 0);
  let maxLat = 0;
  for (let t = 0; t < 10; t += DT) {
    phys.step([[car, { throttle: 1, brake: 0, steer: 1 }]]);
    maxLat = Math.max(maxLat, Math.abs(car.loc.lat));
  }
  console.log(`barrier test: max |lat| ${maxLat.toFixed(2)} m`);
  if (maxLat > 15.2) fail('car escaped through the barrier');
}

// 4. Car-to-car: a moving car hitting a parked one must push it
{
  const phys = new Physics(track);
  const parked = new Car(phys, 60, 0), mover = new Car(phys, 30, 0);
  const before = parked.loc.s;
  let hit = 0;
  for (let t = 0; t < 4; t += DT) {
    phys.step([[mover, { throttle: 1, brake: 0, steer: 0 }], [parked, { throttle: 0, brake: 0, steer: 0 }]]);
    hit = Math.max(hit, mover.impact, parked.impact);
  }
  const pushed = track.delta(before, parked.loc.s);
  console.log(`collision: parked car pushed ${pushed.toFixed(1)} m, impact ${hit.toFixed(1)}`);
  if (pushed < 3) fail('cars do not collide');
}

console.log(ok ? 'PASS' : 'FAILED');
process.exit(ok ? 0 : 1);
