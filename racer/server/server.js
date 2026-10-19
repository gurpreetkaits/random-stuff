// Race server: serves the game over HTTP and runs race rooms over WebSocket.
//
//   npm start            → http://localhost:3000 (and your LAN address)
//
// Each player simulates their own car; the server relays car states between
// the players in a room and runs the race: lobby → start lights → race → results.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 8;
const COLORS = ['#c8102e', '#1f5fd1', '#f2b705', '#17a34a', '#e8e8ea', '#7c3aed', '#f97316', '#111418'];
const LAPS = [1, 3, 5];
const COUNTDOWN_MS = 5800;      // five start lights, one per second, then lights out
const FINISH_GRACE_MS = 30000;   // after the winner finishes, others get this long

// ---------------------------------------------------------------- static files
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.map': 'application/json' };
const PUBLIC = new Set(['/index.html', '/dist/game.js']);

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/index.html';
  if (!PUBLIC.has(url)) { res.writeHead(404).end('Not found'); return; }
  fs.readFile(path.join(ROOT, url), (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    const headers = { 'Content-Type': TYPES[path.extname(url)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    // the bundle carries the physics engine and models; gzip makes it far smaller to download
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && data.length > 50000) {
      zlib.gzip(data, (e, gz) => {
        if (e) { res.writeHead(200, headers).end(data); return; }
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' }).end(gz);
      });
      return;
    }
    res.writeHead(200, headers).end(data);
  });
});

// ---------------------------------------------------------------- rooms
const rooms = new Map();
let nextId = 1;

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c));
  return c;
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.ws !== except && p.ws.readyState === 1) p.ws.send(s);
}

function lobbyMsg(room) {
  return {
    t: 'lobby', room: room.code, host: room.host, laps: room.laps, phase: room.phase,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color })),
  };
}

function freeColor(room) {
  const used = new Set([...room.players.values()].map(p => p.color));
  return COLORS.find(c => !used.has(c)) || COLORS[0];
}

function cleanName(n) {
  return String(n || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14) || 'Driver';
}

function finishRace(room) {
  if (room.phase !== 'race') return;
  room.phase = 'results';
  clearTimeout(room.graceTimer);
  const rows = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, color: p.color, time: p.finishTime ?? null, progress: p.progress || 0, best: p.bestLap ?? null,
  }));
  rows.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || b.progress - a.progress);
  broadcast(room, { t: 'results', rows, laps: room.laps });
}

function checkAllFinished(room) {
  const ps = [...room.players.values()];
  if (ps.length && ps.every(p => p.finishTime != null)) finishRace(room);
}

function leave(player) {
  const room = player.room;
  if (!room) return;
  room.players.delete(player.id);
  player.room = null;
  if (room.players.size === 0) { clearTimeout(room.graceTimer); rooms.delete(room.code); return; }
  if (room.host === player.id) room.host = room.players.keys().next().value;
  broadcast(room, { t: 'left', id: player.id });
  broadcast(room, lobbyMsg(room));
  if (room.phase === 'race') checkAllFinished(room);
}

// ---------------------------------------------------------------- sockets
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', ws => {
  const player = { id: nextId++, ws, name: 'Driver', color: COLORS[0], room: null, progress: 0, finishTime: null, bestLap: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { t: 'hello', id: player.id });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const room = player.room;

    switch (m.t) {
      case 'create': {
        leave(player);
        const r = { code: makeCode(), players: new Map(), host: player.id, laps: 3, phase: 'lobby', graceTimer: null };
        rooms.set(r.code, r);
        player.name = cleanName(m.name); player.color = COLORS[0]; player.room = r;
        r.players.set(player.id, player);
        send(ws, lobbyMsg(r));
        break;
      }
      case 'join': {
        const r = rooms.get(String(m.room || '').toUpperCase().trim());
        if (!r) { send(ws, { t: 'error', msg: 'No room with that code. Check the code with your friend.' }); break; }
        if (r.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', msg: `That room is full (${MAX_PLAYERS} drivers).` }); break; }
        if (r.phase !== 'lobby') { send(ws, { t: 'error', msg: 'That race has already started. Join when it is back in the lobby.' }); break; }
        leave(player);
        player.name = cleanName(m.name); player.color = freeColor(r); player.room = r;
        r.players.set(player.id, player);
        broadcast(r, lobbyMsg(r));
        break;
      }
      case 'laps':
        if (room && room.host === player.id && room.phase === 'lobby' && LAPS.includes(m.laps)) {
          room.laps = m.laps;
          broadcast(room, lobbyMsg(room));
        }
        break;
      case 'start':
        if (room && room.host === player.id && room.phase === 'lobby') {
          room.phase = 'race';
          for (const p of room.players.values()) { p.finishTime = null; p.progress = 0; p.bestLap = null; }
          room.goAt = Date.now() + COUNTDOWN_MS;   // the server times the race so lag can't change the result
          // grid order: everyone gets a slot in join order
          broadcast(room, { t: 'countdown', ms: COUNTDOWN_MS, laps: room.laps, players: lobbyMsg(room).players });
        }
        break;
      case 'state':
        if (room && room.phase === 'race' && Array.isArray(m.s) && m.s.length === 11 && m.s.every(Number.isFinite)) {
          player.progress = Number(m.p) || 0;
          broadcast(room, { t: 'state', id: player.id, s: m.s, p: player.progress, lap: m.lap | 0 }, ws);
        }
        break;
      case 'finish':
        if (room && room.phase === 'race' && player.finishTime == null) {
          player.finishTime = Math.round(Date.now() - room.goAt) / 1000;
          player.bestLap = Number.isFinite(m.best) ? m.best : null;
          const place = [...room.players.values()].filter(p => p.finishTime != null).length;
          broadcast(room, { t: 'finished', id: player.id, name: player.name, time: player.finishTime, place });
          if (place === 1) room.graceTimer = setTimeout(() => finishRace(room), FINISH_GRACE_MS);
          checkAllFinished(room);
        }
        break;
      case 'lobby':
        if (room && room.host === player.id && room.phase === 'results') {
          room.phase = 'lobby';
          broadcast(room, lobbyMsg(room));
        }
        break;
      case 'leave':
        leave(player);
        send(ws, { t: 'menu' });
        break;
    }
  });

  ws.on('close', () => leave(player));
});

// drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Racer server running`);
  console.log(`  This computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  Same Wi-Fi:     http://${a.address}:${PORT}`);
  }
  console.log(`  Over the internet: run "ngrok http ${PORT}" and share the https link`);
});
