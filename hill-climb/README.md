# Hill Climb

A 3D hill-climb driving game. Open `index.html` in a browser to play; it works straight from disk.

**Controls:** `→`/`D` gas, `←`/`A` brake and reverse (in the air, gas tilts back and brake tilts forward), `P` pause, `M` sound, `R` restart. Touch screens get on-screen pedals.

## How it's built

- `models/build_models.py` is a Blender script that models the buggy, the wheels and all the scenery (trees, rocks, bushes, fences, clouds, coins, fuel can, signposts) and exports `models/car.glb` and `models/props.glb`.
- `src/physics.js` holds the 2D car physics (spring suspension, tyre grip, engine torque, air control). `test/sim.test.js` drives it headlessly.
- `src/scene.js` builds the three.js world: endless terrain chunks that follow the physics track, hills behind it, shadows, dust and exhaust smoke.
- `src/audio.js` synthesizes the car audio: a 4-cylinder engine made of individual exhaust pulses in an AudioWorklet, a 5-speed automatic gearbox, backfires when you lift off at high revs, gravel spray, wind, landings and pickups.
- `src/main.js` runs the game loop, fuel, coins, flips and the HUD.

## Rebuilding

```sh
npm install
npm run models   # re-export the Blender models (needs Blender in /Applications)
npm run build    # bundle into dist/game.js (models are embedded)
npm test         # headless physics check
```
