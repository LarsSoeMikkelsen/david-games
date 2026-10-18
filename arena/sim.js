// Arena game rules: map, movement, weapons, capture the flag and bots.
// No DOM here, so the host (which runs the match), the clients (which reuse move() to predict
// their own robot) and the test page all share this file.

export const TICK = 1 / 30;       // seconds per simulation step
export const SPEED = 5;           // tiles per second
export const BODY = 0.38;         // a robot is a ball with this radius, in tiles
export const RADIUS = 0.42;       // how close a projectile must pass to hit
export const MAX_HP = 100;
export const RESPAWN = 4;
export const SHIELD = 1.5;        // spawn protection, ends early when you shoot
export const FLAG_RETURN = 20;    // a dropped flag flies home after this many seconds
export const TOUCH = 0.8;         // pick-up distance for flags
export const CAPS_TO_WIN = 3;
export const MATCH_TIME = 600;
export const TEAM_SIZE = 4;
export const TEAMS = ['red', 'blue'];
export const other = team => (team === 'red' ? 'blue' : 'red');

// ---------- weapons ----------
// Everyone carries the blaster. The loadout chosen for each life adds either the lightning gun
// or the rocket and grenade launchers.
export const BLASTER = { damage: 20, gap: 0.25, speed: 40, range: 22, cell: 20, reload: 1.5 };
export const LIGHTNING = { damage: 6, gap: 0.1, range: 9, max: 80, regen: 6, regenDelay: 1 }; // max = 8 s of beam
export const ROCKET = { gap: 0.8, speed: 16, life: 3, radius: 2.2, max: 90, min: 15, ammo: 6 };
export const GRENADE = { gap: 0.65, speed: 13, friction: 1.4, bounce: 0.6, fuse: 1.6, radius: 2.5, max: 80, min: 15, ammo: 6 };
export const SPLASH_REFILL = 3;   // seconds per rocket/grenade restored
export const SELF_DAMAGE = 0.5;
export const WEAPON_IDS = ['blaster', 'lightning', 'rocket', 'grenade'];
export const WEAPON_NAME = { blaster: 'Blaster', lightning: 'Lightning', rocket: 'Rockets', grenade: 'Grenades' };
export const CLASS_IDS = ['lightning', 'demo'];
export const CLASS_NAME = { lightning: 'Lightning', demo: 'Demolition' };
export const LOADOUT = { lightning: ['blaster', 'lightning'], demo: ['blaster', 'rocket', 'grenade'] };
const SHOT_KINDS = ['bolt', 'rocket', 'grenade'];

// ---------- map ----------
// The top-left quarter; the full map mirrors it left-right and top-bottom, so both teams get the same layout.
const QUARTER = [
  '########################',
  '#...........#...........',
  '#...........#...........',
  '#...####....#....####...',
  '#...#.............#.....',
  '#...#.............#.....',
  '#.........####..........',
  '######....#.............',
  '#.........#.....##......',
  '#.........#.....##......',
  '#...##..........##......',
  '#...#...................',
  '#...#.......####........',
  '#.....................##',
  '#.....##..............##',
  '#.....................##',
];
const half = QUARTER.map(r => r + [...r].reverse().join(''));
export const MAP = half.concat([...half].reverse());
export const MAP_W = MAP[0].length;
export const MAP_H = MAP.length;

export const isWall = (tx, ty) => tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H || MAP[ty][tx] === '#';
export const wallAt = (x, y) => isWall(Math.floor(x), Math.floor(y));

export const STANDS = { red: { x: 3, y: MAP_H / 2 }, blue: { x: MAP_W - 3, y: MAP_H / 2 } };
const LEFT_SPAWNS = [[2, 12.5], [2, 19.5], [6.5, 13.5], [6.5, 18.5]];
export const SPAWNS = {
  red: LEFT_SPAWNS.map(([x, y]) => ({ x, y })),
  blue: LEFT_SPAWNS.map(([x, y]) => ({ x: MAP_W - x, y })),
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function hitsWall(x, y, r = BODY) {
  for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
    for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
      if (!isWall(tx, ty)) continue;
      const dx = x - clamp(x, tx, tx + 1), dy = y - clamp(y, ty, ty + 1);
      if (dx * dx + dy * dy < r * r - 1e-6) return true;
    }
  }
  return false;
}

