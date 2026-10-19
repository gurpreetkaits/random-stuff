# random-stuff

Browser games built with three.js, with the 3D models made in Blender.

## [Ridgeline GP](racer/)

A 3D circuit racer for 2–8 friends online, or you against 5 AI drivers. Real rigid-body car physics (Rapier): suspension, tyre grip, a 6-speed gearbox, drifting with the handbrake, and cars that collide with each other.

```sh
cd racer && npm install && npm start
```

## [Hill Climb](hill-climb/)

A side-on hill-climb driving game: balance the buggy over endless hills, collect coins, and grab fuel cans before the tank runs dry. Solo, or race friends online to a finish line.

```sh
cd hill-climb && npm install && npm start
```

Solo mode also works by opening `hill-climb/index.html` straight from disk.

Both servers print a same-Wi-Fi address for friends. To race over the internet, run `ngrok http 3000` and share the link.
