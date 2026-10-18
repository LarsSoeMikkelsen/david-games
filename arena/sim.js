// Arena game rules: map, movement, shots, capture the flag and bots.
// No DOM here, so the host (which runs the match), the clients (which reuse move() to predict
// their own robot) and the test page all share this file.

export const TICK = 1 / 30;       // seconds per simulation step
export const SPEED = 5;           // tiles per second
export const HALF = 0.35;         // half-size of a robot's collision box, in tiles
export const RADIUS = 0.4;        // how close a shot must pass to hit
export const MAX_HP = 100;
export const DAMAGE = 20;
export const FIRE_GAP = 0.25;     // seconds between shots
export const SHOT_SPEED = 40;     // tiles per second
export const SHOT_RANGE = 22;     // tiles
export const CELL = 20;           // shots per energy cell
export const RELOAD = 1.5;
export const RESPAWN = 4;
export const SHIELD = 1.5;        // spawn protection, ends early when you shoot
export const FLAG_RETURN = 20;    // a dropped flag flies home after this many seconds
export const TOUCH = 0.8;         // pick-up distance for flags
export const CAPS_TO_WIN = 3;
export const MATCH_TIME = 600;
export const TEAM_SIZE = 4;
export const TEAMS = ['red', 'blue'];
export const other = team => (team === 'red' ? 'blue' : 'red');

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

export function boxHitsWall(x, y) {
  const x0 = Math.floor(x - HALF), x1 = Math.floor(x + HALF);
  const y0 = Math.floor(y - HALF), y1 = Math.floor(y + HALF);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (isWall(tx, ty)) return true;
  return false;
}

// Moves one axis at a time and stops flush against walls, so robots slide along them.
export function move(p, mx, my, dt) {
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  const dx = mx * SPEED * dt, dy = my * SPEED * dt;
  if (dx) {
    p.x += dx;
    if (boxHitsWall(p.x, p.y)) p.x = dx > 0 ? Math.floor(p.x + HALF) - HALF - 1e-4 : Math.floor(p.x - HALF) + 1 + HALF + 1e-4;
  }
  if (dy) {
    p.y += dy;
    if (boxHitsWall(p.x, p.y)) p.y = dy > 0 ? Math.floor(p.y + HALF) - HALF - 1e-4 : Math.floor(p.y - HALF) + 1 + HALF + 1e-4;
  }
}

export function lineOfSight(ax, ay, bx, by) {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.2);
  for (let i = 1; i < n; i++) if (wallAt(ax + (bx - ax) * i / n, ay + (by - ay) * i / n)) return false;
  return true;
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

