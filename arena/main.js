// Arena: menus, input, the host loop (runs the real match with sim.js) and the client loop
// (sends input, predicts its own ball, and draws everyone else slightly in the past from snapshots).

import * as S from './sim.js';
import { hostRoom, joinRoom, cleanCode } from './net.js';
import { createRenderer, TEAM_COLOR } from './render.js';

const $ = id => document.getElementById(id);
const canvas = $('arena');
const R = createRenderer(canvas);
R.resize();
new ResizeObserver(() => R.resize()).observe(canvas);

const INTERP = 110;       // ms that clients draw other balls in the past, to smooth over network jitter
const SNAP_EVERY = 2;     // host sends a snapshot every 2 ticks (15 per second)
const TEAM_NAME = { red: 'Red', blue: 'Blue' };
const lerp = (a, b, k) => a + (b - a) * k;
const lerpAngle = (a, b, k) => a + (((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * k;

// ---------- session ----------
let mode = null;          // 'host' | 'client' | null while in the main menu
let practice = false;
let game = null;          // host only: the authoritative match
let room = null;          // network handle (host room or client connection); null offline
let myId = null;
let info = { phase: 'lobby', players: [], score: [0, 0], winner: null }; // names, teams and stats from the host
let leaving = false;

// Host only.
let queues = {}, acks = {}, outEvents = [], tickN = 0;
// Client only.
let snaps = [], latest = null, clockOff = null, pred = null, pending = [], seq = 0, localShots = [], localCool = 0;
let lastShotId = 0, ping = null, pingTimer = 0;

function resetSession() {
  mode = null; practice = false; game = null; room = null; myId = null;
  info = { phase: 'lobby', players: [], score: [0, 0], winner: null };
  queues = {}; acks = {}; outEvents = []; tickN = 0;
  snaps = []; latest = null; clockOff = null; pred = null; pending = []; seq = 0; localShots = []; localCool = 0;
  lastShotId = 0; ping = null; pingTimer = 0; switchReq = null;
}

const nameOf = id => (info.players.find(p => p.id === id) || {}).name || '?';
const teamOf = id => (info.players.find(p => p.id === id) || {}).team;
const myTeam = () => teamOf(myId);

// The loadout for the next life; remembered between visits.
let myClass = 'lightning';
try { myClass = S.CLASS_IDS.includes(localStorage.getItem('arena-class')) ? localStorage.getItem('arena-class') : 'lightning'; } catch {}
function chooseClass(cls) {
  if (!S.CLASS_IDS.includes(cls)) return;
  myClass = cls;
  try { localStorage.setItem('arena-class', cls); } catch {}
  if (mode === 'host' && game.players[myId]) game.players[myId].nextCls = cls;
  if (mode === 'client' && room) room.send({ t: 'cls', cls });
  updateClassButtons();
}

// My own state as the host knows it: { alive, hp, weapon, cls, ammo, lg, rk, gr, reloadT, respawnT, ... }.
function myStats() {
  if (mode === 'host') return game && game.players[myId];
  return latest && latest.players.get(myId);
}

// ---------- input ----------
const keys = {};
const mouse = { x: null, y: null, down: false };
let reloadPressed = false, lastAim = 0, switchReq = null, prevWeapon = null, showStats = false;

function requestWeapon(w) {
  const st = myStats();
  if (!st || !st.alive || !S.LOADOUT[st.cls].includes(w)) return;
  const current = shownWeapon();
  if (w === current) return;
  prevWeapon = current;
  switchReq = { w, t: performance.now(), sent: false };
}
// The weapon to show as "in hand": a fresh switch request wins until the host confirms it.
function shownWeapon() {
  const st = myStats();
  if (!st) return 'blaster';
  if (switchReq && performance.now() - switchReq.t < 400 && S.LOADOUT[st.cls].includes(switchReq.w)) return switchReq.w;
  return st.weapon;
}

addEventListener('keydown', e => {
  audio();
  if (e.target.tagName === 'INPUT') {
    if (e.key === 'Enter') (e.target.id === 'joinCode' ? join : createOnline)();
    return;
  }
  if (!mode) return;
  if (e.code === 'Tab') { e.preventDefault(); showScores(true); return; }
  if (e.code === 'Escape') { if (info.phase === 'play') $('pause').hidden = !$('pause').hidden; return; }
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'KeyF') { showStats = !showStats; $('stats').hidden = !showStats; }
  if (e.code === 'KeyR') reloadPressed = true;
  if (e.code === 'KeyC') chooseClass(myClass === 'lightning' ? 'demo' : 'lightning');
  const st = myStats();
  if (st && /^Digit[1-3]$/.test(e.code)) { const w = S.LOADOUT[st.cls][+e.code.slice(5) - 1]; if (w) requestWeapon(w); }
  if (st && e.code === 'KeyQ' && prevWeapon) requestWeapon(prevWeapon);
  keys[e.code] = true;
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Tab') showScores(false); });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.down = false; showScores(false); });
canvas.addEventListener('pointermove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('pointerdown', e => { if (e.button === 0) { mouse.down = true; audio(); } });
addEventListener('pointerup', e => { if (e.button === 0) mouse.down = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  const st = myStats();
  if (!st || !st.alive) return;
  e.preventDefault();
  const list = S.LOADOUT[st.cls], i = list.indexOf(shownWeapon());
  requestWeapon(list[(i + (e.deltaY > 0 ? 1 : -1) + list.length) % list.length]);
}, { passive: false });

function readInput() {
  const k = c => (keys[c] ? 1 : 0);
  const active = $('pause').hidden;
  const mx = active ? k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft') : 0;
  const my = active ? k('KeyS') + k('ArrowDown') - k('KeyW') - k('ArrowUp') : 0;
  if (mouse.x != null) lastAim = Math.atan2(mouse.y - R.meScreen.y, mouse.x - R.meScreen.x);
  let sw = null;
  if (switchReq && !switchReq.sent) { sw = switchReq.w; switchReq.sent = true; }
  const inp = { mx: Math.sign(mx), my: Math.sign(my), aim: lastAim, fire: active && mouse.down, reload: reloadPressed, sw, cls: myClass };
  reloadPressed = false;
  return inp;
}

// ---------- sound ----------
let ac = null, muted = false, noiseBuf = null;
try { muted = localStorage.getItem('arena-muted') === '1'; } catch {}
function audio() {
  if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}
function tone(f, f2, d, type = 'square', v = 0.06, delay = 0) {
  if (muted || v < 0.003) return;
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + d);
  g.gain.setValueAtTime(v, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + d + 0.02);
}
function noise(d, v, cutoff) {
  if (muted || v < 0.003) return;
  const a = audio();
  if (!a) return;
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(), t = a.currentTime;
  src.buffer = noiseBuf;
  f.type = 'lowpass'; f.frequency.setValueAtTime(cutoff, t); f.frequency.exponentialRampToValueAtTime(60, t + d);
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  src.connect(f).connect(g).connect(a.destination);
  src.start(t); src.stop(t + d);
}
const SFX = {
  shoot: (v = 1) => tone(880, 220, 0.09, 'square', 0.045 * v),
  rocket: (v = 1) => { tone(260, 90, 0.25, 'sawtooth', 0.05 * v); noise(0.25, 0.08 * v, 2500); },
  grenade: (v = 1) => tone(330, 140, 0.12, 'square', 0.06 * v),
  zap: (v = 1) => tone(90 + Math.random() * 40, 60, 0.1, 'sawtooth', 0.04 * v),
  boom: (v = 1) => { noise(0.6, 0.35 * v, 900); tone(110, 35, 0.5, 'sine', 0.2 * v); },
  hit: () => tone(1600, 1300, 0.05, 'triangle', 0.1),
  kill: () => { tone(900, 1800, 0.12, 'triangle', 0.09); tone(1350, 2400, 0.12, 'triangle', 0.06, 0.06); },
  hurt: () => tone(190, 70, 0.18, 'sawtooth', 0.08),
  die: () => tone(420, 40, 0.6, 'sawtooth', 0.09),
  spawn: () => tone(220, 880, 0.3, 'sine', 0.07),
  pick: () => [523, 659, 784].forEach((f, i) => tone(f, f, 0.12, 'triangle', 0.08, i * 0.07)),
  alarm: () => [880, 660, 880, 660].forEach((f, i) => tone(f, f, 0.1, 'sawtooth', 0.05, i * 0.12)),
  cap: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, f * 1.01, 0.2, 'triangle', 0.09, i * 0.1)),
  sad: () => [392, 330, 262].forEach((f, i) => tone(f, f, 0.2, 'triangle', 0.07, i * 0.12)),
};
const nearVolume = (x, y, range = 20) => {
  const me = mePos();
  return me ? Math.max(0, 1 - Math.hypot(x - me.x, y - me.y) / range) : 0.5;
};
function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('arena-muted', muted ? '1' : '0'); } catch {}
  $('mute').textContent = muted ? '🔇 Muted' : '🔊 Sound';
}
$('mute').textContent = muted ? '🔇 Muted' : '🔊 Sound';
$('mute').addEventListener('click', toggleMute);

