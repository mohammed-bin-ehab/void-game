'use strict';
/* VOID multiplayer server.
   - serves ../client over HTTP (so one free Render service hosts both game and sockets)
   - WebSocket rooms (max 8), ready / host-start, authoritative Void simulation (kills are decided here)
   Player positions are reported by each client and sanity-clamped here. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = parseInt(process.env.MIN_PLAYERS || '3', 10);
const MAX_PLAYERS = 8;
const W = 1200, H = 800, PM = 50;
const TICK = 1 / 30;
const PLAYER_SPEED = 255, DASH_SPEED = 700;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

/* difficulty presets (same numbers as the single-player game) */
const MODES = {
  calm:      { label: 'سهل',   spd: 0.62, warn: 2.8, minWarn: 1.0,  minTel: 0.7,  minBlink: 1.0,  unlock: 3,   sink: 0.40, silent: 0,    dashSpd: 520,  interval: 2.0,  show: 1,    homing: 0.15, surge: 1.4, appear: 0.5,  chain: 0,   decoys: 0, hound: 0.5 },
  normal:    { label: 'عادي',  spd: 0.75, warn: 2.2, minWarn: 0.7,  minTel: 0.5,  minBlink: 0.7,  unlock: 2.4, sink: 0.30, silent: 0,    dashSpd: 620,  interval: 1.6,  show: 1,    homing: 0.3,  surge: 1.6, appear: 0.4,  chain: 0.2, decoys: 0, hound: 0.62 },
  hard:      { label: 'صعب',   spd: 0.98, warn: 1.3, minWarn: 0.32, minTel: 0.22, minBlink: 0.32, unlock: 1.3, sink: 0.19, silent: 0.6,  dashSpd: 850,  interval: 1.1,  show: 0.65, homing: 0.8,  surge: 1.95, appear: 0.26, chain: 0.8, decoys: 1, hound: 0.72 },
  nightmare: { label: 'كابوس', spd: 1.15, warn: 0.8, minWarn: 0.12, minTel: 0.09, minBlink: 0.12, unlock: 0.7, sink: 0.14, silent: 1,    dashSpd: 1100, interval: 0.8,  show: 0.4,  homing: 1.1,  surge: 2.4, appear: 0.18, chain: 1.3, decoys: 3, hound: 0.82 }
};
const UNLOCK = { dash: 4, blink: 9, feint: 26, second: 70 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const r1 = v => Math.round(v * 10) / 10;

/* ------------------------------------------------------------------ Void */
class SVoid {
  constructor(room, id) {
    this.room = room; this.id = id; this.R = 44;
    const p = room.alivePlayers()[0];
    this.x = p ? (p.x < W / 2 ? W - 120 : 120) : W / 2; this.y = rand(120, H - 120);
    this.vx = 0; this.vy = 0; this.heading = Math.random() * 6.28;
    this.state = 'spawn'; this.grow = 0; this.t = 0;
    this.mood = 'creep'; this.moodT = 1; this.curve = 1;
    this.cd = 2.5; this.target = null; this.lockT = 0; this.chainLeft = 0; this.forceBlink = false;
    this.last = ''; this.rep = 0; this.markers = []; this.f = 0;
  }
  get D() { return this.room.D; }
  un(k) { return UNLOCK[k] * this.D.unlock; }
  speed() { return (125 + Math.min(this.room.t, 120) * 1.3) * this.D.spd; }
  interval() { return this.D.interval * rand(0.7, 1.3) * clamp(1 - this.room.t / 260, 0.55, 1); }
  warnTime() { return Math.max(this.D.minWarn, this.D.warn * clamp(1 - this.room.t / 160, 0.3, 1)); }
  lethal() { return this.state === 'stalk' || this.state === 'dash' || (this.state === 'appear' && this.grow > 0.35); }
  effR() { return this.R * clamp(this.grow, 0, 1); }

  pickTarget() {
    const ps = this.room.targets();
    if (!ps.length) { this.target = null; return null; }
    let best = null, bd = 1e9;
    for (const p of ps) { const d = dist(p.x, p.y, this.x, this.y); if (d < bd) { bd = d; best = p; } }
    const cur = this.target && this.target.alive && !this.target.ghost() ? this.target : null;
    if (this.lockT > 0 && cur) return cur;                       // hounding: stay on one player
    if (cur) {
      const cd = dist(cur.x, cur.y, this.x, this.y);
      this.target = bd < cd * 0.72 ? best : cur;                // a clearly closer player steals the hunt
    } else this.target = best;
    return this.target;
  }
  randomTarget() {
    const ps = this.room.targets().filter(p => p !== this.target);
    if (ps.length) { this.target = ps[Math.floor(Math.random() * ps.length)]; }
  }

  newMood() {
    const t = this.room.t;
    const opts = [['creep', 2], ['surge', 1.5 + Math.min(2.5, t / 40)], ['freeze', 1.2], ['curve', 2], ['shadow', 1.2], ['hound', 1.3 + Math.min(1.2, t / 60)]];
    for (const o of opts) if (o[0] === this.mood) o[1] *= 0.3;
    let sum = 0; for (const o of opts) sum += o[1];
    let r = Math.random() * sum, m = 'creep';
    for (const o of opts) { r -= o[1]; if (r <= 0) { m = o[0]; break; } }
    this.mood = m;
    this.moodT = m === 'creep' ? rand(0.4, 1.2) : m === 'surge' ? rand(0.28, 0.6) : m === 'freeze' ? rand(0.25, 0.9) : m === 'curve' ? rand(0.5, 1.1) : m === 'hound' ? rand(3, 6.5) : rand(0.5, 1.2);
    this.curve = rand(0.7, 1.3) * (Math.random() < 0.5 ? -1 : 1);
    if (m === 'hound') { this.lockT = this.moodT; if (Math.random() < 0.35) this.randomTarget(); }
  }

  update(dt) {
    this.t += dt; this.f = 0;
    if (this.lockT > 0) this.lockT -= dt;
    const tp = this.pickTarget();
    switch (this.state) {
      case 'spawn': this.grow = Math.min(1, this.grow + dt / 1.6); if (this.grow >= 1) { this.state = 'stalk'; } break;
      case 'stalk': if (tp) this.stalk(dt, tp); break;
      case 'telegraph': this.telegraph(dt, tp); break;
      case 'dash': this.doDash(dt, tp); break;
      case 'vanish': this.grow -= dt / 0.35; this.f = 1 - clamp(this.grow, 0, 1); if (this.grow <= 0) { this.grow = 0; this.state = 'hidden'; this.hold = this.bl.warn; } break;
      case 'hidden': this.hold -= dt; this.f = 1 - this.hold / this.bl.warn; if (this.hold <= 0) this.appear(); break;
      case 'appear':
        this.grow = Math.min(1, this.grow + dt / this.D.appear); this.f = this.grow;
        if (this.grow >= 1) {
          this.state = 'stalk';
          if (this.chainLeft > 0) { this.chainLeft--; this.cd = 0.1; this.forceBlink = true; } else this.cd = this.interval();
        }
        break;
    }
    this.x = clamp(this.x, 40, W - 40); this.y = clamp(this.y, 40, H - 40);
  }

  stalk(dt, tp) {
    this.moodT -= dt; if (this.moodT <= 0) this.newMood();
    const dx = tp.x - this.x, dy = tp.y - this.y, d = Math.hypot(dx, dy) || 1, D = this.D;
    let want = Math.atan2(dy, dx), mul = 1;
    switch (this.mood) {
      case 'creep': mul = 0.45; break;
      case 'surge': { const tt = d / (this.speed() * D.surge); want = Math.atan2(tp.y + tp.vy * tt * 0.8 - this.y, tp.x + tp.vx * tt * 0.8 - this.x); mul = D.surge; break; }
      case 'freeze': mul = 0; break;
      case 'curve': want += this.curve; mul = 1.25; break;
      case 'hound': mul = Math.max(1.05, (PLAYER_SPEED * D.hound) / Math.max(1, this.speed())); break;
      default: mul = 0.95;
    }
    const turn = (this.mood === 'surge' ? 14 : this.mood === 'hound' ? 9 : 5) * dt;
    this.heading += clamp(angDiff(want, this.heading), -turn, turn);
    const sp = this.speed() * mul, k = 1 - Math.exp(-(mul > 1.5 ? 14 : 6) * dt);
    this.vx += (Math.cos(this.heading) * sp - this.vx) * k; this.vy += (Math.sin(this.heading) * sp - this.vy) * k;
    this.x += this.vx * dt; this.y += this.vy * dt;
    // sudden change of mind: another player becomes the prey
    if (this.lockT <= 0 && Math.random() < dt * 0.06 && this.room.targets().length > 1) this.randomTarget();
    this.cd -= dt;
    const busy = this.room.voids.filter(o => o !== this && o.busy()).length;
    const lim = this.room.t > 120 * this.D.unlock ? 2 : 1;
    if (this.cd <= 0 && busy < lim) this.choose(tp);
  }
  busy() { return this.state === 'telegraph' || this.state === 'dash' || this.state === 'vanish' || this.state === 'hidden' || this.state === 'appear'; }

  choose(tp) {
    const t = this.room.t, d = dist(tp.x, tp.y, this.x, this.y);
    if (this.forceBlink) { this.forceBlink = false; this.beginBlink(tp); return; }
    const o = [];
    if (t >= this.un('dash') && d > 150) o.push(['dash', 3]);
    if (t >= this.un('blink')) o.push(['blink', 3]);
    if (t >= this.un('feint') && d > 170) o.push(['feint', 1.2]);
    if (!o.length) { this.cd = 0.4; return; }
    for (const e of o) if (e[0] === this.last && this.rep >= 2) e[1] = 0.15;
    let sum = 0; for (const e of o) sum += e[1];
    let r = Math.random() * sum, pick = o[0][0];
    for (const e of o) { r -= e[1]; if (r <= 0) { pick = e[0]; break; } }
    if (pick === this.last) this.rep++; else { this.last = pick; this.rep = 1; }
    if (pick === 'dash' || pick === 'feint') this.beginDash(pick, tp);
    else {
      this.chainLeft = Math.random() < clamp(0.12 + t * 0.004, 0, 0.55) * this.D.chain ? 1 : 0;
      this.beginBlink(tp);
    }
  }

  beginDash(kind, tp) {
    const D = this.D;
    const silent = kind !== 'feint' && Math.random() < clamp(0.35 + this.room.t * 0.003, 0.35, 0.7) * D.silent;
    const warn = Math.max(D.minTel, this.warnTime() * rand(0.5, 1));
    this.state = 'telegraph';
    this.tel = { kind, silent, dur: warn, left: warn, lock: Math.min(0.12, warn * 0.4), ang: 0, feintDone: false };
    this.aim(tp);
    this.room.cue(this, silent ? 'sub' : 'warn');
  }
  aim(tp) {
    if (!tp) return;
    const d = dist(tp.x, tp.y, this.x, this.y), lead = clamp(0.5 + this.room.t * 0.004, 0.5, 1), tt = d / 650;
    this.tel.ang = Math.atan2(tp.y + tp.vy * tt * lead - this.y, tp.x + tp.vx * tt * lead - this.x);
  }
  telegraph(dt, tp) {
    const tl = this.tel; tl.left -= dt; this.f = 1 - tl.left / tl.dur;
    if (tl.left > tl.lock) this.aim(tp);
    if (tl.kind === 'feint' && !tl.feintDone && tl.left <= tl.dur * 0.35) { tl.feintDone = true; this.beginBlink(tp, Math.max(0.3, this.D.minBlink)); return; }
    if (tl.left <= 0) { this.state = 'dash'; this.dash = { t: 0, dur: 0.55, ang: tl.ang }; this.room.cue(this, 'dash'); }
  }
  doDash(dt, tp) {
    const k = this.dash, D = this.D; k.t += dt;
    if (k.t < 0.35 && tp) {
      const turn = clamp(0.8 + this.room.t * 0.012, 0.8, 2.2) * D.homing * dt;
      k.ang += clamp(angDiff(Math.atan2(tp.y - this.y, tp.x - this.x), k.ang), -turn, turn);
    }
    const sp = D.dashSpd * (1 - 0.7 * clamp(k.t / k.dur, 0, 1));
    this.x += Math.cos(k.ang) * sp * dt; this.y += Math.sin(k.ang) * sp * dt;
    if (k.t >= k.dur || this.x < 45 || this.x > W - 45 || this.y < 45 || this.y > H - 45) { this.state = 'stalk'; this.cd = this.interval(); this.mood = 'freeze'; this.moodT = rand(0.2, 0.5); }
  }

  beginBlink(tp, warnOverride) {
    const D = this.D;
    const warn = warnOverride || Math.max(D.minBlink, this.warnTime() * rand(0.7, 1.1));
    const kinds = ['under', 'under', 'ahead', 'behind', 'side'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const a = Math.random() * Math.PI * 2;
    const m = kind === 'under' ? rand(0, 18) : kind === 'ahead' ? rand(100, 160) : kind === 'behind' ? rand(90, 130) : rand(80, 120) * (Math.random() < 0.5 ? -1 : 1);
    let hx = tp ? tp.vx : 0, hy = tp ? tp.vy : 0; const hl = Math.hypot(hx, hy);
    if (hl < 20) { hx = Math.cos(a); hy = Math.sin(a); } else { hx /= hl; hy /= hl; }
    const px = tp ? tp.x : this.x, py = tp ? tp.y : this.y;
    let tx, ty;
    if (kind === 'under') { tx = px + Math.cos(a) * m; ty = py + Math.sin(a) * m; }
    else if (kind === 'ahead') { tx = px + hx * m; ty = py + hy * m; }
    else if (kind === 'behind') { tx = px - hx * m; ty = py - hy * m; }
    else { tx = px - hy * m; ty = py + hx * m; }
    tx = clamp(tx, 70, W - 70); ty = clamp(ty, 70, H - 70);
    const decoys = [];
    for (let i = 0; i < D.decoys; i++) decoys.push({ x: clamp(px + rand(-240, 240), 70, W - 70), y: clamp(py + rand(-200, 200), 70, H - 70) });
    this.bl = { warn, tx, ty, show: Math.random() < D.show, decoys };
    this.state = 'vanish'; this.grow = 1;
    this.room.cue(this, 'vanish');
  }
  appear() {
    this.x = this.bl.tx; this.y = this.bl.ty; this.vx = 0; this.vy = 0;
    this.state = 'appear'; this.grow = 0; this.room.cue(this, 'appear');
  }

  snap() {
    const o = { id: this.id, x: r1(this.x), y: r1(this.y), s: this.state, g: Math.round(this.grow * 100) / 100, m: this.mood, f: Math.round(this.f * 100) / 100 };
    if (this.state === 'hidden' && this.bl) {
      const mk = []; if (this.bl.show) mk.push([Math.round(this.bl.tx), Math.round(this.bl.ty)]);
      for (const d of this.bl.decoys) mk.push([Math.round(d.x), Math.round(d.y)]);
      o.mk = mk;
    }
    if (this.state === 'telegraph' && this.tel && this.tel.silent) o.q = 1;
    return o;
  }
}

/* ------------------------------------------------------------------ Player */
let NEXT_ID = 1;
class Player {
  constructor(ws, name, slot) {
    this.id = NEXT_ID++; this.ws = ws; this.name = name; this.slot = slot;
    this.ready = false; this.alive = false; this.x = W / 2; this.y = H / 2; this.vx = 0; this.vy = 0;
    this.sink = 0; this.dashing = false; this.shieldT = 0; this.lastShove = -99; this.lastIn = 0;
    this.dist = 0; this.perkAt = 1400; this.perks = 0; this.diedAt = 0; this.rate = 0; this.rateT = 0;
  }
  ghost() { return this.shieldT > 0; }
  info() { return { id: this.id, name: this.name, slot: this.slot, ready: this.ready }; }
}

/* ------------------------------------------------------------------ Room */
class Room {
  constructor(code) {
    this.code = code; this.players = new Map(); this.hostId = 0; this.state = 'lobby';
    this.mode = 'normal'; this.D = MODES.normal; this.t = 0; this.voids = []; this.dark = 0; this.nextDark = 0;
    this.tick = 0; this.order = []; this.loop = null; this.overT = 0;
  }
  alivePlayers() { return [...this.players.values()].filter(p => p.alive); }
  targets() { return this.alivePlayers().filter(p => !p.ghost()); }
  send(p, msg) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
  bcast(msg) { const s = JSON.stringify(msg); for (const p of this.players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
  cue(v, kind) { this.bcast({ t: 'cue', k: kind, x: Math.round(v.x), y: Math.round(v.y), v: v.id }); }

  roomMsg() {
    return { t: 'room', code: this.code, state: this.state, host: this.hostId, mode: this.mode, min: MIN_PLAYERS, max: MAX_PLAYERS,
      players: [...this.players.values()].map(p => p.info()) };
  }
  pushRoom() { this.bcast(this.roomMsg()); }
  freeSlot() { const used = new Set([...this.players.values()].map(p => p.slot)); for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i; return -1; }

  canStart() {
    const ps = [...this.players.values()];
    return ps.length >= MIN_PLAYERS && ps.every(p => p.id === this.hostId || p.ready);
  }

  start() {
    if (this.state !== 'lobby' || !this.canStart()) return false;
    this.state = 'play'; this.D = MODES[this.mode] || MODES.normal; this.t = 0; this.tick = 0; this.order = []; this.dark = 0; this.nextDark = rand(18, 30);
    const ps = [...this.players.values()], n = ps.length;
    ps.forEach((p, i) => {
      const a = (i / n) * Math.PI * 2;
      p.x = W / 2 + Math.cos(a) * 230; p.y = H / 2 + Math.sin(a) * 160; p.vx = p.vy = 0;
      p.alive = true; p.sink = 0; p.dashing = false; p.shieldT = 0; p.dist = 0; p.perkAt = 1400; p.perks = 0; p.lastShove = -99;
    });
    this.voids = [new SVoid(this, 1)];
    this.bcast({ t: 'start', n, mode: this.mode, you: null, players: ps.map(p => ({ id: p.id, name: p.name, slot: p.slot, x: Math.round(p.x), y: Math.round(p.y) })) });
    this.loop = setInterval(() => this.step(), TICK * 1000);
    return true;
  }

  kill(p, by) {
    if (!p.alive) return;
    p.alive = false; p.diedAt = this.t; this.order.push(p.id);
    this.bcast({ t: 'dead', id: p.id, name: p.name, left: this.alivePlayers().length, time: r1(this.t) });
  }

  step() {
    const dt = TICK; this.t += dt; this.tick++;
    const ps = [...this.players.values()];
    for (const p of ps) { if (p.shieldT > 0) p.shieldT -= dt; }

    if (this.t > UNLOCK.second * this.D.unlock && this.voids.length === 1 && this.alivePlayers().length >= 3) this.voids.push(new SVoid(this, 2));

    for (const v of this.voids) v.update(dt);

    // lights out
    if (this.dark > 0) this.dark -= dt;
    else if (this.t >= this.nextDark) {
      this.dark = rand(2, 3); this.nextDark = this.t + rand(22, 40);
      this.bcast({ t: 'dark', dur: r1(this.dark) });
      for (const v of this.voids) if (v.state === 'stalk' && Math.random() < 0.7) { v.cd = Math.min(v.cd, 0.35); if (this.t > v.un('blink')) v.forceBlink = Math.random() < 0.5; }
    }

    // kills
    for (const v of this.voids) {
      if (!v.lethal()) continue;
      const er = v.effR() * 0.92;
      for (const p of ps) {
        if (!p.alive) continue;
        const d = dist(p.x, p.y, v.x, v.y);
        if (d < er && !p.dashing && !p.ghost()) {
          p.sink += dt * (v.state === 'dash' ? 1 / (0.06 / this.D.sink) : 1);
          if (p.sink >= this.D.sink) this.kill(p, v);
        } else if (p.sink > 0) p.sink = Math.max(0, p.sink - dt * 2);
      }
    }

    // survivors / winner
    const alive = this.alivePlayers();
    if (alive.length <= 1 && ps.length >= 2) return this.finish(alive[0] || this.players.get(this.order[this.order.length - 1]));

    if (this.tick % 2 === 0) {
      this.bcast({
        t: 'snap', time: r1(this.t), dk: r1(Math.max(0, this.dark)),
        p: ps.map(p => [p.id, Math.round(p.x), Math.round(p.y), Math.round(p.vx), Math.round(p.vy), p.alive ? 1 : 0, Math.round(clamp(p.sink / this.D.sink, 0, 1) * 100) / 100, p.ghost() ? 1 : 0]),
        v: this.voids.map(v => v.snap())
      });
    }
  }

  finish(winner) {
    clearInterval(this.loop); this.loop = null; this.state = 'over';
    const rank = [...this.order].reverse();
    if (winner && !rank.includes(winner.id)) rank.unshift(winner.id);
    this.bcast({ t: 'over', winner: winner ? { id: winner.id, name: winner.name } : null, time: r1(this.t), rank: rank.map(id => { const p = this.players.get(id); return p ? { id, name: p.name, slot: p.slot } : { id, name: '؟', slot: 0 }; }) });
    setTimeout(() => this.toLobby(), 9000);
  }
  toLobby() {
    if (this.state !== 'over') return;
    this.state = 'lobby'; this.voids = [];
    for (const p of this.players.values()) { p.ready = false; p.alive = false; }
    this.pushRoom();
  }

  addInput(p, m) {
    if (this.state !== 'play' || !p.alive) return;
    const now = Date.now(), dtMs = Math.max(8, now - (p.lastIn || now - 33)); p.lastIn = now;
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
    const maxStep = (DASH_SPEED * 1.6) * (dtMs / 1000) + 40;
    let nx = clamp(m.x, PM - 10, W - PM + 10), ny = clamp(m.y, PM - 10, H - PM + 10);
    const d = dist(nx, ny, p.x, p.y);
    if (d > maxStep) { nx = p.x + (nx - p.x) / d * maxStep; ny = p.y + (ny - p.y) / d * maxStep; }
    p.dist += dist(nx, ny, p.x, p.y);
    p.x = nx; p.y = ny; p.vx = clamp(+m.vx || 0, -900, 900); p.vy = clamp(+m.vy || 0, -900, 900); p.dashing = !!m.d;
    if (p.dist >= p.perkAt) this.givePerk(p);
  }

  /* automatic perks for players who keep moving */
  givePerk(p) {
    p.perks++; p.perkAt = p.dist + 1400 + p.perks * 400;
    const kinds = ['haste', 'refill', 'shield', 'haste', 'refill'];
    const k = kinds[Math.floor(Math.random() * kinds.length)];
    if (k === 'shield') p.shieldT = 3;
    this.send(p, { t: 'perk', k, dur: k === 'haste' ? 5 : k === 'shield' ? 3 : 0 });
  }

  shove(p) {
    if (this.state !== 'play' || !p.alive || this.t - p.lastShove < 4) return;
    let best = null, bd = 80;
    for (const o of this.alivePlayers()) { if (o === p) continue; const d = dist(o.x, o.y, p.x, p.y); if (d < bd) { bd = d; best = o; } }
    p.lastShove = this.t;
    if (!best) { this.send(p, { t: 'shove', hit: 0, cd: 4 }); return; }
    const a = Math.atan2(best.y - p.y, best.x - p.x);
    this.send(best, { t: 'push', vx: Math.round(Math.cos(a) * 560), vy: Math.round(Math.sin(a) * 560), by: p.id });
    this.send(p, { t: 'push', vx: Math.round(-Math.cos(a) * 180), vy: Math.round(-Math.sin(a) * 180), by: best.id });
    this.send(p, { t: 'shove', hit: 1, cd: 4 });
    this.bcast({ t: 'fx', k: 'shove', x: Math.round(best.x), y: Math.round(best.y) });
  }

  remove(p) {
    this.players.delete(p.id);
    if (this.state === 'play') {
      if (p.alive) { p.alive = false; this.order.push(p.id); this.bcast({ t: 'dead', id: p.id, name: p.name, left: this.alivePlayers().length, time: r1(this.t), left_game: 1 }); }
    }
    if (p.id === this.hostId) { const n = this.players.values().next().value; this.hostId = n ? n.id : 0; }
    if (!this.players.size) { if (this.loop) clearInterval(this.loop); rooms.delete(this.code); return; }
    if (this.state === 'lobby' || this.state === 'over') this.pushRoom();
  }
}

/* ------------------------------------------------------------------ Server */
const rooms = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200); res.end('ok'); return; }
  let rel = url === '/' ? '/index.html' : url;
  const file = path.normalize(path.join(CLIENT_DIR, rel));
  if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });
