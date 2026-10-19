import { Car, groundY, PX_PER_M, START_X, SUB } from './physics.js';
import { World, LANE_Z } from './scene.js';
import { CarAudio } from './audio.js';
import { Net } from './net.js';

const FUEL_DRAIN = 3.3;          // % per second
const M = 1 / PX_PER_M;
const SEND_EVERY = 0.05;         // car state to the server, seconds
const INTERP_DELAY = 120;        // ms behind the newest opponent snapshot
const RESPAWN_DELAY = 1.6;
const $ = id => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem('hc_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hc_' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

// mode: solo | race
// state: loading | menu | play | ending | over            (solo)
//        lobby | countdown | race | finished | results    (race)
const game = {
  mode: 'solo', state: 'loading', paused: false,
  input: { gas: false, brake: false },
  best: store.get('best', 0), bank: store.get('bank', 0),
  car: null, fuel: 100, coins: 0, items: [], rand: Math.random,
  nextCoinX: 0, nextFuelX: 0,
  airRot: 0, airTime: 0, prevA: 0, stillTimer: 0, endTimer: 0, endReason: '',
  landDust: 0,
  // race
  room: null, me: null, host: null, players: [], length: 1000, remotes: new Map(),
  countdown: 0, raceTime: 0, sendTimer: 0, respawnTimer: 0, respawnReason: '', finishTime: null, place: null,
  get engineOn() { return ['play', 'race', 'countdown', 'lobby', 'menu'].includes(this.state); },
  get driving() { return this.state === 'play' || (this.state === 'race' && this.respawnTimer === 0); },
};

const world = new World($('c'));
const audio = new CarAudio();
audio.muted = store.get('muted', false);
const net = new Net(onNet, status => {
  if (status === 'closed' && game.mode === 'race') {
    toMenu('Lost connection to the race server.');
  }
});

// ---------------------------------------------------------------- setup
function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function resetRun(seed) {
  game.car = new Car(START_X);
  game.fuel = 100; game.coins = 0;
  for (const it of game.items) world.dropItem(it);
  game.items = [];
  game.rand = seed != null ? mulberry32(seed) : Math.random;
  game.nextCoinX = 700; game.nextFuelX = 2600;
  game.airRot = 0; game.airTime = 0; game.prevA = 0; game.stillTimer = 0; game.endTimer = 0;
  game.raceTime = 0; game.respawnTimer = 0; game.finishTime = null; game.place = null;
  world.resetCamera();
  clearFloaters();
}

function spawnItems(upto) {
  const R = game.rand;
  while (game.nextCoinX < upto) {
    const n = 5 + Math.floor(R() * 6), big = R() < 0.2;
    for (let i = 0; i < n; i++) {
      const x = game.nextCoinX + i * 34;
      game.items.push({ kind: 'coin', x, y: groundY(x) - 40, value: big ? 25 : 5, taken: false });
    }
    game.nextCoinX += n * 34 + 500 + R() * 900;
  }
  while (game.nextFuelX < upto) {
    game.items.push({ kind: 'fuel', x: game.nextFuelX, y: groundY(game.nextFuelX) - 34, taken: false });
    game.nextFuelX += 3000 + game.nextFuelX * 0.25;
  }
}

const distanceOf = x => Math.max(0, Math.floor((x - START_X) / PX_PER_M));
const distance = () => distanceOf(game.car.body.x);

function show(id) {
  for (const s of ['startScreen', 'overScreen', 'lobbyScreen', 'resultsScreen']) $(s).hidden = s !== id;
}

// ---------------------------------------------------------------- solo
async function startSolo() {
  if (game.mode === 'race') leaveRace();
  game.mode = 'solo';
  world.setRaceLayout(false, null);
  world.setFinish(null);
  resetRun(null);
  game.state = 'play'; game.paused = false;
  show(null);
  $('hud').hidden = false;
  $('raceHud').hidden = true;
  await audio.init();
  audio.resume();
  audio.gear = 0;
}

function endSolo(reason, delay, crashed) {
  game.state = 'ending'; game.endReason = reason; game.endTimer = delay;
  releaseInput();
  if (crashed) crashFx(); else audio.outOfFuel();
}

function showOver() {
  game.state = 'over';
  const d = distance();
  const record = d > game.best;
  if (record) { game.best = d; store.set('best', d); }
  game.bank += game.coins; store.set('bank', game.bank);
  $('overReason').textContent = game.endReason;
  $('oDist').textContent = d + ' m';
  $('oCoins').textContent = game.coins;
  $('oBest').textContent = game.best + ' m';
  $('oRecord').hidden = !record;
  show('overScreen');
  $('againBtn').focus();
}

function crashFx() { audio.crash(); world.addShake(0.6); game.landDust = 1; }

// ---------------------------------------------------------------- race: network
function playerName() {
  const n = $('nameInput').value.trim().slice(0, 14);
  store.set('name', n);
  return n || 'Driver';
}

async function connect() {
  setMenuMsg('Connecting…');
  try { await net.connect(); setMenuMsg(''); return true; }
  catch (e) { setMenuMsg(e.message + ' Is it running? Start it with "npm start".'); return false; }
}

async function createRoom() {
  await audio.init(); audio.resume();
  if (await connect()) net.send({ t: 'create', name: playerName() });
}

async function joinRoom() {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) { setMenuMsg('Enter the 4-letter room code your friend sees.'); $('codeInput').focus(); return; }
  await audio.init(); audio.resume();
  if (await connect()) net.send({ t: 'join', room: code, name: playerName() });
}