// ---------- HUD helpers ----------
function feed(parts) {
  const d = document.createElement('div');
  for (const [text, color] of parts) {
    const s = document.createElement('span');
    s.textContent = text;
    if (color) s.style.color = color;
    d.append(s);
  }
  const box = $('feed');
  box.prepend(d);
  while (box.children.length > 5) box.lastChild.remove();
  setTimeout(() => d.remove(), 6000);
}
const who = id => [nameOf(id), TEAM_COLOR[teamOf(id)] || '#e8eeff'];
let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
const hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }
function setHTML(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).innerHTML = v; } }
function setStyle(id, prop, v) { const k = id + prop; if (hudCache[k] !== v) { hudCache[k] = v; $(id).style[prop] = v; } }

// ---------- events from the match (same handling on host and clients) ----------
function playerPos(id) {
  if (mode === 'host') return game.players[id];
  return latest && latest.players.get(id);
}
function mePos() {
  if (mode === 'host') return game && game.players[myId];
  return pred;
}
let zapT = 0;
function handleEvents(evs) {
  const mine = myTeam();
  for (const e of evs) {
    switch (e.k) {
      case 'hit':
        if (e.a === myId && e.v !== myId) { R.fx.marker(false); SFX.hit(); }
        if (e.v === myId && !e.shield) { R.fx.flash(0.32); R.fx.shake(0.3); SFX.hurt(); }
        R.fx.spark(e.x, e.y, TEAM_COLOR[teamOf(e.a)] || '#fff', 5);
        break;
      case 'zap':
        R.fx.spark(e.x, e.y, TEAM_COLOR[e.t], 4, 3);
        break;
      case 'boom': {
        R.fx.boom(e.x, e.y, e.r, TEAM_COLOR[e.t]);
        const v = nearVolume(e.x, e.y, 26);
        SFX.boom(Math.max(0.15, v));
        if (v > 0.6) R.fx.shake(0.6 * v);
        break;
      }
      case 'kill': {
        feed(e.a === e.v ? [who(e.v), [' self-destructed', '#8d9cc4']] : [who(e.a), [' ⟶ ', '#8d9cc4'], who(e.v)]);
        const v = playerPos(e.v);
        if (v) R.fx.burst(v.x, v.y, TEAM_COLOR[teamOf(e.v)] || '#fff');
        if (e.a === myId && e.v !== myId) { R.fx.marker(true); SFX.kill(); }
        if (e.v === myId) SFX.die();
        break;
      }
      case 'pick':
        feed([who(e.p), [` took the ${TEAM_NAME[e.f]} flag`, '#e8eeff']]);
        if (e.f === mine) { toast('Your flag was taken!'); SFX.alarm(); }
        else if (e.p === myId) { toast('You have the flag. Bring it home!'); SFX.pick(); }
        else SFX.pick();
        break;
      case 'drop':
        feed([[`${TEAM_NAME[e.f]} flag dropped`, TEAM_COLOR[e.f]]]);
        break;
      case 'ret':
        feed(e.p ? [who(e.p), [` returned the ${TEAM_NAME[e.f]} flag`, '#e8eeff']] : [[`${TEAM_NAME[e.f]} flag flew home`, TEAM_COLOR[e.f]]]);
        break;
      case 'cap': {
        feed([who(e.p), [' CAPTURED!', TEAM_COLOR[e.team]]]);
        toast(e.team === mine ? `${e.p === myId ? 'You' : nameOf(e.p)} scored for ${TEAM_NAME[e.team]}!` : `${TEAM_NAME[e.team]} scored`);
        const s = S.STANDS[e.team];
        R.fx.burst(s.x, s.y, TEAM_COLOR[e.team]);
        (e.team === mine ? SFX.cap : SFX.sad)();
        break;
      }
      case 'spawn':
        if (e.p === myId) { SFX.spawn(); switchReq = null; prevWeapon = null; }
        break;
      case 'start':
        toast('Capture the enemy flag!');
        break;
      case 'over':
        (e.winner === mine ? SFX.cap : SFX.sad)();
        break;
    }
  }
}

