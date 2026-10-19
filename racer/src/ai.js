// AI driver: aims at a point ahead on the racing line and brakes for the
// tightest corner coming up. `skill` (0.8–1) scales corner speed.

export function aiInput(car, track, skill = 0.92, laneOffset = 0) {
  const speed = car.forwardSpeed;
  const loc = car.loc || track.locate(car.x, car.z);
  const look = 7 + Math.max(0, speed) * 0.45;
  const p = track.pointAt(loc.s + look, laneOffset);
  const want = Math.atan2(p.x - car.x, p.z - car.z);
  let diff = want - car.h;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  // diff > 0 means the target is to the left; input steer > 0 is right
  const steer = Math.max(-1, Math.min(1, -diff * 2.6));

  // slowest corner within braking distance
  let vTarget = 90;
  const horizon = 30 + speed * speed / 14;
  for (let d = 0; d < horizon; d += 4) {
    const i = track.wrap(Math.floor((loc.s + d) / track.step));
    const k = Math.abs(track.curv[i]);
    if (k < 1e-4) continue;
    const vCorner = Math.sqrt(1.15 * 9.81 / k) * skill;
    const reachable = Math.sqrt(vCorner * vCorner + 2 * 11 * d);     // can still brake down to it
    vTarget = Math.min(vTarget, reachable);
  }
  const off = Math.abs(loc.lat) > 7.5;                                   // on the grass: steady
  const throttle = speed < vTarget - 1 ? (off ? 0.6 : 1) : speed < vTarget + 1 ? 0.3 : 0;
  const brake = speed > vTarget + 3 ? Math.min(1, (speed - vTarget) / 10) : 0;
  return { throttle, brake, steer, handbrake: false };
}
