import { Track } from './track.js';
import { Physics, Car, RemoteBody, DT, initPhysics } from './car.js';
import { aiInput } from './ai.js';
import { World, carVisual, gridSlot } from './scene.js';
import { CarAudio } from './audio.js';
import { Net } from './net.js';

const SEND_EVERY = 0.05;
const IDLE_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const INTERP_DELAY = 110;
const BOT_COLORS = ['#1f5fd1', '#f2b705', '#17a34a', '#e8e8ea', '#7c3aed', '#f97316', '#111418'];
const BOT_NAMES = ['Kai', 'Mira', 'Dev', 'Lena', 'Rafa', 'Yuki', 'Omar'];
const $ = id => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem('rr_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rr_' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

const track = new Track();
let phys = null;                         // created once Rapier has loaded
const world = new World($('c'), track);
const audio = new CarAudio();
audio.muted = store.get('muted', false);

// mode: solo | online ; state: loading | menu | lobby | countdown | race | finished | results
const game = {
  mode: 'solo', state: 'loading', paused: false,
  laps: 3, car: null, progress: 0, lastS: 0, lapStart: 0, lapTimes: [], raceTime: 0, finishTime: null,
  best: store.get('bestLap', null), wrongWay: 0, sendTimer: 0, countdown: 0, myColor: '#c8102e',
  bots: [], remotes: new Map(), room: null, host: null, players: [], results: null,
};
const net = new Net(onNet, status => { if (status === 'closed' && game.mode === 'online') toMenu('Lost connection to the race server.'); });

// ---------------------------------------------------------------- input
const keys = new Set();
const touch = { throttle: 0, brake: 0, left: 0, right: 0 };
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
let kbSteer = 0;

function readInput(dt) {
  const k = c => keys.has(c);
  let throttle = k('KeyW') || k('ArrowUp') ? 1 : 0;
  let brake = k('KeyS') || k('ArrowDown') ? 1 : 0;
  // keyboard steering ramps in so taps make small corrections
  const want = (k('KeyD') || k('ArrowRight') || touch.right ? 1 : 0) - (k('KeyA') || k('ArrowLeft') || touch.left ? 1 : 0);
  kbSteer += Math.max(-dt * 5, Math.min(dt * 5, want - kbSteer));
  if (!want && Math.abs(kbSteer) < 0.05) kbSteer = 0;
  let steer = kbSteer;
  let handbrake = k('Space');
  throttle = Math.max(throttle, touch.throttle); brake = Math.max(brake, touch.brake);
  // gamepad: RT throttle, LT brake, left stick steer, A handbrake
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;
    const rt = p.buttons[7]?.value || 0, lt = p.buttons[6]?.value || 0, ax = p.axes[0] || 0;
    if (rt > 0.05) throttle = Math.max(throttle, rt);
    if (lt > 0.05) brake = Math.max(brake, lt);
    if (Math.abs(ax) > 0.08) steer = Math.sign(ax) * ((Math.abs(ax) - 0.08) / 0.92) ** 1.4;
    if (p.buttons[0]?.pressed) handbrake = true;
    padButtons(p);
  }
  Object.assign(input, { throttle, brake, steer, handbrake });
  game.rawThrottle = throttle;              // lets you rev on the grid
  if (!driving()) Object.assign(input, { throttle: 0, brake: game.state === 'finished' ? 0.3 : 0, steer: game.state === 'finished' ? steer : 0, handbrake: false });
}

const padPrev = {};
function padButtons(p) {
  const edge = i => { const now = !!p.buttons[i]?.pressed, was = padPrev[i]; padPrev[i] = now; return now && !was; };
  if (edge(3)) world.cycleCamera();
  if (edge(1) && game.state === 'race') resetToTrack();
  if (edge(9) && game.mode === 'solo' && game.state === 'race') game.paused = !game.paused;
}

const driving = () => game.state === 'race';