// Weapon sounds: your own blaster is played the moment you fire; everything else gets quieter with distance.
function noteNewShots(shots) {
  for (const s of shots) {
    if (s.id <= lastShotId) continue;
    lastShotId = Math.max(lastShotId, s.id);
    const own = s.owner === myId;
    if (own && mode === 'client' && s.kind === 'bolt') continue;
    const v = own ? 1 : nearVolume(s.x, s.y) * 0.6;
    if (s.kind === 'rocket') SFX.rocket(v);
    else if (s.kind === 'grenade') SFX.grenade(v);
    else SFX.shoot(v);
  }
}
// The lightning gun crackles while any beam is close by.
function beamSound(beams, dt) {
  zapT -= dt;
  if (zapT > 0 || !beams.length) return;
  zapT = 0.1;
  let v = 0;
  for (const b of beams) v = Math.max(v, b.mine ? 1 : nearVolume(b.x1, b.y1) * 0.6);
  SFX.zap(v);
}

// ---------- host ----------
function onJoin(id, hello) {
  const name = String(hello.name || '').trim().slice(0, 14) || 'Pilot';
  const cls = S.CLASS_IDS.includes(hello.cls) ? hello.cls : 'lightning';
  if (S.playerCount(game) >= S.TEAM_SIZE * 2) {
    // Full: a real player takes a bot's place.
    const bot = Object.values(game.players).find(p => p.bot);
    if (!bot) return 'This game is full (8 players).';
    const team = bot.team;
    S.removePlayer(game, bot.id);
    S.addPlayer(game, { id, name, team, cls });
  } else {
    S.addPlayer(game, { id, name, cls });
  }
  queues[id] = []; acks[id] = 0;
  feed([[name, TEAM_COLOR[game.players[id].team]], [' joined', '#8d9cc4']]);
}
function onClientData(id, msg) {
  const p = game.players[id];
  if (!p || !msg) return;
  if (msg.t === 'in') {
    const q = queues[id] || (queues[id] = []);
    q.push(msg);
    if (q.length > 30) q.shift();
  } else if (msg.t === 'team' && game.phase === 'lobby') {
    S.setTeam(game, id, msg.team === 'red' ? 'red' : 'blue');
  } else if (msg.t === 'cls' && S.CLASS_IDS.includes(msg.cls)) {
    p.nextCls = msg.cls;
  } else if (msg.t === 'ping') {
    room.send(id, { t: 'pong', c: msg.c });
  }
}
function onLeave(id) {
  const p = game && game.players[id];
  if (!p) return;
  feed([[p.name, TEAM_COLOR[p.team]], [' left', '#8d9cc4']]);
  S.removePlayer(game, id);
  delete queues[id]; delete acks[id];
}