function onNet(m) {
  switch (m.t) {
    case 'error': setMenuMsg(m.msg); break;
    case 'lobby': onLobby(m); break;
    case 'countdown': onCountdown(m); break;
    case 'state': onRemoteState(m); break;
    case 'finished': onFinished(m); break;
    case 'results': onResults(m); break;
    case 'left': {
      const r = game.remotes.get(m.id);
      if (r) { toast(r.name + ' left the race'); removeRemote(m.id); }
      break;
    }
    case 'menu': break;
  }
}

function onLobby(m) {
  const wasIn = game.mode === 'race';
  game.mode = 'race';
  game.room = m.room; game.host = m.host; game.length = m.length; game.players = m.players;
  game.me = net.id;
  if (m.phase !== 'lobby') return;
  const me = m.players.find(p => p.id === net.id);
  if (!wasIn || game.state !== 'lobby') {
    world.setRaceLayout(true, me ? me.color : null);
    world.setFinish(null);
    clearRemotes();
    resetRun(null);
    for (const it of game.items) world.dropItem(it);
    game.items = [];
    game.nextCoinX = game.nextFuelX = Infinity;     // no pickups until the race starts
  }
  game.state = 'lobby';
  $('hud').hidden = true;
  renderLobby();
  show('lobbyScreen');
}

function renderLobby() {
  const isHost = game.host === net.id;
  $('roomCode').textContent = game.room;
  $('roomLink').textContent = `${location.origin}/?join=${game.room}`;
  const list = $('lobbyPlayers');
  list.replaceChildren(...game.players.map(p => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.style.background = p.color;
    const name = document.createElement('span');
    name.textContent = p.name + (p.id === net.id ? ' (you)' : '');
    li.append(dot, name);
    if (p.id === game.host) { const h = document.createElement('em'); h.textContent = 'host'; li.append(h); }
    return li;
  }));
  for (const b of document.querySelectorAll('#trackPick button')) {
    b.setAttribute('aria-pressed', String(+b.dataset.len === game.length));
    b.disabled = !isHost;
  }
  $('startRace').hidden = !isHost;
  $('lobbyWait').hidden = isHost;
  $('lobbyHint').textContent = game.players.length < 2
    ? 'Waiting for your friend to join. You can also start alone to try the track.'
    : `${game.players.length} drivers ready.`;
}

function onCountdown(m) {
  game.length = m.length;
  game.players = m.players;
  const me = m.players.find(p => p.id === net.id);
  world.setRaceLayout(true, me ? me.color : null);
  world.setFinish(m.length);
  clearRemotes();
  for (const p of m.players) if (p.id !== net.id) addRemote(p);
  resetRun(m.seed);
  game.countdown = m.ms / 1000;
  game.lastBeep = null;
  game.state = 'countdown';
  show(null);
  $('hud').hidden = false;
  $('raceHud').hidden = false;
  buildRaceBar();
}

function addRemote(p) {
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.style.setProperty('--c', p.color);
  tag.textContent = p.name;
  $('tags').appendChild(tag);
  game.remotes.set(p.id, { id: p.id, name: p.name, color: p.color, rig: world.addRemote(p.id, p.color),
    buf: [], dist: 0, crashed: false, place: null, time: null, tag });
}