// Moves the ball, then pushes it out of any wall it overlaps, so it slides along walls and rolls round corners.
export function move(p, mx, my, dt) {
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  p.x += mx * SPEED * dt;
  p.y += my * SPEED * dt;
  for (let iter = 0; iter < 4; iter++) {
    let pushed = false;
    for (let ty = Math.floor(p.y - BODY); ty <= Math.floor(p.y + BODY); ty++) {
      for (let tx = Math.floor(p.x - BODY); tx <= Math.floor(p.x + BODY); tx++) {
        if (!isWall(tx, ty)) continue;
        const dx = p.x - clamp(p.x, tx, tx + 1), dy = p.y - clamp(p.y, ty, ty + 1);
        const d = Math.hypot(dx, dy);
        if (d >= BODY || d === 0) continue;
        p.x += dx / d * (BODY - d);
        p.y += dy / d * (BODY - d);
        pushed = true;
      }
    }
    if (!pushed) break;
  }
}

export function lineOfSight(ax, ay, bx, by) {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.2);
  for (let i = 1; i < n; i++) if (wallAt(ax + (bx - ax) * i / n, ay + (by - ay) * i / n)) return false;
  return true;
}

// Where a lightning beam from (x, y) along `aim` stops: the first wall, or the first robot in `targets`.
export function traceBeam(x, y, aim, targets) {
  const c = Math.cos(aim), s = Math.sin(aim);
  const sx = x + c * 0.45, sy = y + s * 0.45;
  for (let d = 0; d <= LIGHTNING.range; d += 0.1) {
    const px = sx + c * d, py = sy + s * d;
    if (wallAt(px, py)) return { x: px, y: py, target: null };
    for (const t of targets) if ((t.x - px) ** 2 + (t.y - py) ** 2 < RADIUS * RADIUS) return { x: px, y: py, target: t };
  }
  return { x: sx + c * LIGHTNING.range, y: sy + s * LIGHTNING.range, target: null };
}

// Breadth-first search over tiles, 8 directions; diagonal steps need both side tiles free so bots don't clip corners.
export function findPath(sx, sy, gx, gy) {
  if (isWall(gx, gy) || isWall(sx, sy)) return [];
  const prev = new Int32Array(MAP_W * MAP_H).fill(-1);
  const start = sy * MAP_W + sx, goal = gy * MAP_W + gx;
  prev[start] = start;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi];
    if (k === goal) break;
    const x = k % MAP_W, y = (k / MAP_W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (isWall(nx, ny) || (dx && dy && (isWall(x + dx, y) || isWall(x, y + dy)))) continue;
      const nk = ny * MAP_W + nx;
      if (prev[nk] !== -1) continue;
      prev[nk] = k;
      queue.push(nk);
    }
  }
  if (prev[goal] === -1) return [];
  const path = [];
  for (let k = goal; k !== start; k = prev[k]) path.push({ x: k % MAP_W, y: (k / MAP_W) | 0 });
  return path.reverse();
}

// ---------- match state ----------
const BOT_NAMES = ['Vex', 'Orbit', 'Pixel', 'Bolt', 'Nova', 'Echo', 'Servo', 'Quark', 'Flux', 'Ion'];

function homeFlag(team) {
  return { team, state: 'home', x: STANDS[team].x, y: STANDS[team].y, px: STANDS[team].x, py: STANDS[team].y, carrier: null, returnT: 0 };
}

export function createGame() {
  return {
    phase: 'lobby', players: {}, shots: [], nextShot: 1, nextBot: 1,
    flags: { red: homeFlag('red'), blue: homeFlag('blue') },
    score: { red: 0, blue: 0 }, time: MATCH_TIME, winner: null,
    events: [], rosterDirty: true, tick: 0,
  };
}

export const teamCount = (g, team) => Object.values(g.players).filter(p => p.team === team).length;
export const smallerTeam = g => (teamCount(g, 'red') <= teamCount(g, 'blue') ? 'red' : 'blue');
export const playerCount = g => Object.keys(g.players).length;
const validClass = c => (CLASS_IDS.includes(c) ? c : 'lightning');