const cleanWeapon = w => (S.WEAPON_IDS.includes(w) ? w : null);
function hostTick() {
  const me = game.players[myId];
  if (me) Object.assign(me.input, readInput());
  for (const id in queues) {
    const p = game.players[id], q = queues[id];
    if (!p) continue;
    if (!q.length) { p.input.mx = p.input.my = 0; p.input.reload = false; continue; }
    // After a network hiccup inputs pile up; play the extra ones' movement now so the ball catches up.
    while (q.length > 3) {
      const i = q.shift();
      if (p.alive && game.phase === 'play') S.move(p, +i.mx || 0, +i.my || 0, S.TICK);
      if (i.sw) p.input.sw = cleanWeapon(i.sw);
      acks[id] = i.seq;
    }
    const i = q.shift();
    Object.assign(p.input, {
      mx: +i.mx || 0, my: +i.my || 0, aim: +i.aim || 0, fire: !!i.fire, reload: !!i.reload,
      sw: cleanWeapon(i.sw) || p.input.sw, cls: S.CLASS_IDS.includes(i.cls) ? i.cls : null,
    });
    acks[id] = i.seq;
  }
  S.step(game);
  const evs = game.events;
  game.events = [];
  handleEvents(evs);
  noteNewShots(game.shots);
  if (room) outEvents.push(...evs);
  tickN++;
  if (game.rosterDirty) {
    game.rosterDirty = false;
    info = S.roster(game);
    if (room) room.broadcast(info);
    updateScreens();
  }
  if (room && tickN % SNAP_EVERY === 0 && game.phase !== 'lobby') {
    const snap = S.snapshot(game);
    snap.ack = acks;
    snap.ev = outEvents;
    outEvents = [];
    room.broadcast(snap);
  } else if (game.phase === 'lobby') {
    outEvents = [];
  }
}

function startHosting(name, offline) {
  resetSession();
  mode = 'host';
  practice = offline;
  game = S.createGame();
  myId = 'h';
  S.addPlayer(game, { id: myId, name, team: 'red', cls: myClass });
  info = S.roster(game);
}

// ---------- client ----------
function onHostMessage(msg) {
  if (!msg) return;
  switch (msg.t) {
    case 'welcome': myId = msg.id; break;
    case 'refused': leave(msg.reason || 'The host refused the connection.'); break;
    case 'roster': info = msg; updateScreens(); break;
    case 'snap': onSnapshot(msg); break;
    case 'pong': ping = ping == null ? performance.now() - msg.c : lerp(ping, performance.now() - msg.c, 0.3); break;
  }
}
function onHostGone() {
  if (!leaving) leave('The host left the game.');
}

function onSnapshot(m) {
  const now = performance.now();
  const st = m.tick * S.TICK * 1000;
  // Map the host's clock onto ours, smoothed, so snapshots can be replayed at an even pace.
  clockOff = clockOff == null ? now - st : lerp(clockOff, now - st, 0.05);
  const snap = { st, recv: now, phase: m.phase, time: m.time, score: m.score, ...S.readSnapshot(m) };
  snaps.push(snap);
  while (snaps.length > 40) snaps.shift();
  latest = snap;

  // Reconcile our own ball: start from where the host says we are, then replay inputs it hasn't seen yet.
  const me = snap.players.get(myId);
  if (me) {
    const ack = (m.ack && m.ack[myId]) || 0;
    pending = pending.filter(i => i.seq > ack);
    if (!pred || !me.alive) {
      pred = { x: me.x, y: me.y, px: me.x, py: me.y, ex: 0, ey: 0 };
      if (!me.alive) pending = [];
    } else {
      const ox = pred.x, oy = pred.y;
      pred.x = me.x; pred.y = me.y;
      for (const i of pending) S.move(pred, i.mx, i.my, S.TICK);
      const dx = ox - pred.x, dy = oy - pred.y;
      if (Math.hypot(dx, dy) > 3) { pred.ex = pred.ey = 0; pred.px = pred.x; pred.py = pred.y; }
      else { pred.ex += dx; pred.ey += dy; }
    }
  }
  handleEvents(m.ev || []);
  noteNewShots(snap.shots.values());
}