function removeRemote(id) {
  const r = game.remotes.get(id);
  if (!r) return;
  r.tag.remove();
  world.removeRemote(id);
  game.remotes.delete(id);
  buildRaceBar();
}

function clearRemotes() { for (const id of [...game.remotes.keys()]) removeRemote(id); }

function onRemoteState(m) {
  const r = game.remotes.get(m.id);
  if (!r) return;
  r.buf.push({ t: performance.now(), s: m.s });
  if (r.buf.length > 30) r.buf.shift();
  r.dist = m.d;
  r.crashed = m.c;
}

function onFinished(m) {
  if (m.id === net.id) {
    game.place = m.place;
    $('banner').textContent = `FINISHED ${ordinal(m.place)}!`;
    return;
  }
  const r = game.remotes.get(m.id);
  if (r) { r.place = m.place; r.time = m.time; r.dist = game.length; }
  toast(`${m.name} finished ${ordinal(m.place)} in ${fmtTime(m.time)}`);
}

function onResults(m) {
  game.state = 'results';
  releaseInput();
  const tbody = $('resultsRows');
  tbody.replaceChildren(...m.rows.map((r, i) => {
    const tr = document.createElement('tr');
    if (r.id === net.id) tr.className = 'me';
    const cells = [ordinal(i + 1), r.name, r.time != null ? fmtTime(r.time) : `DNF · ${r.dist} m`];
    cells.forEach((text, k) => {
      const td = document.createElement('td');
      if (k === 1) { const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = r.color; td.append(dot); }
      td.append(text);
      tr.append(td);
    });
    return tr;
  }));
  const winner = m.rows[0];
  $('resultsTitle').textContent = winner && winner.id === net.id && winner.time != null ? 'You win!' : winner && winner.time != null ? `${winner.name} wins` : 'Race over';
  const isHost = game.host === net.id;
  $('rematch').hidden = !isHost;
  $('resultsWait').hidden = isHost;
  game.bank += game.coins; store.set('bank', game.bank);
  show('resultsScreen');
}

function leaveRace() {
  net.send({ t: 'leave' });
  clearRemotes();
  game.room = null;
}

function toMenu(msg) {
  if (game.mode === 'race') leaveRace();
  game.mode = 'solo';
  world.setRaceLayout(false, null);
  world.setFinish(null);
  resetRun(null);
  game.state = 'menu';
  $('hud').hidden = true;
  $('raceHud').hidden = true;
  $('sBest').textContent = game.best + ' m';
  $('sBank').textContent = game.bank;
  show('startScreen');
  setMenuMsg(msg || '');
}

// ---------------------------------------------------------------- race: local
function respawn() {
  const cp = Math.floor(distance() / 100) * 100;
  game.car = new Car(START_X + cp * PX_PER_M);
  game.fuel = Math.max(game.fuel, 60);
  game.respawnTimer = 0;
  game.stillTimer = 0;
  game.airRot = 0; game.airTime = 0; game.prevA = 0;
  $('banner').textContent = '';
  toast(cp ? `Back at the ${cp} m checkpoint` : 'Back at the start');
}

function updateRace(dt) {
  const car = game.car, c = car.body;
  if (game.state === 'countdown') {
    game.countdown -= dt;
    const n = Math.ceil(game.countdown);
    if (n !== game.lastBeep && n <= 3 && n >= 0) {
      game.lastBeep = n;
      if (n > 0) audio.countBeep(false);
    }
    $('count').textContent = game.countdown > 0 ? (n > 3 ? '' : n) : '';
    if (game.countdown <= 0) {
      game.state = 'race';
      audio.countBeep(true);
      flashCount('GO!');
    }
    return;
  }
  if (game.state !== 'race' && game.state !== 'finished') return;

  if (game.state === 'race') {
    game.raceTime += dt;
    if (game.respawnTimer > 0) {
      game.respawnTimer = Math.max(0, game.respawnTimer - dt);
      if (game.respawnTimer === 0) respawn();
    } else {
      game.fuel = Math.max(0, game.fuel - FUEL_DRAIN * dt);
      if (car.headHitsGround()) {
        game.respawnTimer = RESPAWN_DELAY; game.respawnReason = 'CRASHED';
        $('banner').textContent = 'CRASHED';
        crashFx(); releaseInput();
      } else if (game.fuel <= 0) {
        game.stillTimer = Math.hypot(c.vx, c.vy) < 25 ? game.stillTimer + dt : 0;
        if (game.stillTimer > 1.2) {
          game.respawnTimer = 0.6; game.respawnReason = 'OUT OF FUEL';
          $('banner').textContent = 'OUT OF FUEL';
          audio.outOfFuel();
        }
      }
    }
    if (c.x >= START_X + game.length * PX_PER_M && game.respawnTimer === 0) {
      game.state = 'finished';
      game.finishTime = game.raceTime;
      net.send({ t: 'finish', time: Math.round(game.raceTime * 1000) / 1000 });
      $('banner').textContent = 'FINISHED!';
      audio.bonus();
      releaseInput();
    }
  }

  game.sendTimer += dt;
  if (game.sendTimer >= SEND_EVERY) {
    game.sendTimer = 0;
    const [w0, w1] = car.wheels, r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;
    net.send({ t: 'state', s: [r1(c.x), r1(c.y), r3(c.a), r1(w0.x), r1(w0.y), r3(w0.a), r1(w1.x), r1(w1.y), r3(w1.a)],
      d: game.state === 'finished' ? game.length : distance(), c: game.respawnTimer > 0 });
  }
}