export function addPlayer(g, { id, name, bot = false, team = null }) {
  team = team || smallerTeam(g);
  const p = {
    id, name, bot, team, x: STANDS[team].x, y: STANDS[team].y, px: 0, py: 0, aim: team === 'red' ? 0 : Math.PI,
    hp: MAX_HP, alive: false, respawnT: 0, shieldT: 0, ammo: CELL, reloadT: 0, cool: 0,
    kills: 0, deaths: 0, caps: 0,
    input: { mx: 0, my: 0, aim: 0, fire: false, reload: false },
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
  Object.assign(p, {
    x: best.x, y: best.y, px: best.x, py: best.y, hp: MAX_HP, alive: true, respawnT: 0, shieldT: SHIELD,
    ammo: CELL, reloadT: 0, cool: 0, aim: p.team === 'red' ? 0 : Math.PI,
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
  updateFlags(g, dt);
  if (g.phase === 'play' && g.time <= 0) {
    g.time = 0;
    endMatch(g, g.score.red === g.score.blue ? null : g.score.red > g.score.blue ? 'red' : 'blue');
  }
}

function updatePlayer(g, p, dt) {
  const inp = p.input;
  if (!p.alive) {
    p.respawnT -= dt;
    if (p.respawnT <= 0) spawn(g, p);
    return;
  }
  p.shieldT = Math.max(0, p.shieldT - dt);
  move(p, inp.mx, inp.my, dt);
  p.aim = inp.aim;
  p.cool = Math.max(0, p.cool - dt);
  if (p.reloadT > 0) {
    p.reloadT -= dt;
    if (p.reloadT <= 0) { p.reloadT = 0; p.ammo = CELL; }
  } else if ((inp.reload && p.ammo < CELL) || p.ammo === 0) {
    p.reloadT = RELOAD;
  }
  if (inp.fire && p.cool <= 0 && p.reloadT === 0 && p.ammo > 0) {
    p.cool = FIRE_GAP;
    p.ammo--;
    p.shieldT = 0;
    const c = Math.cos(p.aim), s = Math.sin(p.aim);
    const x = p.x + c * 0.5, y = p.y + s * 0.5;
    g.shots.push({ id: g.nextShot++, owner: p.id, team: p.team, x, y, px: x, py: y, vx: c * SHOT_SPEED, vy: s * SHOT_SPEED, dist: 0 });
  }
}

function updateShots(g, dt) {
  const players = Object.values(g.players);
  const total = SHOT_SPEED * dt, n = Math.ceil(total / 0.25);
  g.shots = g.shots.filter(s => {
    for (let i = 0; i < n; i++) {
      s.x += s.vx * dt / n;
      s.y += s.vy * dt / n;
      s.dist += total / n;
      if (wallAt(s.x, s.y)) { g.events.push({ k: 'zap', x: +s.x.toFixed(2), y: +s.y.toFixed(2), t: s.team }); return false; }
      for (const p of players) {
        if (!p.alive || p.team === s.team) continue;
        if ((p.x - s.x) ** 2 + (p.y - s.y) ** 2 < RADIUS * RADIUS) { hit(g, p, s); return false; }
      }
      if (s.dist > SHOT_RANGE) return false;
    }
    return true;
  });
}

function hit(g, p, s) {
  g.events.push({ k: 'hit', a: s.owner, v: p.id, x: +s.x.toFixed(2), y: +s.y.toFixed(2), shield: p.shieldT > 0 ? 1 : 0 });
  if (p.shieldT > 0) return;
  p.hp -= DAMAGE;
  if (p.hp > 0) return;
  p.hp = 0;
  p.alive = false;
  p.respawnT = RESPAWN;
  p.deaths++;
  const a = g.players[s.owner];
  if (a) a.kills++;
  dropFlagOf(g, p);
  g.events.push({ k: 'kill', a: s.owner, v: p.id });
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
    const lead = best / SHOT_SPEED;
    const tx = foe.x + (foe.x - foe.px) / dt * lead, ty = foe.y + (foe.y - foe.py) / dt * lead;
    inp.aim = Math.atan2(ty - p.y, tx - p.x) + b.wobble;
    inp.fire = b.seeT > 0.45;
  } else {
    b.seeT = 0;
    inp.fire = false;
    inp.reload = p.ammo < CELL / 2;
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
    p: Object.values(g.players).map(p => [p.id, r2(p.x), r2(p.y), r2(p.aim), p.hp, p.alive ? 1 : 0, p.shieldT > 0 ? 1 : 0, p.ammo, r2(p.reloadT), r2(p.respawnT)]),
    s: g.shots.map(s => [s.id, r2(s.x), r2(s.y), r2(s.vx), r2(s.vy), s.team === 'red' ? 0 : 1, s.owner]),
    f: TEAMS.map(t => { const f = g.flags[t]; return [f.state, r2(f.x), r2(f.y), f.carrier, r2(f.returnT)]; }),
  };
}

export function roster(g) {
  return {
    t: 'roster', phase: g.phase, winner: g.winner, score: [g.score.red, g.score.blue],
    players: Object.values(g.players).map(({ id, name, team, bot, kills, deaths, caps }) => ({ id, name, team, bot, kills, deaths, caps })),
  };
}