function clientTick() {
  pingTimer -= S.TICK;
  if (pingTimer <= 0 && room) { pingTimer = 2; room.send({ t: 'ping', c: performance.now() }); }
  if (!latest || latest.phase !== 'play' || !myId) return;
  const inp = readInput();
  inp.seq = ++seq;
  room.send({ t: 'in', seq: inp.seq, mx: inp.mx, my: inp.my, aim: +inp.aim.toFixed(3), fire: inp.fire ? 1 : 0, reload: inp.reload ? 1 : 0, sw: inp.sw, cls: inp.cls });
  const me = latest.players.get(myId);
  localCool = Math.max(0, localCool - S.TICK);
  if (!pred || !me || !me.alive) return;
  pred.px = pred.x; pred.py = pred.y;
  S.move(pred, inp.mx, inp.my, S.TICK);
  pending.push(inp);
  if (pending.length > 90) pending.shift();
  // Show our own blaster bolt at once; the host decides whether it hits.
  const steady = me.weapon === 'blaster' && shownWeapon() === 'blaster';
  if (steady && inp.fire && localCool <= 0 && me.ammo > 0 && !(me.reloadT > 0)) {
    localCool = S.BLASTER.gap;
    const c = Math.cos(inp.aim), s = Math.sin(inp.aim);
    let x = pred.x + c * 0.5, y = pred.y + s * 0.5;
    if (S.wallAt(x, y)) { x = pred.x; y = pred.y; }
    localShots.push({ kind: 'bolt', x, y, vx: c * S.BLASTER.speed, vy: s * S.BLASTER.speed, team: myTeam(), dist: 0 });
    SFX.shoot();
  }
}

// ---------- the tick clock ----------
// A tiny worker keeps time, so a host's match keeps running even when its tab is in the background.
let simAcc = 0, simLast = performance.now();
function pump() {
  const now = performance.now();
  simAcc += Math.min(0.25, (now - simLast) / 1000);
  simLast = now;
  while (simAcc >= S.TICK) {
    simAcc -= S.TICK;
    if (mode === 'host') hostTick();
    else if (mode === 'client') clientTick();
  }
}
try {
  const worker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000 / 60);'], { type: 'text/javascript' })));
  worker.onmessage = pump;
} catch {
  setInterval(pump, 1000 / 60);
}

// ---------- building what to draw ----------
const muzzle = p => ({ x: p.x + Math.cos(p.aim) * 0.45, y: p.y + Math.sin(p.aim) * 0.45 });

function hostView() {
  const k = Math.min(1, simAcc / S.TICK);
  const carriers = new Set(S.TEAMS.map(t => game.flags[t].carrier).filter(Boolean));
  const players = Object.values(game.players).map(p => ({
    id: p.id, name: p.name, team: p.team, x: lerp(p.px, p.x, k), y: lerp(p.py, p.y, k),
    aim: p.id === myId ? lastAim : p.aim, hp: p.hp, alive: p.alive, shield: p.shieldT > 0, carrying: carriers.has(p.id),
    weapon: p.id === myId ? shownWeapon() : p.weapon, beam: p.beam,
  }));
  const shots = game.shots.map(s => ({ kind: s.kind, x: lerp(s.px, s.x, k), y: lerp(s.py, s.y, k), vx: s.vx, vy: s.vy, team: s.team, dist: s.dist }));
  const beams = players.filter(p => p.alive && p.beam).map(p => {
    const m = muzzle(p);
    return { x1: m.x, y1: m.y, x2: p.beam.x, y2: p.beam.y, team: p.team, mine: p.id === myId };
  });
  const flags = {};
  for (const t of S.TEAMS) { const f = game.flags[t]; flags[t] = { state: f.state, x: lerp(f.px, f.x, k), y: lerp(f.py, f.y, k), returnT: f.returnT }; }
  return { players, shots, beams, flags, stats: game.players[myId], time: game.time, score: [game.score.red, game.score.blue] };
}