// opponents: render a little in the past and blend between snapshots
function updateRemotes(now) {
  const t = now - INTERP_DELAY;
  for (const r of game.remotes.values()) {
    const buf = r.buf;
    if (!buf.length) { r.rig.root.visible = false; continue; }
    let s;
    if (buf.length === 1 || t <= buf[0].t) s = buf[0].s;
    else {
      let i = buf.length - 1;
      while (i > 0 && buf[i - 1].t > t) i--;
      const a = buf[Math.max(0, i - 1)], b = buf[i];
      if (t >= b.t) s = b.s;
      else {
        const k = (t - a.t) / Math.max(1, b.t - a.t);
        s = a.s.map((v, j) => v + (b.s[j] - v) * k);
      }
    }
    r.rig.sync({ x: s[0], y: s[1], a: s[2] }, [{ x: s[3], y: s[4], a: s[5] }, { x: s[6], y: s[7], a: s[8] }]);
    r.rig.root.visible = true;
    r.x = s[0]; r.y = s[1];
  }
}

// ---------------------------------------------------------------- shared update
function update(dt) {
  const car = game.car, c = car.body;
  spawnItems(c.x + 4000);
  for (const it of game.items) if (it.x < c.x - 2500 && !it.gone) world.dropItem(it);
  game.items = game.items.filter(it => !it.gone);

  const airborne = car.airborne;
  if (game.driving) {
    if (game.mode === 'solo') game.fuel = Math.max(0, game.fuel - FUEL_DRAIN * dt);

    for (const it of game.items) {
      if (it.taken) continue;
      const near = Math.hypot(it.x - c.x, it.y - c.y) < 62 || car.wheels.some(w => Math.hypot(it.x - w.x, it.y - w.y) < 36);
      if (!near) continue;
      it.taken = true;
      if (it.kind === 'coin') { game.coins += it.value; audio.coin(it.value > 5); }
      else { game.fuel = 100; audio.fuel(); floater('FUEL', it.x, it.y - 30, 'fuel'); }
    }

    // air time & flips
    if (airborne) { game.airRot += c.a - game.prevA; game.airTime += dt; }
    else if (game.airTime > 0) {
      const flips = Math.floor((Math.abs(game.airRot) + 0.6) / (Math.PI * 2));
      if (flips > 0) {
        const b = 100 * flips; game.coins += b; audio.bonus();
        floater((flips > 1 ? flips + '× ' : '') + 'FLIP +' + b, c.x, c.y - 90, 'bonus');
      }
      if (game.airTime > 1.4) {
        const b = Math.round(game.airTime * 20); game.coins += b;
        floater('AIR TIME +' + b, c.x, c.y - 130, 'air');
      }
      game.airRot = 0; game.airTime = 0;
    }

    if (game.mode === 'solo') {
      if (car.headHitsGround()) endSolo('Driver down', 1.8, true);
      else if (game.fuel <= 0) {
        game.stillTimer = Math.hypot(c.vx, c.vy) < 25 ? game.stillTimer + dt : 0;
        if (game.stillTimer > 1.5) endSolo('Out of fuel', 0.4, false);
      }
    }
  } else if (game.state === 'ending') {
    game.endTimer -= dt;
    if (game.endTimer <= 0) showOver();
  }
  game.prevA = c.a;
  if (game.mode === 'race') updateRace(dt);

  // landing / scrape feedback
  if (car.impact > 260) {
    const s = (car.impact - 200) / 700;
    audio.land(s); world.addShake(s * 0.5); game.landDust = s;
  }
  if (car.hullImpact > 120) audio.scrape(car.hullImpact / 500);

  const wheelW = (car.wheels[0].w + car.wheels[1].w) / 2;
  const throttleOn = game.driving && game.fuel > 0;
  const prevGear = audio.gear;
  audio.update(dt, {
    wheelW, gas: game.input.gas && throttleOn, brake: game.input.brake && game.driving,
    grounded: !airborne, speed: Math.hypot(c.vx, c.vy), slip: car.slip,
    running: game.engineOn && game.fuel > 0 && !game.paused && game.state !== 'menu',
  });
  if (audio.gear > prevGear && game.input.gas) world.addShake(0.12);
  car.resetTelemetry();
}

