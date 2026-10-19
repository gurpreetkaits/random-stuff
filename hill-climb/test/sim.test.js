// Headless physics check: the car must stay stable, make progress, and crash when floored.
import { Car, SUB, PX_PER_M, START_X } from '../src/physics.js';

function run(label, secs, policy) {
  const car = new Car();
  let crashedAt = null;
  for (let f = 0; f < secs * 60; f++) {
    const input = policy(car);
    for (let i = 0; i < 10; i++) car.step(SUB, input);
    if (!Number.isFinite(car.body.x)) throw new Error(label + ': physics blew up');
    if (car.headHitsGround()) { crashedAt = f / 60; break; }
  }
  const d = Math.floor((car.body.x - START_X) / PX_PER_M);
  console.log(`${label}: ${d} m${crashedAt != null ? ` (crashed at ${crashedAt.toFixed(1)} s)` : ''}`);
  return { d, crashedAt };
}

const idle = run('idle', 3, () => ({ gas: false, brake: false }));
const floored = run('full gas', 30, () => ({ gas: true, brake: false }));
const careful = run('careful driver', 40, c => ({ gas: c.body.a > -0.6, brake: c.body.a < -0.9 }));

let ok = true;
if (Math.abs(idle.d) > 1 || idle.crashedAt != null) { console.error('FAIL: idle car moved or crashed'); ok = false; }
if (floored.d < 100) { console.error('FAIL: full gas made too little progress'); ok = false; }
if (careful.d < 300) { console.error('FAIL: careful driver should reach 300 m'); ok = false; }
console.log(ok ? 'PASS' : 'FAILED');
process.exit(ok ? 0 : 1);
