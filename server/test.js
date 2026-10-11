// integration test: 4 bots, lobby rules, simulation, winner
process.env.PORT = 3111; process.env.MIN_PLAYERS = 3;
const { server } = require('./index.js'); const WebSocket = require('ws');
server.listen(3111, async () => {
  const log = (...a) => console.log(...a);
  const mk = (name, room, create) => new Promise(res => {
    const ws = new WebSocket('ws://localhost:3111'); const b = { ws, name, msgs: [], id: 0, x: 600, y: 400, vx: 0, vy: 0, alive: true };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room, name, create })));
    ws.on('message', d => { const m = JSON.parse(d); b.msgs.push(m); if (m.t === 'joined') { b.id = m.id; res(b); } b.on && b.on(m); });
    b.send = o => ws.send(JSON.stringify(o));
  });
  const host = await mk('Host', '', false); const room = host.msgs.find(m => m.t === 'room').code; log('room', room);
  const bots = [host]; for (const n of ['A', 'B']) bots.push(await mk(n, room, false));
  await new Promise(r => setTimeout(r, 200));
  host.send({ t: 'start' }); await new Promise(r => setTimeout(r, 200));
  log('start w/o ready ->', host.msgs.filter(m => m.t === 'err').map(m => m.code));
  bots[1].send({ t: 'ready', v: true }); bots[2].send({ t: 'ready', v: true }); await new Promise(r => setTimeout(r, 200));
  host.send({ t: 'mode', v: 'hard' });
  host.send({ t: 'start' }); await new Promise(r => setTimeout(r, 300));
  log('started?', host.msgs.some(m => m.t === 'start'));
  // late join gets err (promise never resolves) -> check by raw socket
  const raw = new WebSocket('ws://localhost:3111'); raw.on('open', () => raw.send(JSON.stringify({ t: 'join', room, name: 'L' }))); raw.on('message', d => log('late join ->', JSON.parse(d).code));
  // bots: A flees by circling, B and Host idle -> expect A to win
  let t = 0; const A = bots[1]; let a = 0;
  const iv = setInterval(() => {
    t += 33;
    const s = [...bots].reverse().map(b => b.msgs.filter(m => m.t === 'snap').pop()).filter(Boolean)[0];
    if (s) { const me = s.p.find(p => p[0] === A.id); if (me) { A.x = me[1]; A.y = me[2]; } }
    a += 0.05; A.x = 600 + Math.cos(a) * 300; A.y = 400 + Math.sin(a) * 200;
    A.send({ t: 'in', x: A.x, y: A.y, vx: 0, vy: 0, d: 0 });
  }, 33);
  const stop = setTimeout(() => done('timeout'), 60000);
  function done(why) {
    clearInterval(iv); clearTimeout(stop);
    const all = host.msgs; log('end:', why, 'snaps', all.filter(m => m.t === 'snap').length, 'cues', all.filter(m => m.t === 'cue').length, 'dark', all.filter(m => m.t === 'dark').length);
    log('dead:', all.filter(m => m.t === 'dead').map(m => m.name + '@' + m.time).join(', '));
    const o = all.find(m => m.t === 'over'); log('over:', o && JSON.stringify(o));
    process.exit(0);
  }
  host.on = m => { if (m.t === 'over') setTimeout(() => done('over'), 100); };
});