export function addPlayer(g, { id, name, bot = false, team = null, cls = null }) {
  team = team || smallerTeam(g);
  const p = {
    id, name, bot, team, x: STANDS[team].x, y: STANDS[team].y, px: 0, py: 0, aim: team === 'red' ? 0 : Math.PI,
    hp: MAX_HP, alive: false, respawnT: 0, shieldT: 0, cool: 0,
    cls: 'lightning', nextCls: bot ? CLASS_IDS[Math.floor(Math.random() * 2)] : validClass(cls), weapon: 'blaster',
    ammo: BLASTER.cell, reloadT: 0, lg: LIGHTNING.max, lgIdle: 0, rk: ROCKET.ammo, gr: GRENADE.ammo, refillT: 0, beam: null,
    kills: 0, deaths: 0, caps: 0,
    input: { mx: 0, my: 0, aim: 0, fire: false, reload: false, sw: null, cls: null },
    brain: null,
  };
  p.px = p.x; p.py = p.y;
  if (bot) {
    const mates = Object.values(g.players).filter(q => q.bot && q.team === team).length;
    p.brain = { path: [], replanT: 0, seeT: 0, wobble: 0, stuckT: 0, post: null, role: mates % 2 ? 'defend' : 'attack' };
  }
  g.players[id] = p;
  if (g.phase === 'play') spawn(g, p);
  g.rosterDirty = true;
  return p;
}

export function addBot(g, team) {
  if (teamCount(g, team) >= TEAM_SIZE) return null;
  const used = new Set(Object.values(g.players).map(p => p.name));
  const name = BOT_NAMES.find(n => !used.has(n)) || 'Bot';
  return addPlayer(g, { id: 'b' + g.nextBot++, name, bot: true, team });
}

export function removePlayer(g, id) {
  const p = g.players[id];
  if (!p) return;
  dropFlagOf(g, p);
  delete g.players[id];
  g.rosterDirty = true;
}

export function setTeam(g, id, team) {
  const p = g.players[id];
  if (!p || p.team === team || teamCount(g, team) >= TEAM_SIZE) return false;
  dropFlagOf(g, p);
  p.team = team;
  if (g.phase === 'play') spawn(g, p);
  g.rosterDirty = true;
  return true;
}

export const canStart = g => teamCount(g, 'red') > 0 && teamCount(g, 'blue') > 0;

export function startMatch(g) {
  g.phase = 'play';
  g.score = { red: 0, blue: 0 };
  g.time = MATCH_TIME;
  g.winner = null;
  g.shots = [];
  g.flags = { red: homeFlag('red'), blue: homeFlag('blue') };
  for (const p of Object.values(g.players)) { p.kills = p.deaths = p.caps = 0; spawn(g, p); }
  g.events.push({ k: 'start' });
  g.rosterDirty = true;
}

export function backToLobby(g) {
  g.phase = 'lobby';
  g.shots = [];
  g.rosterDirty = true;
}

function endMatch(g, winner) {
  g.phase = 'over';
  g.winner = winner;
  g.shots = [];
  for (const p of Object.values(g.players)) p.beam = null;
  g.events.push({ k: 'over', winner });
  g.rosterDirty = true;
}

function spawn(g, p) {
  const others = Object.values(g.players).filter(q => q !== p && q.alive);
  let best = null, bestD = -1;
  for (const s of SPAWNS[p.team]) {
    const d = others.length ? Math.min(...others.map(q => dist(q, s))) : 99;
    const score = d + Math.random() * 0.5;
    if (score > bestD) { bestD = score; best = s; }
  }
  if (p.bot && Math.random() < 0.3) p.nextCls = CLASS_IDS[Math.floor(Math.random() * 2)];
  p.cls = validClass(p.nextCls);
  Object.assign(p, {
    x: best.x, y: best.y, px: best.x, py: best.y, hp: MAX_HP, alive: true, respawnT: 0, shieldT: SHIELD,
    cool: 0, aim: p.team === 'red' ? 0 : Math.PI, weapon: LOADOUT[p.cls][1],
    ammo: BLASTER.cell, reloadT: 0, lg: LIGHTNING.max, lgIdle: 0, rk: ROCKET.ammo, gr: GRENADE.ammo, refillT: 0, beam: null,
  });
  if (p.brain) Object.assign(p.brain, { path: [], replanT: 0, seeT: 0, post: null });
  g.events.push({ k: 'spawn', p: p.id });
}