// backfire → flame flash in the exhaust
const origBackfire = audio.backfire.bind(audio);
audio.backfire = () => { origBackfire(); world.backfireFlash(); };

// ---------------------------------------------------------------- HUD
const floaters = [];
function floater(text, x, y, kind) {
  const el = document.createElement('div');
  el.className = 'floater ' + kind;
  el.textContent = text;
  $('floaters').appendChild(el);
  floaters.push({ el, x, y, t: 0 });
}
function clearFloaters() { for (const f of floaters) f.el.remove(); floaters.length = 0; }

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  toastTimer = 3;
}

function flashCount(text) {
  const el = $('count');
  el.textContent = text;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 900);
}

function ordinal(n) { return n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'); }
function fmtTime(s) { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r.toFixed(1).padStart(4, '0')}`; }

function buildRaceBar() {
  const bar = $('raceDots');
  bar.replaceChildren();
  const mine = game.players.find(p => p.id === net.id);
  const mk = (id, color, me) => {
    const d = document.createElement('span');
    d.className = 'pdot' + (me ? ' me' : '');
    d.style.background = color;
    d.dataset.id = id;
    bar.appendChild(d);
  };
  for (const r of game.remotes.values()) mk(r.id, r.color, false);
  mk(net.id, mine ? mine.color : '#d62f26', true);
}

function racePlace() {
  const me = { id: net.id, dist: game.state === 'finished' ? game.length : distance(), place: game.place };
  const all = [me, ...[...game.remotes.values()].map(r => ({ id: r.id, dist: r.dist, place: r.place }))];
  all.sort((a, b) => (a.place ?? 99) - (b.place ?? 99) || b.dist - a.dist);
  return { pos: all.findIndex(p => p.id === net.id) + 1, of: all.length };
}

const tach = $('tach'), tg = tach.getContext('2d');
function drawTach(rpm, gear, kmh) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = 150, H = 96;
  if (tach.width !== W * dpr) { tach.width = W * dpr; tach.height = H * dpr; }
  tg.setTransform(dpr, 0, 0, dpr, 0, 0);
  tg.clearRect(0, 0, W, H);
  const cx = 75, cy = 78, r = 60, a0 = Math.PI * 1.08, a1 = Math.PI * 1.92;
  const ang = v => a0 + (a1 - a0) * Math.min(1, v / 8000);
  tg.lineCap = 'round';
  tg.lineWidth = 9; tg.strokeStyle = 'rgba(255,255,255,.14)';
  tg.beginPath(); tg.arc(cx, cy, r, a0, a1); tg.stroke();
  tg.strokeStyle = '#e8432f';
  tg.beginPath(); tg.arc(cx, cy, r, ang(6500), a1); tg.stroke();
  tg.lineWidth = 2; tg.strokeStyle = 'rgba(255,255,255,.7)';
  for (let k = 0; k <= 8; k++) {
    const a = ang(k * 1000);
    tg.beginPath(); tg.moveTo(cx + Math.cos(a) * (r - 9), cy + Math.sin(a) * (r - 9)); tg.lineTo(cx + Math.cos(a) * (r - 15), cy + Math.sin(a) * (r - 15)); tg.stroke();
  }
  const a = ang(rpm);
  tg.lineWidth = 3.5; tg.strokeStyle = '#ffd84a';
  tg.beginPath(); tg.moveTo(cx, cy); tg.lineTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6)); tg.stroke();
  tg.fillStyle = '#ffd84a'; tg.beginPath(); tg.arc(cx, cy, 5, 0, Math.PI * 2); tg.fill();
  tg.fillStyle = '#fff'; tg.textAlign = 'center';
  tg.font = '800 22px "Baloo 2", "Trebuchet MS", sans-serif';
  tg.fillText(kmh, cx, cy - 18);
  tg.font = '700 10px "Baloo 2", "Trebuchet MS", sans-serif';
  tg.fillStyle = 'rgba(255,255,255,.7)'; tg.fillText('KM/H', cx, cy - 6);
  tg.textAlign = 'left'; tg.fillStyle = '#ffd84a'; tg.font = '800 15px "Baloo 2", "Trebuchet MS", sans-serif';
  tg.fillText(gear, cx + 30, cy + 2);
}

let lowBlink = 0;
function updateHUD(dt) {
  const c = game.car.body;
  const race = game.mode === 'race';
  const d = distance();
  $('dist').textContent = race ? `${Math.min(d, game.length)} / ${game.length} m` : d + ' m';
  $('best').textContent = race ? '' : 'BEST ' + game.best + ' m';
  $('coins').textContent = game.coins;
  $('fuelFill').style.width = game.fuel + '%';
  lowBlink += dt;
  $('fuel').classList.toggle('low', game.fuel < 25 && Math.floor(lowBlink * 4) % 2 === 0);
  const kmh = Math.round(Math.abs(c.vx) * M * 3.6);
  const gear = game.input.brake && c.vx < -5 ? 'R' : String(audio.gear + 1);
  drawTach(audio.rpm, gear, kmh);
  $('sound').textContent = audio.muted ? 'Sound off' : 'Sound on';
  if (!race) $('banner').textContent = game.paused ? 'PAUSED' : (game.state === 'play' && game.fuel <= 0 ? 'OUT OF FUEL' : '');

  if (race) {
    const { pos, of } = racePlace();
    $('racePos').textContent = `${ordinal(pos)} / ${of}`;
    $('raceTime').textContent = fmtTime(game.state === 'finished' && game.finishTime != null ? game.finishTime : game.raceTime);
    const pct = v => Math.max(0, Math.min(100, v / game.length * 100)) + '%';
    for (const dot of $('raceDots').children) {
      const id = +dot.dataset.id;
      const v = id === net.id ? (game.state === 'finished' ? game.length : d) : (game.remotes.get(id)?.dist ?? 0);
      dot.style.left = pct(v);
    }
    // name tags over opponents, pinned to the screen edge when off-screen
    for (const r of game.remotes.values()) {
      if (r.x == null) { r.tag.hidden = true; continue; }
      const p = world.project(r.x * M, -r.y * M + 2.4, -LANE_Z);
      const W = window.innerWidth, edge = 70;
      const gap = Math.round(r.dist - d);
      let label = r.name + (r.crashed ? ' · crashed' : '');
      let x = p.x;
      if (x < edge) { x = edge; label = `◀ ${r.name} ${Math.abs(gap)} m`; }
      else if (x > W - edge) { x = W - edge; label = `${r.name} ${gap} m ▶`; }
      r.tag.textContent = label;
      r.tag.hidden = false;
      r.tag.style.transform = `translate(${x}px, ${Math.max(90, Math.min(window.innerHeight - 40, p.y))}px) translate(-50%, -100%)`;
    }
  }

  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').hidden = true; }

  for (const fl of floaters) {
    fl.t += dt; fl.y -= 50 * dt;
    const p = world.project(fl.x * M, -fl.y * M, 0);
    fl.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) scale(${1 + Math.min(0.3, fl.t)})`;
    fl.el.style.opacity = Math.max(0, 1 - fl.t / 1.6);
  }
  for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].t > 1.6) { floaters[i].el.remove(); floaters.splice(i, 1); }
}

