'use strict';
/* VOID multiplayer simulation. The server owns the void(s); players report their own position and the server decides who falls. */

const W = 1200, H = 800, PM = 50;
const CFG = { playerSpeed: 255, dashCooldown: 1.4, voidRadius: 44, unlock: { dash: 4, blink: 9, spiral: 16, feint: 26, second: 60, third: 130 } };

const MODES = {
  calm:      { label: 'سهل',   spd: 0.62, warn: 2.8, minWarn: 1.0,  minTel: 0.7,  minBlink: 1.0,  sig: 2.8, unlock: 3,   sink: 0.40, silent: 0,    dashSpd: 520, interval: 2.0,  show: 1,    homing: 0.15, surge: 1.4, appear: 0.5,  chain: 0,   decoys: 0, pull: 30,  hound: 0.5 },
  normal:    { label: 'عادي',  spd: 0.75, warn: 2.2, minWarn: 0.7,  minTel: 0.5,  minBlink: 0.7,  sig: 2.2, unlock: 2.4, sink: 0.30, silent: 0,    dashSpd: 620, interval: 1.6,  show: 1,    homing: 0.3, surge: 1.6, appear: 0.4,  chain: 0.2, decoys: 0, pull: 50,  hound: 0.62 },
  hard:      { label: 'صعب',   spd: 0.98, warn: 1.3, minWarn: 0.32, minTel: 0.22, minBlink: 0.32, sig: 1.3, unlock: 1.3, sink: 0.19, silent: 0.6,  dashSpd: 850, interval: 1.1,  show: 0.65, homing: 0.8, surge: 1.95, appear: 0.26, chain: 0.8, decoys: 1, pull: 95,  hound: 0.72 },
  nightmare: { label: 'كابوس', spd: 1.15, warn: 0.8, minWarn: 0.12, minTel: 0.09, minBlink: 0.12, sig: 0.75, unlock: 0.7, sink: 0.14, silent: 1,    dashSpd: 1100, interval: 0.8, show: 0.4,  homing: 1.1, surge: 2.4, appear: 0.18, chain: 1.3, decoys: 3, pull: 135, hound: 0.82 }
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const easeOut = g => 1 - Math.pow(1 - clamp(g, 0, 1), 3);
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const r1 = v => Math.round(v * 10) / 10;

const STATE = { spawn: 0, stalk: 1, telegraph: 2, dash: 3, spiral: 4, vanish: 5, hidden: 6, appear: 7 };
const PERKS = [['speed', 6], ['lantern', 7], ['shield', 3], ['dash', 6]];

class Void {
  constructor(sim, id, scale, delay) {
    this.sim = sim; this.id = id; this.s = scale; this.R = CFG.voidRadius * scale; this.spd = scale < 1 ? 0.9 : 1;
    // start far from everyone
    let best = null, bd = -1;
    for (let i = 0; i < 14; i++) {
      const x = rand(90, W - 90), y = rand(90, H - 90); let m = 1e9;
      for (const p of sim.alive()) m = Math.min(m, Math.hypot(p.x - x, p.y - y));
      if (m > bd) { bd = m; best = { x, y }; }
    }
    this.x = best.x; this.y = best.y;
    this.state = 'spawn'; this.delay = delay; this.grow = 0; this.t = 0; this.cd = 1.4;
    this.last = ''; this.rep = 0; this.mood = 'creep'; this.moodT = 0; this.curve = 0; this.vx = 0; this.vy = 0;
    this.chainLeft = 0; this.forceBlink = false; this.flash = 0;
    this.tp = null; this.lock = 0; this.rtT = rand(10, 18);
    this.tel = null; this.dash = null; this.sp = null; this.bl = null;
    this.heading = Math.random() * 6.28;
  }
  get D() { return this.sim.D; }
  effR() { return this.R * easeOut(this.grow); }
  busy() { return ['telegraph', 'dash', 'spiral', 'vanish', 'hidden', 'appear'].includes(this.state); }
  speed() { return (125 + Math.min(this.sim.t, 120) * 1.3) * this.spd * this.D.spd; }
  un(k) { return CFG.unlock[k] * this.D.unlock * 0.8; }
  warnTime() { return Math.max(this.D.minWarn, (0.5 - this.sim.t * 0.002) * this.D.warn) * rand(0.8, 1.25); }
  interval() { return Math.max(0.5, 1.9 - 0.012 * this.sim.t) * this.D.interval * rand(0.5, 1.5); }
  ev(k, extra) { this.sim.emit(Object.assign({ k, x: r1(this.x), y: r1(this.y) }, extra || {})); }
  T() { if (!this.tp || !this.tp.alive) this.retarget(true); return this.tp || { x: W / 2, y: H / 2, vx: 0, vy: 0, fx: 1, fy: 0, ema: 0, dashLog: [] }; }

  /* who is being hunted: usually the closest, sometimes a sudden switch, sometimes a long fixation */
  retarget(force) {
    const al = this.sim.alive(); if (!al.length) { this.tp = null; return; }
    if (!force && this.lock > 0 && this.tp && this.tp.alive) return;
    const others = this.sim.voids.filter(v => v !== this && v.tp).map(v => v.tp);
    let near = null, nd = 1e9;
    for (const p of al) { const d = Math.hypot(p.x - this.x, p.y - this.y) * (others.includes(p) ? 1.35 : 1); if (d < nd) { nd = d; near = p; } }
    if (!this.tp || !this.tp.alive) this.tp = near;
    else if (near !== this.tp && nd < Math.hypot(this.tp.x - this.x, this.tp.y - this.y) * 0.72) this.tp = near;
  }
  suddenSwitch() {
    const al = this.sim.alive().filter(p => p !== this.tp); if (!al.length) return;
    this.tp = al[Math.floor(Math.random() * al.length)]; this.lock = rand(2, 4);
  }

  update(dt) {
    const D = this.D; this.t += dt; this.flash = Math.max(0, this.flash - dt * 2.5);
    if (this.lock > 0) this.lock -= dt;
    switch (this.state) {
      case 'spawn':
        if (this.delay > 0) { this.delay -= dt; return; }
        this.grow = Math.min(1, this.grow + dt / 1.6);
        if (this.grow >= 1) this.state = 'stalk';
        break;
      case 'stalk': this.stalk(dt); break;
      case 'telegraph': this.telegraph(dt); break;
      case 'dash': this.doDash(dt); break;
      case 'spiral': this.spiral(dt); break;
      case 'vanish':
        this.grow -= dt / 0.22;
        if (this.grow <= 0) { this.grow = 0; this.state = 'hidden'; this.bl.timer = this.bl.warn; this.bl.tick = 0; this.pickSpot(); }
        break;
      case 'hidden': this.hidden(dt); break;
      case 'appear':
        this.grow += dt / D.appear;
        if (this.grow >= 1) {
          this.grow = 1; this.state = 'stalk';
          if (this.chainLeft > 0) { this.chainLeft--; this.cd = 0.1; this.forceBlink = true; }
          else this.cd = this.interval();
        }
        break;
    }
    this.x = clamp(this.x, 40, W - 40); this.y = clamp(this.y, 40, H - 40);
  }

  newMood() {
    const t = this.sim.t;
    const opts = [['creep', 2], ['surge', 1.5 + Math.min(2.5, t / 40)], ['freeze', 1.4], ['curve', 2], ['shadow', 1.2], ['hound', 1.3 + Math.min(1.2, t / 60)]];
    for (const o of opts) if (o[0] === this.mood) o[1] *= 0.3;
    let sum = 0; for (const o of opts) sum += o[1];
    let r = Math.random() * sum, m = 'creep';
    for (const o of opts) { r -= o[1]; if (r <= 0) { m = o[0]; break; } }
    this.mood = m;
    this.moodT = m === 'creep' ? rand(0.4, 1.2) : m === 'surge' ? rand(0.28, 0.6) : m === 'freeze' ? rand(0.25, 0.9) : m === 'curve' ? rand(0.5, 1.1) : m === 'hound' ? rand(3, 6.5) : rand(0.5, 1.2);
    this.curve = rand(0.7, 1.3) * (Math.random() < 0.5 ? -1 : 1);
    if (m === 'hound') { this.retarget(true); if (Math.random() < 0.4) this.suddenSwitch(); this.lock = this.moodT + 0.4; }
  }
  stalk(dt) {
    const D = this.D; this.moodT -= dt; if (this.moodT <= 0) this.newMood();
    this.rtT -= dt; if (this.rtT <= 0) { this.rtT = rand(11, 22); if (this.lock <= 0) this.suddenSwitch(); }
    this.retarget(false);
    const P = this.T();
    const dx = P.x - this.x, dy = P.y - this.y, d = Math.hypot(dx, dy) || 1;
    let want = Math.atan2(dy, dx), mul = 1;
    switch (this.mood) {
      case 'creep': mul = 0.45; break;
      case 'surge': { const tt = d / (this.speed() * D.surge); want = Math.atan2(P.y + P.vy * tt * 0.8 - this.y, P.x + P.vx * tt * 0.8 - this.x); mul = D.surge; break; }
      case 'freeze': mul = 0; break;
      case 'curve': want += this.curve; mul = 1.25; break;
      case 'hound': mul = Math.max(1.05, (CFG.playerSpeed * D.hound) / Math.max(1, this.speed())); break;
      default: mul = 0.95;
    }
    const turn = (this.mood === 'surge' ? 14 : this.mood === 'hound' ? 9 : 5) * dt;
    this.heading += clamp(angDiff(want, this.heading), -turn, turn);
    const sp = this.speed() * mul, k = 1 - Math.exp(-(mul > 1.5 ? 14 : 6) * dt);
    this.vx += (Math.cos(this.heading) * sp - this.vx) * k; this.vy += (Math.sin(this.heading) * sp - this.vy) * k;
    this.x += this.vx * dt; this.y += this.vy * dt;
    this.cd -= dt;
    const lim = this.sim.t > 120 * D.unlock ? 2 : 1;
    if (this.cd <= 0 && this.sim.voids.filter(o => o !== this && o.busy()).length < lim) this.choose();
  }

  choose() {
    const t = this.sim.t, P = this.T(), d = Math.hypot(P.x - this.x, P.y - this.y);
    if (this.forceBlink) { this.forceBlink = false; this.beginBlink(); return; }
    const still = P.ema < 40, steady = P.ema > 110;
    const heavyDash = P.dashLog.filter(x => x > t - 9).length >= 2;
    const o = [];
    if (t >= this.un('dash') && d > 150) o.push(['dash', 3 + (still ? 2 : 0)]);
    if (t >= this.un('blink')) o.push(['blink', 3 + (steady ? 2 : 0)]);
    if (t >= this.un('spiral') && d > 140) o.push(['spiral', 1.3 + (still ? 1 : 0)]);
    if (t >= this.un('feint') && d > 170) o.push(['feint', 1.2 + (heavyDash ? 2 : 0)]);
    if (!o.length) { this.cd = 0.4; return; }
    for (const e of o) if (e[0] === this.last && this.rep >= 2) e[1] = 0.15;
    let sum = 0; for (const e of o) sum += e[1];
    let r = Math.random() * sum, pick = o[0][0];
    for (const e of o) { r -= e[1]; if (r <= 0) { pick = e[0]; break; } }
    if (pick === this.last) this.rep++; else { this.last = pick; this.rep = 1; }
    if (pick === 'dash' || pick === 'feint') this.beginDash(pick);
    else if (pick === 'blink') {
      this.chainLeft = Math.random() < clamp(0.12 + t * 0.004, 0, 0.55) * this.D.chain ? (t > 60 * this.D.unlock ? 2 : 1) : 0;
      this.beginBlink();
    } else this.beginSpiral();
  }

  beginDash(kind) {
    const D = this.D;
    const silent = kind !== 'feint' && Math.random() < clamp(0.35 + this.sim.t * 0.003, 0.35, 0.7) * D.silent;
    const warn = kind === 'chain' ? Math.max(0.2, D.minTel * 0.7) : Math.max(D.minTel, this.warnTime() * rand(0.5, 1));
    this.state = 'telegraph';
    this.tel = { kind, silent, dur: warn, left: warn, lock: Math.min(0.12, warn * 0.4), ang: 0, feintDone: false };
    this.aim();
    this.ev(silent ? 'sub' : 'warn');
  }
  aim() {
    const P = this.T(), d = Math.hypot(P.x - this.x, P.y - this.y), lead = clamp(0.5 + this.sim.t * 0.004, 0.5, 1), tt = d / 650;
    this.tel.ang = Math.atan2(P.y + P.vy * tt * lead - this.y, P.x + P.vx * tt * lead - this.x);
  }
  telegraph(dt) {
    const tl = this.tel; tl.left -= dt;
    if (tl.left > tl.lock) this.aim();
    if (tl.kind === 'feint' && !tl.feintDone && tl.left <= tl.dur * 0.35) { tl.feintDone = true; this.beginBlink(Math.max(0.3, this.D.minBlink)); return; }
    if (tl.left <= 0) { this.state = 'dash'; this.dash = { t: 0, dur: 0.55, ang: tl.ang }; this.ev('dash'); }
  }
  doDash(dt) {
    const D = this.D, k = this.dash; k.t += dt; const P = this.T();
    if (k.t < 0.35) {
      const turn = clamp(0.8 + this.sim.t * 0.012, 0.8, 2.2) * D.homing * dt;
      k.ang += clamp(angDiff(Math.atan2(P.y - this.y, P.x - this.x), k.ang), -turn, turn);
    }
    const sp = D.dashSpd * (1 - 0.7 * clamp(k.t / k.dur, 0, 1));
    this.x += Math.cos(k.ang) * sp * dt; this.y += Math.sin(k.ang) * sp * dt;
    if (k.t >= k.dur || this.x < 45 || this.x > W - 45 || this.y < 45 || this.y > H - 45) { this.state = 'stalk'; this.cd = this.interval(); this.mood = 'freeze'; this.moodT = rand(0.2, 0.5); }
  }

  beginBlink(warnOverride) {
    const D = this.D, P = this.T();
    const warn = warnOverride || Math.max(D.minBlink, this.warnTime() * rand(0.7, 1.1));
    const kinds = ['under', 'under', 'ahead', 'behind', 'side'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const a = Math.random() * Math.PI * 2;
    const m = kind === 'under' ? rand(0, 18) : kind === 'ahead' ? rand(100, 160) : kind === 'behind' ? rand(90, 130) : rand(80, 120) * (Math.random() < 0.5 ? -1 : 1);
    const decoys = [];
    const nd = D.decoys === 0 ? 0 : (this.sim.t > 25 * D.unlock ? (Math.random() < 0.6 ? D.decoys : 1) : 1);
    for (let i = 0; i < nd; i++) {
      const da = Math.random() * Math.PI * 2, dr = rand(70, 260);
      decoys.push({ x: clamp(P.x + Math.cos(da) * dr, 60, W - 60), y: clamp(P.y + Math.sin(da) * dr, 60, H - 60) });
    }
    this.state = 'vanish';
    this.bl = { warn, timer: warn, tick: 0, sil: false, kind, m, ox: Math.cos(a) * m, oy: Math.sin(a) * m, tx: this.x, ty: this.y, lock: Math.min(0.18, warn * 0.5), show: Math.random() < D.show, decoys };
    this.ev('vanish');
  }
  pickSpot() {
    const b = this.bl, P = this.T(), T = b.timer + this.D.appear, lead = clamp(0.4 + this.sim.t * 0.005, 0.4, 1);
    const sp = Math.hypot(P.vx, P.vy), hx = sp > 20 ? P.vx / sp : P.fx, hy = sp > 20 ? P.vy / sp : P.fy;
    let bx = P.x + P.vx * T * lead, by = P.y + P.vy * T * lead;
    if (b.kind === 'under') { bx += b.ox; by += b.oy; }
    else if (b.kind === 'ahead') { bx += hx * b.m; by += hy * b.m; }
    else if (b.kind === 'behind') { bx -= hx * b.m; by -= hy * b.m; }
    else { bx += -hy * b.m; by += hx * b.m; }
    b.tx = clamp(bx, 60, W - 60); b.ty = clamp(by, 60, H - 60);
  }
  hidden(dt) {
    const b = this.bl; b.timer -= dt;
    if (b.timer > b.lock) this.pickSpot();
    b.tick -= dt; if (b.tick <= 0) { this.sim.emit({ k: 'tick', x: r1(b.tx), y: r1(b.ty) }); b.tick = 0.15; }
    if (!b.sil && b.timer < 0.12) { this.sim.emit({ k: 'silence', d: 0.12 }); b.sil = true; }
    if (b.timer <= 0) {
      this.x = b.tx; this.y = b.ty; this.state = 'appear'; this.grow = 0; this.flash = 1; this.vx = 0; this.vy = 0;
      const P = this.T(); this.heading = Math.atan2(P.y - this.y, P.x - this.x);
      this.ev('appear');
    }
  }
  beginSpiral() {
    const P = this.T(), d = Math.hypot(P.x - this.x, P.y - this.y);
    this.state = 'spiral';
    this.sp = { t: 0, dur: rand(1.2, 1.7) * (this.D.warn > 1.2 ? 1.25 : 1), ang: Math.atan2(this.y - P.y, this.x - P.x), r0: clamp(d, 130, 220), cx: P.x, cy: P.y, dir: Math.random() < 0.5 ? 1 : -1, wob: rand(0, 6) };
    this.ev('sub');
  }
  spiral(dt) {
    const s = this.sp, P = this.T(); s.t += dt; const f = clamp(s.t / s.dur, 0, 1);
    const dx = P.x - s.cx, dy = P.y - s.cy, dd = Math.hypot(dx, dy) || 1, mv = Math.min(dd, 150 * dt);
    s.cx += dx / dd * mv; s.cy += dy / dd * mv;
    s.ang += s.dir * (1.8 + 1.5 * f + 0.6 * Math.sin(s.t * 5 + s.wob)) * dt;
    const r = lerp(s.r0, 60, Math.pow(f, 0.9));
    const px = s.cx + Math.cos(s.ang) * r, py = s.cy + Math.sin(s.ang) * r, k = Math.min(1, 10 * dt);
    this.x += (px - this.x) * k; this.y += (py - this.y) * k;
    if (f >= 1) this.beginDash('chain');
  }

  pack() {
    const o = { i: this.id, x: r1(this.x), y: r1(this.y), g: Math.round(this.grow * 100) / 100, s: STATE[this.state], R: r1(this.R), f: Math.round(this.flash * 100) / 100 };
    if (this.mood === 'freeze') o.fz = 1;
    if (this.state === 'telegraph' && this.tel) o.tl = [this.tel.silent ? 1 : 0, Math.round(this.tel.left * 100) / 100, Math.round(this.tel.dur * 100) / 100];
    if ((this.state === 'hidden' || this.state === 'vanish') && this.bl) {
      const b = this.bl;
      o.bl = [Math.round(b.timer * 100) / 100, Math.round(b.warn * 100) / 100, b.show ? 1 : 0, b.show ? r1(b.tx) : 0, b.show ? r1(b.ty) : 0, b.decoys.map(d => [r1(d.x), r1(d.y)])];
    }
    return o;
  }
}

class Sim {
  constructor(players, modeKey, emit) {
    this.D = MODES[modeKey] || MODES.normal; this.modeKey = modeKey;
    this.players = players; this.emit = emit; this.t = 0; this.voids = []; this.nextId = 1; this.over = false;
    this.deadOrder = []; this.darkT = rand(22, 38); this.darkLeft = 0;
    const n = players.length;
    players.forEach((p, i) => {
      const a = i / n * Math.PI * 2 - Math.PI / 2;
      p.x = W / 2 + Math.cos(a) * 250; p.y = H / 2 + Math.sin(a) * 190; p.vx = p.vy = 0; p.fx = Math.cos(a + Math.PI); p.fy = Math.sin(a + Math.PI);
      p.alive = true; p.sink = 0; p.ema = 0; p.dashLog = []; p.dist = 0; p.perkN = 0; p.shieldUntil = 0; p.pushCd = 0; p.deadT = 0; p.lastX = p.x; p.lastY = p.y;
    });
    const first = n >= 5 ? 2 : 1;
    for (let i = 0; i < first; i++) this.voids.push(new Void(this, this.nextId++, i ? 0.85 : 1, 2.0 + i * 1.2));
  }
  alive() { return this.players.filter(p => p.alive); }
  un(k) { return CFG.unlock[k] * this.D.unlock * 0.8; }

  /* a player reports where it is; bounds and distance are checked, then perks are earned by moving */
  report(p, x, y, vx, vy, dashing, lat) {
    if (!p.alive) return;
    x = clamp(+x || 0, PM, W - PM); y = clamp(+y || 0, PM, H - PM);
    const step = Math.hypot(x - p.x, y - p.y);
    if (step > 260) { /* implausible jump: ignore */ return; }
    p.dist += Math.min(step, 40);
    if (lat !== undefined) p.lat = clamp((+lat || 0) / 2000, 0, 0.15);
    p.x = x; p.y = y; p.vx = clamp(+vx || 0, -1500, 1500); p.vy = clamp(+vy || 0, -1500, 1500); p.dashing = !!dashing;
    const need = 2200 + p.perkN * 400;
    if (p.dist >= need) {
      p.dist -= need; p.perkN++;
      const pk = PERKS[Math.floor(Math.random() * PERKS.length)];
      if (pk[0] === 'shield') p.shieldUntil = this.t + pk[1];
      this.emit({ k: 'perk', to: p.id, p: pk[0], d: pk[1] });
    }
  }
  noteDash(p) { p.dashLog.push(this.t); if (p.dashLog.length > 12) p.dashLog.shift(); }

  /* a shove; returns the target or null */
  push(p) {
    if (!p.alive || this.t < p.pushCd) return null;
    let best = null, bd = 95;
    for (const o of this.alive()) { if (o === p) continue; const d = Math.hypot(o.x - p.x, o.y - p.y); if (d < bd) { bd = d; best = o; } }
    if (!best) { p.pushCd = this.t + 0.7; this.emit({ k: 'pushno', to: p.id }); return null; }
    p.pushCd = this.t + 2.6;
    const dx = best.x - p.x, dy = best.y - p.y, l = Math.hypot(dx, dy) || 1;
    this.emit({ k: 'shove', to: best.id, dx: r1(dx / l), dy: r1(dy / l), from: p.id });
    this.emit({ k: 'shove', to: p.id, dx: r1(-dx / l), dy: r1(-dy / l), from: best.id, r: 1 });
    this.emit({ k: 'push', a: p.id, b: best.id });
    return best;
  }

  kill(p, v, cause) {
    if (!p.alive) return;
    p.alive = false; p.deadT = this.t; this.deadOrder.push(p);
    this.emit({ k: 'die', id: p.id, t: Math.round(this.t * 10) / 10, vx: v ? r1(v.x) : p.x, vy: v ? r1(v.y) : p.y, cause: cause || 'void' });
  }
  playerLeft(p) { if (p.alive) this.kill(p, null, 'left'); }

  update(dt) {
    if (this.over) return;
    this.t += dt;
    for (const p of this.players) {
      if (!p.alive) continue;
      const sp = Math.hypot(p.vx, p.vy); p.ema += (sp - p.ema) * Math.min(1, dt * 1.5);
      if (sp > 20) { p.fx = p.vx / sp; p.fy = p.vy / sp; }
    }
    for (const v of this.voids) v.update(dt);
    const al = this.alive().length;
    if (this.t >= this.un('second') && this.voids.length < 2 && al > 2) this.voids.push(new Void(this, this.nextId++, 0.85, 0.8));
    if (this.t >= this.un('third') && this.voids.length < 3 && al > 3) this.voids.push(new Void(this, this.nextId++, 0.7, 0.8));
    for (let i = 0; i < this.voids.length; i++) for (let j = i + 1; j < this.voids.length; j++) {
      const a = this.voids[i], b = this.voids[j];
      if (a.state !== 'stalk' || b.state !== 'stalk') continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, min = a.effR() + b.effR();
      if (d < min) { const p = (min - d) * 0.5; a.x -= dx / d * p; a.y -= dy / d * p; b.x += dx / d * p; b.y += dy / d * p; }
    }
    // who is falling (the zone shrinks with the player's latency so lag never kills from a distance)
    for (const p of this.alive()) {
      let rate = 0, who = null;
      for (const v of this.voids) {
        if (v.state === 'hidden' || v.grow < 0.8) continue;
        const er = v.effR(), d = Math.hypot(v.x - p.x, v.y - p.y), vsp = v.lx === undefined ? 0 : Math.hypot(v.x - v.lx, v.y - v.ly) / Math.max(dt, 0.001), zone = er * (v.state === 'dash' ? 0.8 : 0.9) - Math.min(70, vsp * (p.lat || 0) * 1.5);
        if (d < zone) { const r = v.state === 'dash' ? 1 / 0.06 : 1 / this.D.sink; if (r > rate) { rate = r; who = v; } }
      }
      if (who && this.t > p.shieldUntil) { p.sink += rate * dt; p.sinkV = who; }
      else p.sink = Math.max(0, p.sink - dt * 3.5);
      if (p.sink >= 1) this.kill(p, p.sinkV, 'void');
    }
    for (const v of this.voids) { v.lx = v.x; v.ly = v.y; }
    // the lights go out for everyone, and the void gets bolder in the dark
    this.darkT -= dt;
    if (this.darkLeft > 0) this.darkLeft -= dt;
    if (this.darkT <= 0 && this.t > 12) {
      this.darkT = rand(26, 48); this.darkLeft = rand(2, 3.2);
      this.emit({ k: 'dark', d: Math.round(this.darkLeft * 10) / 10 });
      const v = this.voids[Math.floor(Math.random() * this.voids.length)];
      if (v && v.state === 'stalk') v.cd = Math.min(v.cd, 0.6);
    }
    if (this.alive().length <= 1) this.over = true;
  }

  winner() { const a = this.alive(); return a.length ? a[0] : (this.deadOrder[this.deadOrder.length - 1] || null); }

  snapshot() {
    return {
      t: 's', n: Math.round(this.t * 100) / 100,
      p: this.players.map(p => [p.id, r1(p.x), r1(p.y), Math.round(p.vx), Math.round(p.vy), p.alive ? 1 : 0, Math.round(clamp(p.sink, 0, 1) * 100) / 100, this.t < p.shieldUntil ? 1 : 0, p.dashing ? 1 : 0]),
      v: this.voids.map(v => v.pack())
    };
  }
}

module.exports = { Sim, MODES, CFG, W, H, PM };