// ---------- one simulation step ----------
export function step(g, dt = TICK) {
  g.tick++;
  const list = Object.values(g.players);
  for (const p of list) { p.px = p.x; p.py = p.y; }
  for (const s of g.shots) { s.px = s.x; s.py = s.y; }
  for (const f of Object.values(g.flags)) { f.px = f.x; f.py = f.y; }
  if (g.phase !== 'play') return;
  g.time -= dt;
  for (const p of list) if (p.bot) think(g, p, dt);
  for (const p of list) updatePlayer(g, p, dt);
  updateShots(g, dt);
  if (g.phase === 'play') updateFlags(g, dt);
  if (g.phase === 'play' && g.time <= 0) {
    g.time = 0;
    endMatch(g, g.score.red === g.score.blue ? null : g.score.red > g.score.blue ? 'red' : 'blue');
  }
}

function updatePlayer(g, p, dt) {
  const inp = p.input;
  if (inp.cls && CLASS_IDS.includes(inp.cls)) p.nextCls = inp.cls;
  if (!p.alive) {
    p.respawnT -= dt;
    if (p.respawnT <= 0) spawn(g, p);
    return;
  }
  p.shieldT = Math.max(0, p.shieldT - dt);
  move(p, inp.mx, inp.my, dt);
  p.aim = inp.aim;
  p.cool = Math.max(0, p.cool - dt);
  if (inp.sw && inp.sw !== p.weapon && LOADOUT[p.cls].includes(inp.sw)) {
    p.weapon = inp.sw;
    p.cool = Math.max(p.cool, 0.2);
  }
  inp.sw = null;

  // Blaster cell reloads whichever weapon is in hand.
  if (p.reloadT > 0) {
    p.reloadT -= dt;
    if (p.reloadT <= 0) { p.reloadT = 0; p.ammo = BLASTER.cell; }
  } else if ((inp.reload && p.ammo < BLASTER.cell) || p.ammo === 0) {
    p.reloadT = BLASTER.reload;
  }
  // Rockets and grenades trickle back.
  if (p.rk < ROCKET.ammo || p.gr < GRENADE.ammo) {
    p.refillT += dt;
    if (p.refillT >= SPLASH_REFILL) { p.refillT = 0; p.rk = Math.min(ROCKET.ammo, p.rk + 1); p.gr = Math.min(GRENADE.ammo, p.gr + 1); }
  } else p.refillT = 0;

  p.beam = null;
  const c = Math.cos(p.aim), s = Math.sin(p.aim);
  const fireAt = (kind, speed) => {
    // Start at the muzzle, or at the robot's centre when pressed against a wall.
    let x = p.x + c * 0.5, y = p.y + s * 0.5;
    if (wallAt(x, y)) { x = p.x; y = p.y; }
    g.shots.push({ id: g.nextShot++, kind, owner: p.id, team: p.team, x, y, px: x, py: y, vx: c * speed, vy: s * speed, dist: 0, age: 0 });
  };
  if (p.weapon === 'lightning' && inp.fire && p.lg >= 1) {
    p.shieldT = 0;
    p.lgIdle = 0;
    const foes = Object.values(g.players).filter(q => q.alive && q.team !== p.team);
    const b = traceBeam(p.x, p.y, p.aim, foes);
    p.beam = { x: b.x, y: b.y };
    if (p.cool <= 0) {
      p.cool = LIGHTNING.gap;
      p.lg -= 1;
      if (b.target) damage(g, b.target, p.id, LIGHTNING.damage, b.x, b.y);
    }
  } else {
    p.lgIdle += dt;
    if (p.lgIdle > LIGHTNING.regenDelay) p.lg = Math.min(LIGHTNING.max, p.lg + LIGHTNING.regen * dt);
  }
  if (!inp.fire || p.cool > 0) return;
  if (p.weapon === 'blaster' && p.reloadT === 0 && p.ammo > 0) {
    p.cool = BLASTER.gap; p.ammo--; p.shieldT = 0;
    fireAt('bolt', BLASTER.speed);
  } else if (p.weapon === 'rocket' && p.rk > 0) {
    p.cool = ROCKET.gap; p.rk--; p.shieldT = 0;
    fireAt('rocket', ROCKET.speed);
  } else if (p.weapon === 'grenade' && p.gr > 0) {
    p.cool = GRENADE.gap; p.gr--; p.shieldT = 0;
    fireAt('grenade', GRENADE.speed);
  }
}

function touching(players, s, team, pad = 0) {
  for (const p of players) {
    if (!p.alive || p.team === team) continue;
    if ((p.x - s.x) ** 2 + (p.y - s.y) ** 2 < (RADIUS + pad) ** 2) return p;
  }
  return null;
}