function clientView(now, dt) {
  const t = now - clockOff - INTERP;
  let a = snaps[0], b = snaps[0];
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].st <= t) { a = snaps[i]; b = snaps[i + 1] || snaps[i]; break; }
  }
  const k = b === a ? 0 : Math.max(0, Math.min(1, (t - a.st) / (b.st - a.st)));
  const carriers = new Set(S.TEAMS.map(tm => b.flags[tm].carrier).filter(Boolean));
  const players = [];
  for (const pb of b.players.values()) {
    const pa = a.players.get(pb.id) || pb;
    const jump = Math.hypot(pa.x - pb.x, pa.y - pb.y) > 3;
    const r = info.players.find(p => p.id === pb.id) || { name: '?', team: 'red' };
    const src = k < 0.5 ? pa : pb;
    players.push({
      id: pb.id, name: r.name, team: r.team,
      x: jump ? pb.x : lerp(pa.x, pb.x, k), y: jump ? pb.y : lerp(pa.y, pb.y, k), aim: lerpAngle(pa.aim, pb.aim, k),
      hp: src.hp, alive: src.alive, shield: src.shield, carrying: carriers.has(pb.id), weapon: src.weapon, beam: src.beam,
    });
  }
  // Our own ball comes from prediction, not from the past.
  const me = latest.players.get(myId);
  const mine = players.find(p => p.id === myId);
  if (mine && pred && me) {
    const kk = Math.min(1, simAcc / S.TICK);
    const fade = Math.exp(-dt * 12);
    pred.ex *= fade; pred.ey *= fade;
    Object.assign(mine, {
      x: lerp(pred.px, pred.x, kk) + pred.ex, y: lerp(pred.py, pred.y, kk) + pred.ey, aim: lastAim,
      alive: me.alive, hp: me.hp, shield: me.shield, weapon: shownWeapon(), beam: null,
    });
  }
  const enemies = players.filter(p => p.alive && p.team !== myTeam());
  const beams = [];
  for (const p of players) {
    if (p.id === myId || !p.alive || !p.beam) continue;
    const m = muzzle(p);
    beams.push({ x1: m.x, y1: m.y, x2: p.beam.x, y2: p.beam.y, team: p.team });
  }
  // Our own lightning beam is traced locally, so it follows the mouse with no delay.
  if (mine && me && me.alive && me.weapon === 'lightning' && shownWeapon() === 'lightning' && mouse.down && $('pause').hidden && me.lg >= 1) {
    const end = S.traceBeam(mine.x, mine.y, mine.aim, enemies);
    const m = muzzle(mine);
    beams.push({ x1: m.x, y1: m.y, x2: end.x, y2: end.y, team: mine.team, mine: true });
  }
  const shots = [];
  for (const sb of b.shots.values()) {
    if (sb.owner === myId) continue;
    const sa = a.shots.get(sb.id);
    if (sa) shots.push({ ...sb, x: lerp(sa.x, sb.x, k), y: lerp(sa.y, sb.y, k) });
  }
  for (const sa of a.shots.values()) {
    if (sa.owner === myId || b.shots.has(sa.id)) continue;
    const dtS = (t - a.st) / 1000;
    if (dtS < 0.05) shots.push({ ...sa, x: sa.x + sa.vx * dtS, y: sa.y + sa.vy * dtS });
  }
  // Our own rockets and grenades: the newest known position, nudged forward to now.
  const ahead = Math.min(0.1, (now - latest.recv) / 1000);
  for (const s of latest.shots.values()) {
    if (s.owner === myId && s.kind !== 'bolt') shots.push({ ...s, x: s.x + s.vx * ahead, y: s.y + s.vy * ahead });
  }
  // Advance our own predicted bolts; they stop at walls and at enemies we can see.
  localShots = localShots.filter(s => {
    const n = Math.max(1, Math.ceil(S.BLASTER.speed * dt / 0.25));
    for (let i = 0; i < n; i++) {
      s.x += s.vx * dt / n; s.y += s.vy * dt / n; s.dist += S.BLASTER.speed * dt / n;
      if (S.wallAt(s.x, s.y) || s.dist > S.BLASTER.range) return false;
      if (enemies.some(p => (p.x - s.x) ** 2 + (p.y - s.y) ** 2 < S.RADIUS * S.RADIUS)) return false;
    }
    return true;
  });
  shots.push(...localShots);
  const flags = {};
  for (const tm of S.TEAMS) {
    const fa = a.flags[tm], fb = b.flags[tm];
    flags[tm] = { state: fb.state, x: lerp(fa.x, fb.x, k), y: lerp(fa.y, fb.y, k), returnT: fb.returnT };
    if (fb.carrier === myId && mine) { flags[tm].x = mine.x; flags[tm].y = mine.y; }
  }
  return { players, shots, beams, flags, stats: me, time: latest.time, score: latest.score };
}

const fmtTime = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function flagText(f) {
  if (f.state === 'home') return '⚑ home';
  if (f.state === 'carried') return '⚑ TAKEN';
  return `⚑ dropped ${Math.ceil(f.returnT)}`;
}
function ammoText(st, w) {
  if (w === 'blaster') return st.reloadT > 0 ? '…' : String(st.ammo);
  if (w === 'lightning') return String(Math.floor(st.lg));
  return String(w === 'rocket' ? st.rk : st.gr);
}

function updateHud(v) {
  setText('scoreRed', String(v.score[0]));
  setText('scoreBlue', String(v.score[1]));
  setText('timer', fmtTime(v.time));
  setText('flagRed', flagText(v.flags.red));
  setText('flagBlue', flagText(v.flags.blue));
  const st = v.stats;
  if (!st) return;
  setText('hpNum', `${st.hp} HP`);
  setStyle('hpFill', 'width', `${st.hp}%`);
  if (hudCache.low !== st.hp <= 40) { hudCache.low = st.hp <= 40; $('hpFill').classList.toggle('low', hudCache.low); }
  const inHand = shownWeapon();
  setHTML('weapons', S.LOADOUT[st.cls].map((w, i) =>
    `<div class="w${w === inHand ? ' on' : ''}" data-w="${w}"><kbd>${i + 1}</kbd>${S.WEAPON_NAME[w]}<b>${ammoText(st, w)}</b></div>`).join(''));
  const mine = myTeam(), theirs = S.other(mine || 'red');
  const carrying = v.flags[theirs] && info.phase === 'play' && v.players.some(p => p.id === myId && p.carrying);
  let center = '';
  if (!st.alive) center = `DISABLED<small>Back online in ${Math.max(1, Math.ceil(st.respawnT))}</small>`;
  else if (carrying) center = v.flags[mine].state === 'home'
    ? 'YOU HAVE THE FLAG<small>Bring it to your base</small>'
    : 'YOU HAVE THE FLAG<small>Your own flag is gone. Hold on until your team gets it back</small>';
  setHTML('center', center);
  const picking = !st.alive;
  if (hudCache.picking !== picking) { hudCache.picking = picking; $('classPick').hidden = !picking; }
  setText('nextClass', `Next life: ${S.CLASS_NAME[myClass]} · C to change`);
}