window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) { if (e.code === 'Enter' && e.target.id === 'codeInput') joinRoom(); return; }
  keys.add(e.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyC') world.cycleCamera();
  if (e.code === 'KeyR' && game.state === 'race') resetToTrack();
  if (e.code === 'KeyM') { audio.setMuted(!audio.muted); store.set('muted', audio.muted); }
  if ((e.code === 'KeyP' || e.code === 'Escape') && game.mode === 'solo' && game.state === 'race') game.paused = !game.paused;
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
for (const [id, key] of [['tLeft', 'left'], ['tRight', 'right'], ['tGas', 'throttle'], ['tBrake', 'brake']]) {
  const el = $(id);
  el.addEventListener('pointerdown', e => { e.preventDefault(); audio.resume(); touch[key] = 1; el.classList.add('on'); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, () => { touch[key] = 0; el.classList.remove('on'); });
}

// ---------------------------------------------------------------- race setup
// replace the local car (old bodies must leave the physics world)
function setMyCar(r) {
  if (game.car && game.car !== r.car) game.car.remove();
  Object.assign(game, { car: r.car, progress: r.progress, lastS: r.lastS });
}

function placeOnGrid(car, slot) {
  const g = gridSlot(slot);
  car.reset(g.s, g.lat);
  return g.s;
}

function newRacer(slot) {
  const car = new Car(phys);
  const s0 = placeOnGrid(car, slot);
  return { car, progress: s0, lastS: car.loc.s, lapTimes: [], lapStart: 0, finishTime: null };
}

function beginCountdown(ms) {
  game.countdown = ms / 1000;
  game.state = 'countdown';
  game.raceTime = 0; game.finishTime = null; game.lapTimes = []; game.lapStart = 0; game.wrongWay = 0;
  game.lastLight = 0;
  world.setStartLights(0);
  world.camInit = false;
  show(null);
  $('hud').hidden = false;
}

async function startSolo() {
  await audio.init(); audio.resume();
  if (game.mode === 'online') leaveOnline();
  game.mode = 'solo';
  game.laps = +($('soloLaps').value || 3);
  world.clearRemotes();
  game.myColor = '#c8102e';
  world.setPlayerColor(game.myColor);
  // you start mid-pack so there's someone to chase
  const me = newRacer(3);
  setMyCar(me);
  clearBots();
  const slots = [0, 1, 2, 4, 5];
  slots.forEach((slot, k) => {
    const r = newRacer(slot);
    r.id = 'bot' + k; r.name = BOT_NAMES[k]; r.color = BOT_COLORS[k];
    r.skill = 0.84 + k * 0.025 + Math.random() * 0.02;
    r.line = (Math.random() - 0.5) * 2.5;
    r.rig = world.addRemote(r.id, r.color);
    r.tag = makeTag(r.name, r.color);
    game.bots.push(r);
  });
  buildMinimapDots();
  beginCountdown(5800);
}

// ---------------------------------------------------------------- online
function playerName() {
  const n = $('nameInput').value.trim().slice(0, 14);
  store.set('name', n);
  return n || 'Driver';
}

async function connect() {
  setMenuMsg('Connecting…');
  try { await net.connect(); setMenuMsg(''); return true; }
  catch (e) { setMenuMsg(e.message + ' Start it with "npm start".'); return false; }
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
    case 'results': showResults(m.rows); break;
    case 'left': {
      const r = game.remotes.get(m.id);
      if (r) { toast(`${r.name} left the race`); removeRemote(m.id); }
      break;
    }
  }
}

function onLobby(m) {
  game.mode = 'online';
  game.room = m.room; game.host = m.host; game.laps = m.laps; game.players = m.players;
  if (m.phase !== 'lobby') return;
  clearBots();
  if (game.state !== 'lobby') {
    clearRemotesAll();
    const me = m.players.find(p => p.id === net.id);
    game.myColor = me ? me.color : game.myColor;
    world.setPlayerColor(game.myColor);
    const slot = Math.max(0, m.players.findIndex(p => p.id === net.id));
    const r = newRacer(slot);
    setMyCar(r);
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
  $('lobbyPlayers').replaceChildren(...game.players.map((p, i) => {
    const li = document.createElement('li');
    const slot = document.createElement('span'); slot.className = 'slot'; slot.textContent = 'P' + (i + 1);
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = p.color;
    const name = document.createElement('span'); name.textContent = p.name + (p.id === net.id ? ' (you)' : '');
    li.append(slot, dot, name);
    if (p.id === game.host) { const h = document.createElement('em'); h.textContent = 'host'; li.append(h); }
    return li;
  }));
  for (const b of document.querySelectorAll('#lapPick button')) {
    b.setAttribute('aria-pressed', String(+b.dataset.laps === game.laps));
    b.disabled = !isHost;
  }
  $('startRace').hidden = !isHost;
  $('lobbyWait').hidden = isHost;
  $('lobbyHint').textContent = game.players.length < 2 ? 'Share the code. You can also start alone to learn the track.' : `${game.players.length} drivers on the grid.`;
}

function onCountdown(m) {
  game.laps = m.laps; game.players = m.players;
  clearRemotesAll();
  const slot = Math.max(0, m.players.findIndex(p => p.id === net.id));
  const me = newRacer(slot);
  setMyCar(me);
  for (const p of m.players) if (p.id !== net.id) addRemote(p);
  buildMinimapDots();
  beginCountdown(m.ms);
}

function addRemote(p) {
  game.remotes.set(p.id, { id: p.id, name: p.name, color: p.color, rig: world.addRemote(p.id, p.color),
    body: new RemoteBody(phys), buf: [], progress: -100, lap: 0, finished: null, tag: makeTag(p.name, p.color) });
}

function removeRemote(id) {
  const r = game.remotes.get(id);
  if (!r) return;
  r.tag.remove();
  r.body.remove();
  world.removeRemote(id);
  game.remotes.delete(id);
  buildMinimapDots();
}

function clearRemotesAll() { for (const id of [...game.remotes.keys()]) removeRemote(id); }
function clearBots() { for (const b of game.bots) { world.removeRemote(b.id); b.tag.remove(); b.car.remove(); } game.bots = []; }

function onRemoteState(m) {
  const r = game.remotes.get(m.id);
  if (!r) return;
  r.buf.push({ t: performance.now(), s: m.s });
  if (r.buf.length > 30) r.buf.shift();
  r.progress = m.p; r.lap = m.lap;
}

function onFinished(m) {
  if (m.id === net.id) { game.place = m.place; return; }
  const r = game.remotes.get(m.id);
  if (r) r.finished = m.place;
  toast(`${m.name} finished ${ordinal(m.place)} · ${fmt(m.time)}`);
}

function leaveOnline() { net.send({ t: 'leave' }); clearRemotesAll(); game.room = null; }

function toMenu(msg) {
  if (game.mode === 'online') leaveOnline();
  clearBots(); clearRemotesAll();
  game.mode = 'solo'; game.paused = false;
  game.state = 'menu';
  const r = newRacer(3);
  setMyCar(r);
  world.setStartLights(0);
  $('hud').hidden = true;
  $('sBest').textContent = game.best ? fmt(game.best) : '–';
  show('startScreen');
  setMenuMsg(msg || '');
}

// ---------------------------------------------------------------- race logic
function trackProgress(r) {
  const d = track.delta(r.lastS, r.car.loc.s);
  r.progress += d;
  r.lastS = r.car.loc.s;
  return d;
}

function resetToTrack() {
  const s = game.car.loc.s;
  game.car.reset(s, 0);
  game.lastS = game.car.loc.s;
  toast('Back on track');
}

function lapOf(progress) { return Math.max(1, Math.floor(progress / track.length) + 1); }

function updateRace(dt) {
  if (game.state === 'countdown') {
    game.countdown -= dt;
    const lit = Math.min(5, Math.floor(5.8 - game.countdown));
    if (lit !== game.lastLight && lit >= 1 && game.countdown > 0.8) { game.lastLight = lit; world.setStartLights(lit); audio.countBeep(false); }
    renderLights(game.countdown > 0.8 ? lit : 0);
    if (game.countdown <= 0) {
      game.state = 'race';
      world.setStartLights(0);
      audio.countBeep(true);
      flash('GO!');
    }
    return;
  }
  if (game.state !== 'race' && game.state !== 'finished') return;
  game.raceTime += dt;

  // my laps
  const me = game;
  const before = Math.floor(me.progress / track.length);
  trackProgress(me);
  const after = Math.floor(me.progress / track.length);
  if (after > before && after >= 1 && game.state === 'race') {
    const lapTime = game.raceTime - game.lapStart;
    game.lapStart = game.raceTime;
    game.lapTimes.push(lapTime);
    const pb = !game.best || lapTime < game.best;
    if (pb) { game.best = lapTime; store.set('bestLap', lapTime); }
    if (after >= game.laps) finishMe();
    else {
      toast(`Lap ${after} · ${fmt(lapTime)}${pb ? ' · best lap!' : ''}`);
      if (after === game.laps - 1) flash('FINAL LAP');
    }
  }

  // wrong way: moving against the track direction
  const along = game.car.vx * game.car.loc.tx + game.car.vz * game.car.loc.tz;
  game.wrongWay = along < -2 ? game.wrongWay + dt : 0;

  // bots (solo)
  for (const b of game.bots) {
    const bBefore = Math.floor(b.progress / track.length);
    trackProgress(b);
    // AI recovery: stuck against a wall or facing the wrong way → back on track
    const bAlong = b.car.vx * b.car.loc.tx + b.car.vz * b.car.loc.tz;
    b.stuck = (b.car.speed < 3 || bAlong < -1) && b.finishTime == null ? (b.stuck || 0) + dt : 0;
    if (b.stuck > 2.5 || b.car.flipped > 1.5) { b.car.reset(b.car.loc.s, b.line); b.lastS = b.car.loc.s; b.stuck = 0; }
    if (b.finishTime == null && Math.floor(b.progress / track.length) > bBefore && b.progress >= game.laps * track.length) {
      b.finishTime = game.raceTime;
      b.place = 1 + game.bots.filter(o => o.finishTime != null && o !== b).length + (game.finishTime != null ? 1 : 0);
    }
  }
  if (game.mode === 'solo' && game.state === 'finished' && (game.bots.every(b => b.finishTime != null) || game.raceTime - game.finishTime > 25)) {
    soloResults();
  }

  // network
  if (game.mode === 'online') {
    game.sendTimer += dt;
    if (game.sendTimer >= SEND_EVERY) {
      game.sendTimer = 0;
      const c = game.car, q = c.q, r2 = x => Math.round(x * 100) / 100, r4 = x => Math.round(x * 10000) / 10000;
      const braking = input.brake > 0.1 && c.gear !== -1;
      net.send({ t: 'state', s: [r2(c.x), r2(c.y), r2(c.z), r4(q.x), r4(q.y), r4(q.z), r4(q.w), r4(c.steer), r2(c.wheelSpin), braking ? 1 : 0, r2(c.speed)],
        p: Math.round(game.progress * 10) / 10, lap: lapOf(game.progress) });
    }
  }
}

function finishMe() {
  game.state = 'finished';
  game.finishTime = game.raceTime;
  const bestLap = Math.min(...game.lapTimes);
  if (game.mode === 'online') net.send({ t: 'finish', time: Math.round(game.raceTime * 1000) / 1000, best: Math.round(bestLap * 1000) / 1000 });
  else game.place = 1 + game.bots.filter(b => b.finishTime != null).length;
  flash(game.mode === 'solo' && game.place === 1 ? 'YOU WIN!' : 'FINISHED');
  audio.bonus();
}

function soloResults() {
  const rows = [{ id: 'me', name: playerName(), color: game.myColor, time: game.finishTime, progress: game.progress, best: Math.min(...game.lapTimes) },
    ...game.bots.map(b => ({ id: b.id, name: b.name, color: b.color, time: b.finishTime, progress: b.progress, best: null }))];
  rows.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || b.progress - a.progress);
  showResults(rows, 'me');
}

function showResults(rows, meId = net.id) {
  game.state = 'results';
  $('resultsRows').replaceChildren(...rows.map((r, i) => {
    const tr = document.createElement('tr');
    if (r.id === meId) tr.className = 'me';
    const cells = [ordinal(i + 1), r.name, r.time != null ? fmt(r.time) : 'DNF', r.best ? fmt(r.best) : '–'];
    cells.forEach((text, k) => {
      const td = document.createElement('td');
      if (k === 1) { const d = document.createElement('span'); d.className = 'dot'; d.style.background = r.color; td.append(d); }
      td.append(text);
      tr.append(td);
    });
    return tr;
  }));
  const winner = rows[0];
  $('resultsTitle').textContent = winner && winner.id === meId && winner.time != null ? 'Victory!' : winner && winner.time != null ? `${winner.name} wins` : 'Race over';
  const online = game.mode === 'online', isHost = game.host === net.id;
  $('rematch').hidden = online && !isHost;
  $('rematch').textContent = online ? 'Back to lobby' : 'Race again';
  $('resultsWait').hidden = !online || isHost;
  show('resultsScreen');
}

// ---------------------------------------------------------------- remotes
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
        const dot = a.s[3] * b.s[3] + a.s[4] * b.s[4] + a.s[5] * b.s[5] + a.s[6] * b.s[6];
        const sign = dot < 0 ? -1 : 1;                       // take the short way round
        s = a.s.map((v, j) => (j >= 3 && j <= 6 ? v + (b.s[j] * sign - v) * k : v + (b.s[j] - v) * k));
        const n = Math.hypot(s[3], s[4], s[5], s[6]) || 1;
        for (let j = 3; j <= 6; j++) s[j] /= n;
      }
      const last = buf[buf.length - 1], prev = buf[buf.length - 2] || last;
      const span = Math.max(1, last.t - prev.t) / 1000;
      r.vx = (last.s[0] - prev.s[0]) / span; r.vz = (last.s[2] - prev.s[2]) / span;
    }
    const q = { x: s[3], y: s[4], z: s[5], w: s[6] };
    r.state = { x: s[0], y: s[1], z: s[2], q, steer: s[7], spin: s[8], brake: s[9] > 0.5 };
    r.rig.sync(r.state);
    r.body.set(s[0], s[1], s[2], q);
    r.rig.root.visible = true;
  }
}