function setMenuMsg(text) { $('menuMsg').textContent = text; $('menuMsg').hidden = !text; }

// ---------------------------------------------------------------- input
const GAS = ['ArrowRight', 'KeyD', 'ArrowUp', 'KeyW'], BRAKE = ['ArrowLeft', 'KeyA', 'ArrowDown', 'KeyS'];
const typing = e => e.target instanceof HTMLInputElement;
function setPedals() {
  $('gas').classList.toggle('active', game.input.gas);
  $('brake').classList.toggle('active', game.input.brake);
}
function releaseInput() { game.input.gas = game.input.brake = false; setPedals(); }

window.addEventListener('keydown', e => {
  if (typing(e)) {
    if (e.code === 'Enter' && e.target.id === 'codeInput') joinRoom();
    return;
  }
  if (GAS.includes(e.code)) { if (game.driving) game.input.gas = true; e.preventDefault(); }
  else if (BRAKE.includes(e.code)) { if (game.driving) game.input.brake = true; e.preventDefault(); }
  else if (e.code === 'KeyP' && game.state === 'play') game.paused = !game.paused;
  else if (e.code === 'KeyM') toggleSound();
  else if (e.code === 'KeyR' && game.mode === 'solo' && ['play', 'ending', 'over'].includes(game.state)) startSolo();
  else if ((e.code === 'Enter' || e.code === 'Space') && game.state === 'over') { e.preventDefault(); startSolo(); }
  setPedals();
});
window.addEventListener('keyup', e => {
  if (GAS.includes(e.code)) game.input.gas = false;
  if (BRAKE.includes(e.code)) game.input.brake = false;
  setPedals();
});
window.addEventListener('blur', releaseInput);