function updateShots(g, dt) {
  const players = Object.values(g.players);
  const keep = [];
  for (const s of g.shots) {
    if (g.phase !== 'play') break;
    s.age += dt;
    if (s.kind === 'grenade') {
      const f = Math.exp(-GRENADE.friction * dt);
      s.vx *= f; s.vy *= f;
      let alive = true;
      const n = 3;
      for (let i = 0; i < n && alive; i++) {
        s.x += s.vx * dt / n;
        if (wallAt(s.x, s.y)) { s.x -= s.vx * dt / n; s.vx *= -GRENADE.bounce; }
        s.y += s.vy * dt / n;
        if (wallAt(s.x, s.y)) { s.y -= s.vy * dt / n; s.vy *= -GRENADE.bounce; }
        const hitP = touching(players, s, s.team, 0.05);
        if (hitP) { explode(g, s, GRENADE, hitP.id); alive = false; }
      }
      if (alive && s.age >= GRENADE.fuse) { explode(g, s, GRENADE, null); alive = false; }
      if (alive) keep.push(s);
      continue;
    }
    const speed = Math.hypot(s.vx, s.vy), total = speed * dt, n = Math.ceil(total / 0.25);
    let alive = true;
    for (let i = 0; i < n && alive; i++) {
      s.x += s.vx * dt / n;
      s.y += s.vy * dt / n;
      s.dist += total / n;
      if (wallAt(s.x, s.y)) {
        if (s.kind === 'rocket') { s.x -= s.vx * dt / n; s.y -= s.vy * dt / n; explode(g, s, ROCKET, null); }
        else g.events.push({ k: 'zap', x: +s.x.toFixed(2), y: +s.y.toFixed(2), t: s.team });
        alive = false;
        break;
      }
      const hitP = touching(players, s, s.team);
      if (hitP) {
        if (s.kind === 'rocket') explode(g, s, ROCKET, hitP.id);
        else damage(g, hitP, s.owner, BLASTER.damage, s.x, s.y);
        alive = false;
        break;
      }
      if (s.kind === 'bolt' && s.dist > BLASTER.range) alive = false;
      if (s.kind === 'rocket' && s.age > ROCKET.life) { explode(g, s, ROCKET, null); alive = false; }
    }
    if (alive) keep.push(s);
  }
  g.shots = g.phase === 'play' ? keep : [];
}

// Splash damage falls off with distance, is blocked by walls, never hurts teammates, and hurts the shooter at half strength.
function explode(g, s, spec, directId) {
  g.events.push({ k: 'boom', x: +s.x.toFixed(2), y: +s.y.toFixed(2), r: spec.radius, t: s.team, w: s.kind });
  for (const p of Object.values(g.players)) {
    if (!p.alive) continue;
    const self = p.id === s.owner;
    if (p.team === s.team && !self) continue;
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    if (d > spec.radius + BODY) continue;
    if (p.id !== directId && !lineOfSight(s.x, s.y, p.x, p.y)) continue;
    let dmg = p.id === directId ? spec.max : spec.max + (spec.min - spec.max) * clamp((d - BODY) / spec.radius, 0, 1);
    if (self) dmg *= SELF_DAMAGE;
    damage(g, p, s.owner, Math.round(dmg), p.x, p.y);
  }
}

function damage(g, p, attackerId, amount, x, y) {
  if (!p.alive) return;
  g.events.push({ k: 'hit', a: attackerId, v: p.id, x: +x.toFixed(2), y: +y.toFixed(2), d: amount, shield: p.shieldT > 0 ? 1 : 0 });
  if (p.shieldT > 0) return;
  p.hp -= amount;
  if (p.hp > 0) return;
  p.hp = 0;
  p.alive = false;
  p.beam = null;
  p.respawnT = RESPAWN;
  p.deaths++;
  const a = g.players[attackerId];
  if (a && a !== p) a.kills++;
  dropFlagOf(g, p);
  g.events.push({ k: 'kill', a: attackerId, v: p.id });
  g.rosterDirty = true;
}

// ---------- capture the flag ----------
const carrying = (g, p) => Object.values(g.flags).some(f => f.state === 'carried' && f.carrier === p.id);

function dropFlagOf(g, p) {
  for (const f of Object.values(g.flags)) {
    if (f.state !== 'carried' || f.carrier !== p.id) continue;
    Object.assign(f, { state: 'dropped', carrier: null, x: p.x, y: p.y, returnT: FLAG_RETURN });
    g.events.push({ k: 'drop', f: f.team, p: p.id });
  }
}