// ---------------------------------------------------------------- HUD
function makeTag(name, color) {
  const el = document.createElement('div');
  el.className = 'tag';
  el.style.setProperty('--c', color);
  el.textContent = name;
  $('tags').appendChild(el);
  return el;
}

function ordinal(n) { return n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'); }
function fmt(s) { if (s == null || !isFinite(s)) return '–'; const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r.toFixed(2).padStart(5, '0')}`; }

let toastTimer = 0;
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; toastTimer = 2.6; }
function flash(text) {
  const el = $('flash');
  el.textContent = text;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}
function renderLights(n) {
  $('lights').hidden = game.state !== 'countdown';
  [...$('lights').children].forEach((l, i) => l.classList.toggle('on', i < n));
}
function setMenuMsg(t) { $('menuMsg').textContent = t; $('menuMsg').hidden = !t; }
function show(id) { for (const s of ['startScreen', 'lobbyScreen', 'resultsScreen']) $(s).hidden = s !== id; }

function standings() {
  const DONE = 1e9;   // finished cars rank by finishing place, ahead of everyone still racing
  const list = [{ id: 'me', progress: game.state === 'finished' ? DONE - (game.place || 0) : game.progress }];
  for (const b of game.bots) list.push({ id: b.id, progress: b.finishTime != null ? DONE - b.place : b.progress });
  for (const r of game.remotes.values()) list.push({ id: r.id, progress: r.finished ? DONE - r.finished : r.progress });
  list.sort((a, b) => b.progress - a.progress);
  return { pos: list.findIndex(x => x.id === 'me') + 1, of: list.length };
}

// minimap
const mm = $('minimap'), mg = mm.getContext('2d');
let mmPath = null, mmTf = null;
function buildMinimapDots() { mmPath = null; }
function drawMinimap() {
  const dpr = Math.min(2, window.devicePixelRatio || 1), S = 170;
  if (mm.width !== S * dpr) { mm.width = mm.height = S * dpr; mmPath = null; }
  mg.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!mmPath) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < track.count; i++) { minX = Math.min(minX, track.x[i]); maxX = Math.max(maxX, track.x[i]); minZ = Math.min(minZ, track.z[i]); maxZ = Math.max(maxZ, track.z[i]); }
    const sc = (S - 24) / Math.max(maxX - minX, maxZ - minZ);
    mmTf = (x, z) => [S / 2 + (x - (minX + maxX) / 2) * sc, S / 2 + (z - (minZ + maxZ) / 2) * sc];
    mmPath = new Path2D();
    for (let i = 0; i <= track.count; i++) {
      const [px, py] = mmTf(track.x[i % track.count], track.z[i % track.count]);
      if (i) mmPath.lineTo(px, py); else mmPath.moveTo(px, py);
    }
  }
  mg.clearRect(0, 0, S, S);
  mg.lineJoin = 'round';
  mg.strokeStyle = 'rgba(0,0,0,.5)'; mg.lineWidth = 9; mg.stroke(mmPath);
  mg.strokeStyle = '#e9e6dc'; mg.lineWidth = 4; mg.stroke(mmPath);
  const [sx, sy] = mmTf(track.x[0], track.z[0]);
  mg.fillStyle = '#111'; mg.fillRect(sx - 2, sy - 6, 4, 12);
  const dot = (x, z, color, r) => { const [px, py] = mmTf(x, z); mg.fillStyle = color; mg.beginPath(); mg.arc(px, py, r, 0, 7); mg.fill(); mg.strokeStyle = '#fff'; mg.lineWidth = 1.5; mg.stroke(); };
  for (const b of game.bots) dot(b.car.x, b.car.z, b.color, 4);
  for (const r of game.remotes.values()) if (r.state) dot(r.state.x, r.state.z, r.color, 4.5);
  dot(game.car.x, game.car.z, game.myColor, 6);
}

// speedometer
const sp = $('speedo'), sg = sp.getContext('2d');
function drawSpeedo(kmh, gear, rpm) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = 240, H = 150;
  if (sp.width !== W * dpr) { sp.width = W * dpr; sp.height = H * dpr; }
  sg.setTransform(dpr, 0, 0, dpr, 0, 0);
  sg.clearRect(0, 0, W, H);
  const cx = 120, cy = 128, R = 104, a0 = Math.PI * 0.95, a1 = Math.PI * 2.05;
  const frac = Math.min(1, rpm / 8000), red = 7000 / 8000;
  sg.lineCap = 'butt';
  for (let i = 0; i < 40; i++) {
    const f = i / 40, a = a0 + (a1 - a0) * f, b = a + (a1 - a0) / 40 * 0.7;
    sg.strokeStyle = f < frac ? (f > red ? '#ff3b30' : f > 0.7 ? '#ffd166' : '#ffffff') : 'rgba(255,255,255,.14)';
    sg.lineWidth = 12;
    sg.beginPath(); sg.arc(cx, cy, R, a, b); sg.stroke();
  }
  sg.fillStyle = '#fff'; sg.textAlign = 'center'; sg.textBaseline = 'alphabetic';
  sg.font = '700 64px "Rajdhani", "Arial Narrow", sans-serif';
  sg.fillText(kmh, cx, cy - 18);
  sg.font = '600 15px "Rajdhani", "Arial Narrow", sans-serif'; sg.fillStyle = 'rgba(255,255,255,.7)';
  sg.fillText('KM/H', cx, cy);
  sg.font = '700 30px "Rajdhani", "Arial Narrow", sans-serif'; sg.fillStyle = rpm > 7000 ? '#ff3b30' : '#ffd166';
  sg.fillText(gear, cx + 82, cy - 2);
}

function updateHUD(dt) {
  const c = game.car;
  drawSpeedo(Math.round(c.speed * 3.6), c.gear === -1 ? 'R' : c.speed < 0.5 && !input.throttle ? 'N' : String(c.gear), c.rpm);
  drawMinimap();
  const racing = ['countdown', 'race', 'finished'].includes(game.state);
  if (racing) {
    const { pos, of } = standings();
    $('pos').textContent = pos; $('posOf').textContent = '/' + of;
    $('lap').textContent = `LAP ${Math.min(game.laps, lapOf(game.progress))}/${game.laps}`;
    $('tCur').textContent = fmt(game.state === 'finished' ? game.finishTime : Math.max(0, game.raceTime - game.lapStart));
    $('tBest').textContent = fmt(game.lapTimes.length ? Math.min(...game.lapTimes) : null);
    $('tLast').textContent = fmt(game.lapTimes[game.lapTimes.length - 1]);
    $('wrong').hidden = game.wrongWay < 1;
  }
  $('paused').hidden = !game.paused;
  if (game.state !== 'countdown') $('lights').hidden = true;
  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').hidden = true; }

  // name tags above other cars
  const tags = [...game.bots.map(b => ({ tag: b.tag, x: b.car.x, y: b.car.y, z: b.car.z })),
    ...[...game.remotes.values()].map(r => ({ tag: r.tag, x: r.state?.x, y: r.state?.y, z: r.state?.z }))];
  for (const t of tags) {
    if (t.x == null || !racing) { t.tag.hidden = true; continue; }
    const d = Math.hypot(t.x - c.x, t.z - c.z);
    const p = world.project(t.x, t.y + 1.9, t.z);
    if (p.behind || d > 150 || p.x < 0 || p.x > world.width) { t.tag.hidden = true; continue; }
    t.tag.hidden = false;
    t.tag.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%) scale(${Math.max(0.6, 1 - d / 200)})`;
  }
}