function updateClassButtons() {
  for (const b of document.querySelectorAll('[data-cls]')) b.classList.toggle('on', b.dataset.cls === myClass);
  hudCache.nextClass = null;
}

// If the frame rate stays low during a match, draw fewer pixels (down to 60% resolution).
const QUALITY_STEPS = [1, 0.8, 0.6];
let slowFor = 0, qualityStep = 0;
function adaptQuality() {
  if (!mode || info.phase !== 'play' || document.hidden) { slowFor = 0; return; }
  slowFor = fps < 45 ? slowFor + 1 : 0;
  if (slowFor >= 4 && qualityStep < QUALITY_STEPS.length - 1) {
    slowFor = 0;
    R.setQuality(QUALITY_STEPS[++qualityStep]);
  }
}

// ---------- frame loop ----------
let lastFrame = performance.now(), clock = 0, idleAngle = 0, fpsFrames = 0, fpsT = 0, fps = 0;
function frame(now) {
  pump();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  clock += dt;
  fpsFrames++; fpsT += dt;
  if (fpsT >= 0.5) { fps = Math.round(fpsFrames / fpsT); fpsFrames = 0; fpsT = 0; adaptQuality(); }
  const inMatch = mode && info.phase !== 'lobby' && (mode === 'host' || (latest && myId && clockOff != null));
  if (inMatch) {
    const v = mode === 'host' ? hostView() : clientView(now, dt);
    const st = v.stats;
    Object.assign(v, { me: myId, myTeam: myTeam(), time: clock, mouse, reloadT: st ? st.reloadT : 0, weapon: shownWeapon() });
    const hudTime = mode === 'host' ? game.time : latest.time;
    R.draw(v, dt);
    beamSound(v.beams, dt);
    updateHud({ ...v, time: hudTime });
  } else {
    // Menu backdrop: drift slowly around the empty arena.
    idleAngle += dt * 0.05;
    const flags = {};
    for (const t of S.TEAMS) flags[t] = { state: 'home', x: S.STANDS[t].x, y: S.STANDS[t].y, returnT: 0 };
    R.draw({
      idle: true, players: [], shots: [], flags, me: null, myTeam: null, time: clock, mouse: { x: null },
      camTarget: { x: S.MAP_W / 2 + Math.cos(idleAngle) * 10, y: S.MAP_H / 2 + Math.sin(idleAngle * 1.3) * 5 },
    }, dt);
  }
  if (showStats) setText('stats', `${fps} fps${qualityStep ? ` · ${Math.round(QUALITY_STEPS[qualityStep] * 100)}% res` : ''}${mode === 'client' ? ` · ping ${ping == null ? '…' : Math.round(ping)} ms` : mode === 'host' ? ' · you are the host' : ''}`);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- screens ----------
const SCREENS = ['menu', 'lobby', 'results'];
function show(screen) {
  for (const id of SCREENS) $(id).hidden = id !== screen;
  const playing = screen === null;
  $('hud').hidden = !playing;
  $('mute').hidden = !mode;
  if (!playing) { $('pause').hidden = true; showScores(false); }
}

function updateScreens() {
  if (!mode) { show('menu'); return; }
  const isHost = mode === 'host';
  for (const el of document.querySelectorAll('.host-only')) el.hidden = !isHost;
  if (info.phase === 'lobby') {
    show('lobby');
    $('codeBox').hidden = practice;
    renderTeams(isHost);
    const can = info.players.some(p => p.team === 'red') && info.players.some(p => p.team === 'blue');
    $('startBtn').disabled = !can;
    $('lobbyNote').textContent = isHost
      ? (can ? (practice ? 'Add bots, then start.' : 'Share the code. Start when everyone is in.') : 'Each team needs at least one player. Add a bot.')
      : 'Waiting for the host to start…';
  } else if (info.phase === 'play') {
    show(null);
  } else {
    show('results');
    const w = info.winner;
    $('resultTitle').textContent = w ? `${TEAM_NAME[w].toUpperCase()} WINS` : 'DRAW';
    $('resultTitle').style.color = w ? TEAM_COLOR[w] : '#e8eeff';
    $('resultScore').innerHTML = `<span style="color:${TEAM_COLOR.red}">${info.score[0]}</span> – <span style="color:${TEAM_COLOR.blue}">${info.score[1]}</span>`;
    fillScoreRows($('resultRows'));
    $('resultsNote').textContent = isHost ? '' : 'Waiting for the host…';
  }
  if (!$('scores').hidden) fillScoreRows($('scoreRows'));
}

function renderTeams(isHost) {
  for (const t of S.TEAMS) {
    const ul = $(t === 'red' ? 'listRed' : 'listBlue');
    const members = info.players.filter(p => p.team === t);
    ul.replaceChildren(...members.map(p => {
      const li = document.createElement('li');
      if (p.id === myId) li.className = 'me';
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === myId ? ' (you)' : '');
      const right = document.createElement('span');
      right.className = 'tag';
      right.textContent = p.bot ? 'BOT ' : p.id === 'h' ? 'HOST' : '';
      if (p.bot && isHost) {
        const x = document.createElement('button');
        x.textContent = '✕'; x.title = 'Remove bot'; x.dataset.kick = p.id;
        right.append(x);
      }
      li.append(name, right);
      return li;
    }));
    const add = document.querySelector(`[data-bot="${t}"]`);
    add.disabled = members.length >= S.TEAM_SIZE;
  }
}