function sendHome(f) {
  Object.assign(f, { state: 'home', carrier: null, x: STANDS[f.team].x, y: STANDS[f.team].y, returnT: 0 });
}

function updateFlags(g, dt) {
  const alive = Object.values(g.players).filter(p => p.alive);
  for (const f of Object.values(g.flags)) {
    if (f.state === 'carried') {
      const c = g.players[f.carrier];
      if (c) { f.x = c.x; f.y = c.y; } else sendHome(f);
      continue;
    }
    if (f.state === 'dropped') {
      f.returnT -= dt;
      if (f.returnT <= 0) { sendHome(f); g.events.push({ k: 'ret', f: f.team, p: null }); continue; }
    }
    for (const p of alive) {
      if (dist(p, f) > TOUCH) continue;
      if (p.team !== f.team && !carrying(g, p)) {
        Object.assign(f, { state: 'carried', carrier: p.id });
        g.events.push({ k: 'pick', f: f.team, p: p.id });
        break;
      }
      if (p.team === f.team && f.state === 'dropped') {
        sendHome(f);
        g.events.push({ k: 'ret', f: f.team, p: p.id });
        break;
      }
    }
  }
  for (const p of alive) {
    const theirs = g.flags[other(p.team)];
    if (theirs.state !== 'carried' || theirs.carrier !== p.id) continue;
    if (g.flags[p.team].state !== 'home' || dist(p, STANDS[p.team]) > 1) continue;
    g.score[p.team]++;
    p.caps++;
    sendHome(theirs);
    g.events.push({ k: 'cap', p: p.id, team: p.team });
    g.rosterDirty = true;
    if (g.score[p.team] >= CAPS_TO_WIN) { endMatch(g, p.team); return; }
  }
}

// ---------- bots ----------
const BOT_RANGE = 14;

function botGoal(g, p) {
  const b = p.brain, mine = g.flags[p.team], theirs = g.flags[other(p.team)];
  if (theirs.carrier === p.id) return STANDS[p.team];
  // Defenders always hunt their stolen flag; attackers only when it is close by.
  if (mine.state !== 'home' && (b.role === 'defend' || dist(p, mine) < 10)) return mine;
  if (b.role === 'defend') {
    if (!b.post || Math.random() < 0.15) {
      const s = STANDS[p.team];
      for (let i = 0; i < 20; i++) {
        const x = Math.floor(s.x + (Math.random() - 0.5) * 12), y = Math.floor(s.y + (Math.random() - 0.5) * 12);
        if (!isWall(x, y)) { b.post = { x: x + 0.5, y: y + 0.5 }; break; }
      }
    }
    return b.post || STANDS[p.team];
  }
  if (theirs.state === 'carried') return g.players[theirs.carrier] || theirs;
  return theirs;
}

// Bots pick the weapon that suits the distance: lightning up close, rockets at range, grenades in the middle.
function botWeapon(p, d) {
  if (p.cls === 'lightning') return d < LIGHTNING.range - 0.5 && p.lg > 3 ? 'lightning' : 'blaster';
  if (p.rk > 0 && d > 3.5) return 'rocket';
  if (p.gr > 0 && d > 2.5 && d < 7) return 'grenade';
  return 'blaster';
}
const SPEED_OF = { blaster: BLASTER.speed, rocket: ROCKET.speed, grenade: GRENADE.speed, lightning: Infinity };

