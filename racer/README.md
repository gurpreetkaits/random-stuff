# Ridgeline GP

A 3D circuit racer for 2–8 friends online, or you against 5 AI drivers. Built with three.js and the Rapier physics engine; the cars and scenery are modelled in Blender.

## Play

```sh
npm install
npm start
```

Open the address it prints. Your friends open the same address:

- **Same Wi-Fi:** use the `http://192.168.…:3000` style address the server prints.
- **Over the internet:** run `ngrok http 3000` in another terminal and share the `https://…ngrok…` link.

One player clicks **Create lobby** and shares the 4-letter code (or the invite link). Everyone else enters the code and clicks **Join**. The host picks 1, 3 or 5 laps and starts the race. **Race the AI** works without friends.

### Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle | `W` / `↑` | Right trigger |
| Brake / reverse | `S` / `↓` | Left trigger |
| Steer | `A` `D` / `←` `→` | Left stick |
| Handbrake (drift) | `Space` | A |
| Camera (chase, far, bumper) | `C` | Y |
| Back on track | `R` | B |
| Sound on/off | `M` | |
| Pause (vs AI) | `P` / `Esc` | Start |

Phones get on-screen steering and pedals.

## How it works

- `src/car.js`: real rigid-body physics on Rapier. Each car is a dynamic chassis on four raycast wheels with sprung, damped suspension and per-tyre friction, plus a rear-wheel-drive engine with a torque curve and a 6-speed automatic gearbox, front-biased brakes, a handbrake, aero drag and downforce. Steering and stability assists keep keyboard driving controllable; the handbrake switches the stability assist off for drifts. The road and barrier walls are physics colliders, and cars collide with each other.
- `src/track.js`: the circuit, a closed spline with elevation, plus lookups for where a car is on the track.
- `src/ai.js`: the AI driver: aims along the racing line and brakes for the tightest corner ahead.
- `src/scene.js`: the three.js world: sky, bloom, road, kerbs, walls, terrain, forests, grandstands, start gantry with lights, tyre smoke and skid marks, chase camera.
- `src/audio.js`: synthesized engine (individual exhaust pulses), backfires, tyre squeal, wind and impacts.
- `src/main.js`: race flow, laps, positions, HUD, input and online sync.
- `server/server.js`: serves the game and runs lobbies over WebSocket. Each player simulates their own car and the server relays positions; online opponents are solid kinematic bodies in your physics world. The server times the race itself, so lag doesn't change the result.
- `models/build_models.py`: the Blender script that builds `car.glb` and `props.glb`.

## Development

```sh
npm run models   # rebuild the Blender models (needs Blender in /Applications)
npm run build    # bundle into dist/game.js
npm run dev      # rebuild on save, with source maps
npm test         # headless physics checks: AI laps, 0-100, braking, barriers, collisions
```
