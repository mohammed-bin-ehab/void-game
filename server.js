'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Sim, MODES } = require('./sim');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = Math.max(2, parseInt(process.env.MIN_PLAYERS || '3', 10));
const MAX_PLAYERS = 8;
const TICK_MS = 33;
const COUNTDOWN = 4;
const BACK_TO_LOBBY = 14;

/* ---------- static file + health ---------- */
const INDEX = path.join(__dirname, 'index.html');
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health' || url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

/* ---------- rooms ---------- */
const rooms = new Map();
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

class Room {
  constructor(code) {
    this.code = code; this.players = []; this.hostId = 0; this.state = 'lobby'; this.mode = 'normal';
    this.sim = null; this.playing = []; this.count = 0; this.running = false; this.backT = 0; this.pending = [];
  }
  freeId() { for (let i = 1; i <= MAX_PLAYERS; i++) if (!this.players.some(p => p.id === i)) return i; return 0; }
  broadcast(o) { const s = JSON.stringify(o); for (const p of this.players) if (p.ws.readyState === 1) p.ws.send(s); }
  lobby() {
    this.broadcast({
      t: 'lobby', room: this.code, st: this.state, host: this.hostId, mode: this.mode, min: MIN_PLAYERS, max: MAX_PLAYERS,
      ps: this.players.map(p => ({ i: p.id, n: p.name, r: p.ready ? 1 : 0 }))
    });
  }
  canStart() {
    return this.state === 'lobby' && this.players.length >= MIN_PLAYERS && this.players.every(p => p.id === this.hostId || p.ready);
  }
  begin() {
    this.state = 'play'; this.running = false; this.count = COUNTDOWN; this.pending = [];
    this.playing = this.players.slice();
    this.sim = new Sim(this.playing, this.mode, e => this.pending.push(e));
    this.broadcast({
      t: 'start', mode: this.mode, count: COUNTDOWN, me: 0,
      ps: this.playing.map(p => ({ i: p.id, n: p.name, x: Math.round(p.x), y: Math.round(p.y) }))
    });
    this.lobby();
  }
  tick(dt) {
    if (this.state === 'play') {
      if (this.count > 0) {
        this.count -= dt;
        if (this.count <= 0) { this.running = true; this.broadcast({ t: 'go' }); }
      }
      if (this.running) this.sim.update(dt);
      this.flushSnapshot();
      if (this.sim.over) this.finish();
    } else if (this.state === 'over') {
      this.backT -= dt;
      if (this.backT <= 0) this.backToLobby();
    }
  }
  flushSnapshot() {
    const snap = this.sim.snapshot(); const evs = this.pending; this.pending = [];
    for (const p of this.playing) {
      if (p.ws.readyState !== 1) continue;
      const mine = evs.filter(e => e.to === undefined || e.to === p.id);
      snap.e = mine.length ? mine : undefined;
      p.ws.send(JSON.stringify(snap));
    }
  }
  finish() {
    this.state = 'over'; this.running = false; this.backT = BACK_TO_LOBBY;
    const w = this.sim.winner(), order = this.sim.deadOrder.slice().reverse();
    const rank = [];
    if (w && w.alive) rank.push({ i: w.id, n: w.name, t: Math.round(this.sim.t * 10) / 10, w: 1 });
    for (const p of order) rank.push({ i: p.id, n: p.name, t: Math.round(p.deadT * 10) / 10, w: 0 });
    this.broadcast({ t: 'over', win: w ? { i: w.id, n: w.name } : null, rank, back: BACK_TO_LOBBY });
    this.lobby();
  }
  backToLobby() {
    this.players = this.players.filter(p => p.ws.readyState === 1);
    for (const p of this.players) { p.ready = false; p.alive = true; }
    this.state = 'lobby'; this.sim = null; this.playing = [];
    if (!this.players.some(p => p.id === this.hostId) && this.players.length) this.hostId = Math.min(...this.players.map(p => p.id));
    if (!this.players.length) { rooms.delete(this.code); return; }
    this.lobby();
  }
  remove(p) {
    const wasPlaying = this.state === 'play' && this.playing.includes(p);
    if (wasPlaying) { this.sim.playerLeft(p); }
    this.players = this.players.filter(x => x !== p);
    if (this.state === 'lobby' || this.state === 'over') { /* just leave */ }
    if (p.id === this.hostId && this.players.length) this.hostId = Math.min(...this.players.map(x => x.id));
    if (!this.players.length) { rooms.delete(this.code); return; }
    this.lobby();
  }
}

const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
const cleanRoom = s => String(s || '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 12).toUpperCase() || 'VOID';

/* ---------- sockets ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
wss.on('connection', ws => {
  let me = null, room = null, bucket = 60, last = Date.now();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    const now = Date.now(); bucket = Math.min(80, bucket + (now - last) / 1000 * 60); last = now;
    if (--bucket < 0) return;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'pg') return send(ws, { t: 'pn', c: m.c });

    if (m.t === 'join') {
      if (me) return;
      const code = cleanRoom(m.room);
      let r = rooms.get(code);
      if (!r) { r = new Room(code); rooms.set(code, r); }
      if (r.state !== 'lobby') { if (!r.players.length) rooms.delete(code); return send(ws, { t: 'err', c: 'running', m: 'اللعبة بدأت في هذه الغرفة. انتظر حتى تنتهي، أو جرّب رمز غرفة آخر.' }); }
      if (r.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', c: 'full', m: 'الغرفة ممتلئة (8 لاعبين).' });
      const id = r.freeId();
      me = { id, ws, name: cleanName(m.name) || ('لاعب ' + id), ready: false, alive: true, x: 600, y: 400, vx: 0, vy: 0 };
      room = r; r.players.push(me);
      if (!r.hostId || !r.players.some(p => p.id === r.hostId)) r.hostId = id;
      send(ws, { t: 'joined', id, room: code, host: r.hostId });
      r.lobby();
      return;
    }
    if (!me || !room) return;

    switch (m.t) {
      case 'ready': if (room.state === 'lobby') { me.ready = !!m.v; room.lobby(); } break;
      case 'mode': if (room.state === 'lobby' && me.id === room.hostId && MODES[m.m]) { room.mode = m.m; room.lobby(); } break;
      case 'start':
        if (me.id === room.hostId && room.canStart()) room.begin();
        else if (me.id === room.hostId) send(ws, { t: 'err', c: 'start', m: 'لا يمكن البدء: يلزم ' + MIN_PLAYERS + ' لاعبين على الأقل، وكل اللاعبين جاهزون.' });
        break;
      case 'in':
        if (room.state === 'play' && room.running && room.playing.includes(me)) room.sim.report(me, m.x, m.y, m.vx, m.vy, m.d, m.l);
        else if (room.state === 'play' && room.playing.includes(me)) { /* countdown: stay put */ }
        break;
      case 'dash': if (room.state === 'play' && room.running) room.sim.noteDash(me); break;
      case 'push': if (room.state === 'play' && room.running) room.sim.push(me); break;
    }
  });
  ws.on('close', () => { if (room && me) room.remove(me); });
  ws.on('error', () => {});
});

setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} } }, 25000);

let lastT = Date.now();
setInterval(() => {
  const now = Date.now(); const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  for (const r of rooms.values()) { try { r.tick(dt); } catch (e) { console.error('tick error', e); } }
}, TICK_MS);

server.listen(PORT, () => console.log('VOID server on :' + PORT + ' (min players ' + MIN_PLAYERS + ')'));
module.exports = { server };