function think(g, p, dt) {
  const b = p.brain, inp = p.input;
  inp.reload = false;
  if (!p.alive) { inp.fire = false; inp.mx = inp.my = 0; return; }

  let foe = null, best = BOT_RANGE;
  for (const q of Object.values(g.players)) {
    if (!q.alive || q.team === p.team) continue;
    const d = dist(p, q);
    if (d < best && lineOfSight(p.x, p.y, q.x, q.y)) { best = d; foe = q; }
  }
  if (foe) {
    b.seeT += dt;
    b.wobble = b.wobble * 0.9 + (Math.random() - 0.5) * 0.25; // drifting aim error so bots miss now and then
    const want = botWeapon(p, best);
    if (want !== p.weapon) inp.sw = want;
    const lead = best / SPEED_OF[p.weapon];
    const tx = foe.x + (foe.x - foe.px) / dt * lead, ty = foe.y + (foe.y - foe.py) / dt * lead;
    inp.aim = Math.atan2(ty - p.y, tx - p.x) + b.wobble;
    inp.fire = b.seeT > 0.45;
  } else {
    b.seeT = 0;
    inp.fire = false;
    inp.reload = p.ammo < BLASTER.cell / 2;
  }

  b.replanT -= dt;
  if (b.replanT <= 0) {
    b.replanT = 0.5 + Math.random() * 0.3;
    const goal = botGoal(g, p);
    b.path = findPath(Math.floor(p.x), Math.floor(p.y), Math.floor(goal.x), Math.floor(goal.y));
  }
  while (b.path.length && Math.hypot(b.path[0].x + 0.5 - p.x, b.path[0].y + 0.5 - p.y) < 0.3) b.path.shift();
  if (b.path.length) {
    const t = b.path[0];
    inp.mx = t.x + 0.5 - p.x;
    inp.my = t.y + 0.5 - p.y;
    const len = Math.hypot(inp.mx, inp.my) || 1;
    inp.mx /= len; inp.my /= len;
    // Unstick: if the robot hasn't moved for a while, plan again from scratch.
    if (Math.hypot(p.x - p.px, p.y - p.py) < SPEED * dt * 0.2) b.stuckT += dt; else b.stuckT = 0;
    if (b.stuckT > 0.6) { b.stuckT = 0; b.replanT = 0; b.path = []; }
  } else {
    inp.mx = inp.my = 0;
  }
  if (!foe && (inp.mx || inp.my)) inp.aim = Math.atan2(inp.my, inp.mx);
}

// ---------- what the host sends ----------
const r2 = v => Math.round(v * 100) / 100;

export function snapshot(g) {
  return {
    t: 'snap', tick: g.tick, phase: g.phase, time: r2(g.time), score: [g.score.red, g.score.blue], winner: g.winner,
    p: Object.values(g.players).map(p => [
      p.id, r2(p.x), r2(p.y), r2(p.aim), p.hp, p.alive ? 1 : 0, p.shieldT > 0 ? 1 : 0, p.ammo, r2(p.reloadT), r2(p.respawnT),
      WEAPON_IDS.indexOf(p.weapon), CLASS_IDS.indexOf(p.cls), CLASS_IDS.indexOf(p.nextCls), Math.floor(p.lg), p.rk, p.gr,
      p.beam ? r2(p.beam.x) : -1, p.beam ? r2(p.beam.y) : -1,
    ]),
    s: g.shots.map(s => [s.id, r2(s.x), r2(s.y), r2(s.vx), r2(s.vy), s.team === 'red' ? 0 : 1, s.owner, SHOT_KINDS.indexOf(s.kind)]),
    f: TEAMS.map(t => { const f = g.flags[t]; return [f.state, r2(f.x), r2(f.y), f.carrier, r2(f.returnT)]; }),
  };
}

// The reverse of snapshot(), for clients.
export function readSnapshot(m) {
  const players = new Map(), shots = new Map(), flags = {};
  for (const a of m.p) {
    players.set(a[0], {
      id: a[0], x: a[1], y: a[2], aim: a[3], hp: a[4], alive: !!a[5], shield: !!a[6], ammo: a[7], reloadT: a[8], respawnT: a[9],
      weapon: WEAPON_IDS[a[10]], cls: CLASS_IDS[a[11]], nextCls: CLASS_IDS[a[12]], lg: a[13], rk: a[14], gr: a[15],
      beam: a[16] >= 0 ? { x: a[16], y: a[17] } : null,
    });
  }
  for (const a of m.s) shots.set(a[0], { id: a[0], x: a[1], y: a[2], vx: a[3], vy: a[4], team: a[5] ? 'blue' : 'red', owner: a[6], kind: SHOT_KINDS[a[7]] });
  TEAMS.forEach((t, i) => { const f = m.f[i]; flags[t] = { state: f[0], x: f[1], y: f[2], carrier: f[3], returnT: f[4] }; });
  return { players, shots, flags };
}

export function roster(g) {
  return {
    t: 'roster', phase: g.phase, winner: g.winner, score: [g.score.red, g.score.blue],
    players: Object.values(g.players).map(({ id, name, team, bot, kills, deaths, caps }) => ({ id, name, team, bot, kills, deaths, caps })),
  };
}