function fillScoreRows(tbody) {
  const rows = [...info.players].sort((a, b) => (a.team === b.team ? b.caps - a.caps || b.kills - a.kills : a.team === 'red' ? -1 : 1));
  tbody.replaceChildren(...rows.map(p => {
    const tr = document.createElement('tr');
    tr.className = `${p.team}${p.id === myId ? ' me' : ''}`;
    for (const v of [p.name + (p.bot ? ' (bot)' : ''), p.caps, p.kills, p.deaths]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    return tr;
  }));
}

function showScores(on) {
  if (on && (!mode || info.phase !== 'play')) return;
  $('scores').hidden = !on;
  if (on) fillScoreRows($('scoreRows'));
}

// ---------- menu actions ----------
let savedName = '';
try { savedName = localStorage.getItem('arena-name') || ''; } catch {}
$('nameInput').value = savedName;
const hashCode = cleanCode(location.hash.slice(1));
if (hashCode.length === 4) $('joinCode').value = hashCode;

function myName() {
  const n = $('nameInput').value.trim().slice(0, 14) || 'Pilot';
  try { localStorage.setItem('arena-name', n); } catch {}
  return n;
}
function menuError(msg) { $('menuError').textContent = msg || ''; }
function setBusy(busy, label) {
  for (const id of ['createBtn', 'practiceBtn', 'joinBtn']) $(id).disabled = busy;
  if (label) menuError(label);
}

async function createOnline() {
  const name = myName();
  menuError('');
  setBusy(true, 'Creating game…');
  let r;
  try {
    r = await hostRoom({ onJoin, onData: onClientData, onLeave });
  } catch (e) {
    setBusy(false); menuError(e.message); return;
  }
  setBusy(false); menuError('');
  startHosting(name, false);
  room = r;
  $('roomCode').textContent = r.code;
  leaving = false;
  updateScreens();
}

function startPractice(fill = false) {
  startHosting(myName(), true);
  leaving = false;
  const perTeam = fill ? 4 : 3;
  while (S.teamCount(game, 'red') < perTeam) S.addBot(game, 'red');
  while (S.teamCount(game, 'blue') < perTeam) S.addBot(game, 'blue');
  info = S.roster(game);
  updateScreens();
}

async function join() {
  const code = cleanCode($('joinCode').value);
  if (code.length !== 4) { menuError('Enter the 4-letter game code.'); return; }
  const name = myName();
  setBusy(true, `Connecting to ${code}…`);
  let r;
  try {
    r = await joinRoom(code, { onData: onHostMessage, onClose: onHostGone });
  } catch (e) {
    setBusy(false); menuError(e.message); return;
  }
  setBusy(false); menuError('');
  resetSession();
  mode = 'client';
  room = r;
  leaving = false;
  room.send({ t: 'hello', name, cls: myClass });
  updateScreens();
}

function leave(reason) {
  leaving = true;
  if (room) room.close();
  resetSession();
  show('menu');
  menuError(reason || '');
}

$('createBtn').addEventListener('click', createOnline);
$('practiceBtn').addEventListener('click', () => startPractice());
$('joinBtn').addEventListener('click', join);
$('joinCode').addEventListener('input', e => { e.target.value = cleanCode(e.target.value); });
$('copyLink').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}#${room ? room.code : ''}`;
  try { await navigator.clipboard.writeText(link); $('copyLink').textContent = 'Copied!'; }
  catch { prompt('Copy this link:', link); }
  setTimeout(() => { $('copyLink').textContent = 'Copy invite link'; }, 1800);
});
document.querySelector('.teams').addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t || mode !== 'host') return;
  if (t.dataset.bot) S.addBot(game, t.dataset.bot);
  if (t.dataset.kick) S.removePlayer(game, t.dataset.kick);
});
for (const b of document.querySelectorAll('[data-cls]')) b.addEventListener('click', () => chooseClass(b.dataset.cls));
$('weapons').addEventListener('click', e => { const w = e.target.closest('[data-w]'); if (w) requestWeapon(w.dataset.w); });
updateClassButtons();
$('switchTeam').addEventListener('click', () => {
  const to = S.other(myTeam() || 'blue');
  if (mode === 'host') S.setTeam(game, myId, to);
  else if (room) room.send({ t: 'team', team: to });
});
$('startBtn').addEventListener('click', () => { if (mode === 'host' && S.canStart(game)) S.startMatch(game); });
$('toLobby').addEventListener('click', () => { if (mode === 'host') S.backToLobby(game); });
$('leaveLobby').addEventListener('click', () => leave());
$('resultsLeave').addEventListener('click', () => leave());
$('leaveGame').addEventListener('click', () => leave());
$('resume').addEventListener('click', () => { $('pause').hidden = true; });
addEventListener('beforeunload', () => { if (room) room.close(); });

// #test starts a full 4v4 bot match straight away (used for screenshots).
if (location.hash === '#test') { startPractice(true); S.startMatch(game); }
show(mode ? null : 'menu');
if (mode) updateScreens();