const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => { let c; do { c = Array.from({ length: 4 }, () => codeChars[Math.floor(Math.random() * codeChars.length)]).join(''); } while (rooms.has(c)); return c; };
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);

wss.on('connection', ws => {
  let me = null, room = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (me) return;
      let code = String(m.room || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      let r = code ? rooms.get(code) : null;
      if (code && !r && m.create !== true) { ws.send(JSON.stringify({ t: 'err', code: 'noroom', msg: 'الغرفة غير موجودة' })); return; }
      if (!r) { code = code || newCode(); r = new Room(code); rooms.set(code, r); }
      if (r.state !== 'lobby') { ws.send(JSON.stringify({ t: 'err', code: 'started', msg: 'اللعبة بدأت بالفعل، انتظر الجولة القادمة' })); return; }
      if (r.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'err', code: 'full', msg: 'الغرفة ممتلئة' })); return; }
      let name = cleanName(m.name) || 'لاعب'; const taken = new Set([...r.players.values()].map(p => p.name));
      if (taken.has(name)) { let i = 2; while (taken.has(name + ' ' + i)) i++; name += ' ' + i; }
      me = new Player(ws, name, r.freeSlot()); room = r; r.players.set(me.id, me);
      if (!r.hostId) r.hostId = me.id;
      ws.send(JSON.stringify({ t: 'joined', id: me.id, slot: me.slot, name: me.name }));
      r.pushRoom();
      return;
    }
    if (!me || !room) return;

    if (m.t === 'in') {                           // movement: capped at ~40 msgs/s
      const now = Date.now(); if (now - me.rateT > 1000) { me.rateT = now; me.rate = 0; }
      if (++me.rate > 45) return;
      room.addInput(me, m); return;
    }
    if (m.t === 'ready') { if (room.state === 'lobby' && me.id !== room.hostId) { me.ready = !!m.v; room.pushRoom(); } return; }
    if (m.t === 'mode') { if (room.state === 'lobby' && me.id === room.hostId && MODES[m.v]) { room.mode = m.v; room.pushRoom(); } return; }
    if (m.t === 'start') {
      if (me.id !== room.hostId) return;
      if (!room.start()) ws.send(JSON.stringify({ t: 'err', code: 'cantstart', msg: room.players.size < MIN_PLAYERS ? 'يلزم ' + MIN_PLAYERS + ' لاعبين على الأقل' : 'ليس كل اللاعبين جاهزين' }));
      return;
    }
    if (m.t === 'shove') { room.shove(me); return; }
    if (m.t === 'perk-use') return;
  });
  ws.on('close', () => { if (me && room) room.remove(me); });
  ws.on('error', () => {});
});

setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} } }, 20000);

if (require.main === module) server.listen(PORT, () => console.log('VOID server on :' + PORT));
module.exports = { server, rooms, MODES };