function bindPedal(el, key) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); audio.resume();
    if (game.driving) { game.input[key] = true; setPedals(); }
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    el.addEventListener(ev, e => { e.preventDefault(); game.input[key] = false; setPedals(); });
  }
}
bindPedal($('gas'), 'gas');
bindPedal($('brake'), 'brake');
function toggleSound() { audio.setMuted(!audio.muted); store.set('muted', audio.muted); }
$('sound').addEventListener('click', toggleSound);
$('soloBtn').addEventListener('click', startSolo);
$('createBtn').addEventListener('click', createRoom);
$('joinBtn').addEventListener('click', joinRoom);
$('againBtn').addEventListener('click', startSolo);
$('overMenu').addEventListener('click', () => toMenu());
$('startRace').addEventListener('click', () => net.send({ t: 'start' }));
$('leaveLobby').addEventListener('click', () => toMenu());
$('rematch').addEventListener('click', () => net.send({ t: 'lobby' }));
$('leaveResults').addEventListener('click', () => toMenu());
for (const b of document.querySelectorAll('#trackPick button')) {
  b.addEventListener('click', () => net.send({ t: 'track', length: +b.dataset.len }));
}
$('copyCode').addEventListener('click', async () => {
  const text = `${location.origin}/?join=${game.room}`;
  try { await navigator.clipboard.writeText(text); $('copyCode').textContent = 'Copied'; }
  catch { $('copyCode').textContent = 'Select and copy'; }
  setTimeout(() => { $('copyCode').textContent = 'Copy invite'; }, 1500);
});
$('codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });

// ---------------------------------------------------------------- loop
function resize() { world.resize(window.innerWidth, window.innerHeight); }
window.addEventListener('resize', resize);

let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game.state !== 'loading' && !game.paused) {
    acc += dt;
    const input = game.driving ? { gas: game.input.gas && game.fuel > 0, brake: game.input.brake }
      : game.state === 'finished' ? { gas: false, brake: true } : { gas: false, brake: false };
    while (acc >= SUB) { game.car.step(SUB, input); acc -= SUB; }
    update(dt);
    updateRemotes(now);
    world.update(game, dt, now / 1000);
  }
  if (game.state !== 'loading') {
    updateHUD(dt);
    world.render();
  }
  requestAnimationFrame(frame);
}

(async () => {
  resize();
  try {
    await world.load();
  } catch (err) {
    $('loading').textContent = 'Could not load the 3D models: ' + err.message;
    return;
  }
  $('nameInput').value = store.get('name', '');
  const online = Net.available();
  $('raceBox').classList.toggle('offline', !online);
  for (const id of ['createBtn', 'joinBtn', 'codeInput']) $(id).disabled = !online;
  $('offlineNote').hidden = online;
  $('loading').hidden = true;
  toMenu();
  // ?join=CODE in the link pre-fills the room code
  const code = new URLSearchParams(location.search).get('join');
  if (code) $('codeInput').value = code.toUpperCase().slice(0, 4);
  requestAnimationFrame(frame);
})();

// test hook
window.__hc = { game, world, audio, net, startSolo, createRoom, joinRoom, distance };