// ---------------------------------------------------------------- loop
let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game.state !== 'loading') {
    readInput(dt);
    if (!game.paused) {
      acc += dt;
      updateRemotes(now);                          // online cars move first so we can hit them
      const racing = game.state === 'race' || game.state === 'finished';
      let impact = 0;
      while (acc >= DT) {
        const drivers = [[game.car, input]];
        for (const b of game.bots) drivers.push([b.car, racing ? aiInput(b.car, track, b.skill, b.line) : IDLE_INPUT]);
        phys.step(drivers);
        impact = Math.max(impact, game.car.impact);
        acc -= DT;
      }
      if (impact > 1.5) { audio.impact(impact / 15); world.addShake(Math.min(1, impact / 12)); }
      if (game.car.flipped > 2 && game.state === 'race') resetToTrack();
      updateRace(dt);
      for (const b of game.bots) b.rig.sync(carVisual(b.car, { brake: 0 }));
      world.update(game.car, input, dt);
      const shifted = game.car.shifted || 0; game.car.shifted = 0;
      audio.update(dt, {
        rpm: game.state === 'countdown' ? 950 + game.rawThrottle * 6500 : game.car.rpm, throttle: game.state === 'countdown' ? game.rawThrottle : input.throttle, slide: Math.max(game.car.slipR * 0.9, game.car.wheelspin * 0.8, input.handbrake && game.car.speed > 5 ? 0.6 : 0),
        speed: game.car.speed, grass: game.car.surface === 'grass', running: game.state !== 'menu' && game.state !== 'results', shifted,
      });
    }
    updateHUD(dt);
    world.render();
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- wiring
$('soloBtn').addEventListener('click', startSolo);
$('createBtn').addEventListener('click', createRoom);
$('joinBtn').addEventListener('click', joinRoom);
$('startRace').addEventListener('click', () => net.send({ t: 'start' }));
$('leaveLobby').addEventListener('click', () => toMenu());
$('rematch').addEventListener('click', () => (game.mode === 'online' ? net.send({ t: 'lobby' }) : startSolo()));
$('leaveResults').addEventListener('click', () => toMenu());
for (const b of document.querySelectorAll('#lapPick button')) b.addEventListener('click', () => net.send({ t: 'laps', laps: +b.dataset.laps }));
$('copyCode').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(`${location.origin}/?join=${game.room}`); $('copyCode').textContent = 'Copied'; }
  catch { $('copyCode').textContent = 'Select the link to copy'; }
  setTimeout(() => { $('copyCode').textContent = 'Copy invite link'; }, 1600);
});
$('codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
window.addEventListener('resize', () => world.resize(window.innerWidth, window.innerHeight));

(async () => {
  world.resize(window.innerWidth, window.innerHeight);
  try {
    await initPhysics();
    phys = new Physics(track);
    await world.load();
  } catch (err) {
    $('loading').textContent = 'Could not load the 3D models: ' + err.message;
    return;
  }
  $('nameInput').value = store.get('name', '');
  const online = Net.available();
  for (const id of ['createBtn', 'joinBtn', 'codeInput']) $(id).disabled = !online;
  $('offlineNote').hidden = online;
  const code = new URLSearchParams(location.search).get('join');
  if (code) $('codeInput').value = code.toUpperCase().slice(0, 4);
  $('loading').hidden = true;
  toMenu();
  requestAnimationFrame(frame);
})();

window.__rr = { game, world, track, audio, net, startSolo, createRoom, joinRoom, input, get phys() { return phys; } };
