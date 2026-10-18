// Drawing for Arena. Works in tile units: the canvas transform maps one tile to `scale` CSS pixels,
// centred on the camera. Everything outside the player's line of sight is shaded dark, and enemies
// there are not drawn at all, which gives the top-down view its first-person tension.
// For speed, the static map is drawn once into an offscreen image, robots are pre-drawn sprites,
// and the sight polygon is only recomputed when the viewpoint moves.

import { MAP, MAP_W, MAP_H, isWall, lineOfSight, STANDS, TEAMS, BLASTER, BODY } from './sim.js';

export const TEAM_COLOR = { red: '#ff4d7e', blue: '#3fd4ff' };
const TEAM_LIGHT = { red: '#ffc2d3', blue: '#c8f4ff' };
const TEAM_DARK = { red: '#6b1733', blue: '#0e4a63' };
const TEAM_RGB = { red: '255, 77, 126', blue: '63, 212, 255' };
const WEAPON_COLOR = { blaster: '#ffffff', lightning: '#b9a6ff', rocket: '#ffa53d', grenade: '#7dff9a' };
const FLOOR = '#0b1222';
const OUTSIDE = '#121c35';
const WALL = '#1a2644';
const WALL_TOP = '#22325a';
const EDGE = 'rgba(120, 170, 255, 0.5)';
const SHADE = 'rgba(3, 5, 12, 0.72)';
const VIEW_W = 40, VIEW_H = 24; // the most of the map anyone can see at once, in tiles
const MAX_TILE_PX = 64;         // cap for the cached map image's resolution

// Wall outlines as long straight segments, used both for sight rays and for the glowing edges.
const SEGMENTS = (() => {
  const segs = [];
  const floor = (x, y) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && !isWall(x, y);
  for (const [dy, off] of [[-1, 0], [1, 1]]) {
    for (let y = 0; y < MAP_H; y++) {
      let start = null;
      for (let x = 0; x <= MAP_W; x++) {
        const edge = x < MAP_W && isWall(x, y) && floor(x, y + dy);
        if (edge && start === null) start = x;
        if (!edge && start !== null) { segs.push([start, y + off, x, y + off]); start = null; }
      }
    }
  }
  for (const [dx, off] of [[-1, 0], [1, 1]]) {
    for (let x = 0; x < MAP_W; x++) {
      let start = null;
      for (let y = 0; y <= MAP_H; y++) {
        const edge = y < MAP_H && isWall(x, y) && floor(x + dx, y);
        if (edge && start === null) start = y;
        if (!edge && start !== null) { segs.push([x + off, start, x + off, y]); start = null; }
      }
    }
  }
  return segs;
})();
const EDGE_PATH = (() => {
  const p = new Path2D();
  for (const [x1, y1, x2, y2] of SEGMENTS) { p.moveTo(x1, y1); p.lineTo(x2, y2); }
  return p;
})();

// Sight polygon: rays just either side of every wall corner in view, each stopped by the nearest wall.
// Segments are kept in one flat typed array, since this runs whenever the viewpoint moves.
const SEG_BUF = new Float64Array((SEGMENTS.length + 4) * 4);
function visibility(ox, oy, view) {
  const { x0, y0, x1, y1 } = view;
  let n = 0;
  const add = (ax, ay, bx, by) => { SEG_BUF[n++] = ax; SEG_BUF[n++] = ay; SEG_BUF[n++] = bx - ax; SEG_BUF[n++] = by - ay; };
  for (const s of SEGMENTS) {
    if (Math.max(s[0], s[2]) >= x0 && Math.min(s[0], s[2]) <= x1 && Math.max(s[1], s[3]) >= y0 && Math.min(s[1], s[3]) <= y1) add(s[0], s[1], s[2], s[3]);
  }
  add(x0, y0, x1, y0); add(x1, y0, x1, y1); add(x1, y1, x0, y1); add(x0, y1, x0, y0);
  const seen = new Set(), angles = [];
  for (let i = 0; i < n; i += 4) {
    for (const [px, py] of [[SEG_BUF[i], SEG_BUF[i + 1]], [SEG_BUF[i] + SEG_BUF[i + 2], SEG_BUF[i + 1] + SEG_BUF[i + 3]]]) {
      const key = px * 4096 + py;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = Math.atan2(py - oy, px - ox);
      angles.push(a - 1e-4, a + 1e-4);
    }
  }
  angles.sort((a, b) => a - b);
  const pts = new Array(angles.length * 2);
  let m = 0;
  for (const a of angles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let best = Infinity;
    for (let i = 0; i < n; i += 4) {
      const sx = SEG_BUF[i + 2], sy = SEG_BUF[i + 3];
      const den = dx * sy - dy * sx;
      if (den > -1e-12 && den < 1e-12) continue;
      const ax = SEG_BUF[i] - ox, ay = SEG_BUF[i + 1] - oy;
      const t = (ax * sy - ay * sx) / den;
      if (t <= 0 || t >= best) continue;
      const u = (ax * dy - ay * dx) / den;
      if (u >= -1e-9 && u <= 1 + 1e-9) best = t;
    }
    if (best < Infinity) { pts[m++] = ox + dx * best; pts[m++] = oy + dy * best; }
  }
  pts.length = m;
  return pts;
}

// A small picture of the map for the minimap, drawn once.
const MINI = 4;
const miniMap = (() => {
  const c = document.createElement('canvas');
  c.width = MAP_W * MINI; c.height = MAP_H * MINI;
  const m = c.getContext('2d');
  m.fillStyle = 'rgba(11, 18, 34, 0.85)'; m.fillRect(0, 0, c.width, c.height);
  m.fillStyle = '#3a5288';
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (MAP[y][x] === '#') m.fillRect(x * MINI, y * MINI, MINI, MINI);
  return c;
})();

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1, scale = 40;
  let mapImg = null, mapPx = 0, balls = {}, glows = {}, vignette = null, quality = 1;
  let cam = { x: MAP_W / 2, y: MAP_H / 2 };
  const parts = [];
  let shake = 0, flashA = 0, markerT = 0, markerKill = false;
  const meScreen = { x: 0, y: 0 };
  let visKey = '', visPoly = [];

  function buildMap() {
    mapPx = Math.min(MAX_TILE_PX, Math.ceil(scale * dpr));
    mapImg = makeCanvas(MAP_W * mapPx, MAP_H * mapPx);
    const m = mapImg.getContext('2d');
    m.scale(mapPx, mapPx);
    m.fillStyle = FLOOR;
    m.fillRect(0, 0, MAP_W, MAP_H);
    for (const t of TEAMS) {
      const s = STANDS[t];
      const g = m.createRadialGradient(s.x, s.y, 0, s.x, s.y, 7);
      g.addColorStop(0, `rgba(${TEAM_RGB[t]}, 0.16)`);
      g.addColorStop(1, `rgba(${TEAM_RGB[t]}, 0)`);
      m.fillStyle = g;
      m.fillRect(s.x - 7, s.y - 7, 14, 14);
    }
    m.strokeStyle = 'rgba(80, 120, 200, 0.08)';
    m.lineWidth = 0.03;
    m.beginPath();
    for (let x = 0; x <= MAP_W; x++) { m.moveTo(x, 0); m.lineTo(x, MAP_H); }
    for (let y = 0; y <= MAP_H; y++) { m.moveTo(0, y); m.lineTo(MAP_W, y); }
    m.stroke();
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
      if (!isWall(x, y)) continue;
      m.fillStyle = WALL; m.fillRect(x, y, 1, 1);
      m.fillStyle = WALL_TOP; m.fillRect(x + 0.12, y + 0.12, 0.76, 0.76);
    }
  }

  // Each robot is a glossy ball in its team colour, pre-drawn once per size.
  function buildSprites() {
    const px = Math.ceil(BODY * 2 * scale * dpr) + 4;
    for (const t of TEAMS) {
      const c = makeCanvas(px, px), b = c.getContext('2d'), r = px / 2 - 2;
      const g = b.createRadialGradient(px / 2 - r * 0.35, px / 2 - r * 0.4, r * 0.1, px / 2, px / 2, r);
      g.addColorStop(0, TEAM_LIGHT[t]);
      g.addColorStop(0.45, TEAM_COLOR[t]);
      g.addColorStop(1, TEAM_DARK[t]);
      b.fillStyle = g;
      b.beginPath(); b.arc(px / 2, px / 2, r, 0, Math.PI * 2); b.fill();
      b.lineWidth = Math.max(1, r * 0.08); b.strokeStyle = 'rgba(3, 5, 12, 0.8)'; b.stroke();
      balls[t] = c;
      const gs = Math.ceil(2.8 * scale * dpr);
      const gc = makeCanvas(gs, gs), gx = gc.getContext('2d');
      const gg = gx.createRadialGradient(gs / 2, gs / 2, 0, gs / 2, gs / 2, gs / 2);
      gg.addColorStop(0, `rgba(${TEAM_RGB[t]}, 0.45)`);
      gg.addColorStop(1, `rgba(${TEAM_RGB[t]}, 0)`);
      gx.fillStyle = gg; gx.fillRect(0, 0, gs, gs);
      glows[t] = gc;
    }
    vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(255, 42, 74, 1)');
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Keep the canvas under about 5 million pixels so big, sharp screens stay smooth.
    if (W * H * dpr * dpr > 5e6) dpr = Math.max(1, Math.sqrt(5e6 / (W * H)));
    dpr *= quality;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    scale = Math.max(W / VIEW_W, H / VIEW_H);
    buildMap();
    buildSprites();
    visKey = '';
  }

  const toScreen = (x, y) => ({ x: (x - cam.x) * scale + W / 2, y: (y - cam.y) * scale + H / 2 });

  const fx = {
    spark(x, y, color, n = 8, speed = 6) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random());
        parts.push({ kind: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.35, max: 0.35, color, size: 0.06 });
      }
    },
    ring(x, y, color, size = 1.5) { parts.push({ kind: 'ring', x, y, life: 0.45, max: 0.45, color, size }); },
    burst(x, y, color) { fx.spark(x, y, color, 22, 9); fx.ring(x, y, color, 2.2); },
    boom(x, y, r, color) {
      parts.push({ kind: 'boom', x, y, life: 0.4, max: 0.4, size: r, color });
      fx.spark(x, y, '#ffd166', 18, 10);
      fx.spark(x, y, color, 10, 7);
    },
    smoke(x, y) { parts.push({ kind: 'smoke', x, y, vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6, life: 0.5, max: 0.5, size: 0.12 }); },
    shake(a) { shake = Math.max(shake, a); },
    flash(a = 0.35) { flashA = Math.max(flashA, a); },
    marker(kill = false) { markerT = 0.18; markerKill = kill; },
  };

  // ---------- pieces ----------
  function drawStand(team, time) {
    const s = STANDS[team];
    ctx.strokeStyle = TEAM_COLOR[team];
    ctx.lineWidth = 0.08;
    ctx.globalAlpha = 0.5 + 0.2 * Math.sin(time * 3);
    ctx.beginPath(); ctx.arc(s.x, s.y, 1, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([0.25, 0.2]);
    ctx.beginPath(); ctx.arc(s.x, s.y, 1.3, time * 0.5, time * 0.5 + Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawFlag(x, y, team, time, small = false) {
    const k = small ? 0.6 : 1;
    if (!small) ctx.drawImage(glows[team], x - 1.4, y - 1.4, 2.8, 2.8);
    const wave = Math.sin(time * 6) * 0.06;
    ctx.strokeStyle = '#e8eeff'; ctx.lineWidth = 0.07 * k;
    ctx.beginPath(); ctx.moveTo(x - 0.15 * k, y + 0.45 * k); ctx.lineTo(x - 0.15 * k, y - 0.5 * k); ctx.stroke();
    ctx.fillStyle = TEAM_COLOR[team];
    ctx.beginPath();
    ctx.moveTo(x - 0.15 * k, y - 0.5 * k);
    ctx.quadraticCurveTo(x + 0.15 * k, y - 0.42 * k + wave, x + 0.45 * k, y - 0.3 * k);
    ctx.quadraticCurveTo(x + 0.15 * k, y - 0.18 * k - wave, x - 0.15 * k, y - 0.1 * k);
    ctx.closePath(); ctx.fill();
  }

  function drawBall(p, time, isMe) {
    const r = BODY;
    if (isMe) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'; ctx.lineWidth = 0.04;
      ctx.beginPath(); ctx.arc(p.x, p.y, 0.56, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.drawImage(balls[p.team], p.x - r - 2 / (scale * dpr), p.y - r - 2 / (scale * dpr), 2 * r + 4 / (scale * dpr), 2 * r + 4 / (scale * dpr));
    // A small dot shows where the ball aims, coloured by the weapon in hand.
    const ax = p.x + Math.cos(p.aim) * r * 0.62, ay = p.y + Math.sin(p.aim) * r * 0.62;
    ctx.fillStyle = 'rgba(3, 5, 12, 0.8)';
    ctx.beginPath(); ctx.arc(ax, ay, 0.105, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = WEAPON_COLOR[p.weapon] || '#ffffff';
    ctx.beginPath(); ctx.arc(ax, ay, 0.07, 0, Math.PI * 2); ctx.fill();
    if (p.carrying) drawFlag(p.x - 0.05, p.y - 0.42, p.team === 'red' ? 'blue' : 'red', time, true);
    if (p.shield) {
      ctx.strokeStyle = TEAM_COLOR[p.team]; ctx.lineWidth = 0.05; ctx.globalAlpha = 0.6;
      ctx.setLineDash([0.18, 0.12]);
      ctx.beginPath(); ctx.arc(p.x, p.y, 0.6, time * 2, time * 2 + Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
  }

  function drawShot(s, time, dt) {
    const len = Math.hypot(s.vx, s.vy) || 1, ux = s.vx / len, uy = s.vy / len;
    const c = TEAM_COLOR[s.team];
    if (s.kind === 'rocket') {
      if (Math.random() < dt * 40) fx.smoke(s.x - ux * 0.35, s.y - uy * 0.35);
      ctx.globalAlpha = 0.35; ctx.fillStyle = '#ffa53d';
      ctx.beginPath(); ctx.arc(s.x, s.y, 0.32, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c; ctx.lineWidth = 0.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(s.x - ux * 0.3, s.y - uy * 0.3); ctx.lineTo(s.x + ux * 0.1, s.y + uy * 0.1); ctx.stroke();
      ctx.fillStyle = '#fff3c4';
      ctx.beginPath(); ctx.arc(s.x + ux * 0.12, s.y + uy * 0.12, 0.07, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (s.kind === 'grenade') {
      ctx.fillStyle = '#2b3550'; ctx.strokeStyle = c; ctx.lineWidth = 0.05;
      ctx.beginPath(); ctx.arc(s.x, s.y, 0.17, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = Math.sin(time * 30) > 0 ? '#7dff9a' : c;
      ctx.beginPath(); ctx.arc(s.x, s.y, 0.07, 0, Math.PI * 2); ctx.fill();
      return;
    }
    const tail = Math.min(0.9, s.dist == null ? 0.9 : s.dist);
    ctx.lineCap = 'round';
    ctx.strokeStyle = c; ctx.globalAlpha = 0.35; ctx.lineWidth = 0.22;
    ctx.beginPath(); ctx.moveTo(s.x - ux * tail, s.y - uy * tail); ctx.lineTo(s.x, s.y); ctx.stroke();
    ctx.globalAlpha = 1; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.07;
    ctx.beginPath(); ctx.moveTo(s.x - ux * tail * 0.8, s.y - uy * tail * 0.8); ctx.lineTo(s.x, s.y); ctx.stroke();
  }

  // Lightning: a fresh jagged line every frame from the muzzle to where the beam stops.
  function drawBeam(b) {
    const dx = b.x2 - b.x1, dy = b.y2 - b.y1, len = Math.hypot(dx, dy);
    if (len < 0.05) return;
    const nx = -dy / len, ny = dx / len, n = Math.max(2, Math.ceil(len / 0.45));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const k = i / n, j = i === 0 || i === n ? 0 : (Math.random() - 0.5) * 0.35;
      pts.push(b.x1 + dx * k + nx * j, b.y1 + dy * k + ny * j);
    }
    const line = () => { ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); ctx.stroke(); };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = TEAM_COLOR[b.team]; ctx.globalAlpha = 0.4; ctx.lineWidth = 0.28; line();
    ctx.globalAlpha = 1; ctx.strokeStyle = '#e9e4ff'; ctx.lineWidth = 0.07; line();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(b.x2, b.y2, 0.12 + Math.random() * 0.08, 0, Math.PI * 2); ctx.fill();
  }

  function drawParts(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      const a = p.life / p.max;
      ctx.globalAlpha = a;
      if (p.kind === 'spark') {
        p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.9; p.vy *= 0.9;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      } else if (p.kind === 'smoke') {
        p.x += p.vx * dt; p.y += p.vy * dt;
        ctx.globalAlpha = a * 0.4; ctx.fillStyle = '#9aa6c4';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size + (1 - a) * 0.25, 0, Math.PI * 2); ctx.fill();
      } else if (p.kind === 'boom') {
        const r = p.size * (0.35 + 0.65 * (1 - a));
        ctx.globalAlpha = a * 0.55; ctx.fillStyle = '#ffb347';
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = a; ctx.strokeStyle = p.color; ctx.lineWidth = 0.1;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.strokeStyle = p.color; ctx.lineWidth = 0.08;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - a) + 0.2, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------- screen-space overlays ----------
  function label(text, x, y, color, size = 12) {
    ctx.font = `700 ${size}px "Exo 2", system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(3, 5, 12, 0.85)'; ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }

  function drawTags(view, shown) {
    const fs = Math.max(10, Math.min(13, scale * 0.32));
    for (const p of shown) {
      if (p.id === view.me || !p.alive) continue;
      const s = toScreen(p.x, p.y);
      const top = s.y - scale * 0.62;
      const w = Math.max(18, scale * 0.8);
      ctx.fillStyle = 'rgba(3, 5, 12, 0.7)';
      ctx.fillRect(s.x - w / 2, top, w, 3);
      ctx.fillStyle = TEAM_COLOR[p.team];
      ctx.fillRect(s.x - w / 2, top, w * p.hp / 100, 3);
      label(p.name, s.x, top - 2, p.team === view.myTeam ? '#e8eeff' : TEAM_COLOR[p.team], fs);
    }
  }

  function drawFlagArrows(view) {
    for (const t of TEAMS) {
      const f = view.flags[t];
      const s = toScreen(f.x, f.y);
      const m = 34;
      if (s.x > m && s.x < W - m && s.y > m && s.y < H - m) continue;
      const cx = W / 2, cy = H / 2, dx = s.x - cx, dy = s.y - cy;
      const k = Math.min((W / 2 - m) / Math.abs(dx || 1e-6), (H / 2 - m) / Math.abs(dy || 1e-6));
      const ax = cx + dx * k, ay = cy + dy * k, a = Math.atan2(dy, dx);
      ctx.save();
      ctx.translate(ax, ay); ctx.rotate(a);
      ctx.fillStyle = TEAM_COLOR[t]; ctx.strokeStyle = 'rgba(3, 5, 12, 0.9)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-8, -11); ctx.lineTo(-3, 0); ctx.lineTo(-8, 11); ctx.closePath();
      ctx.stroke(); ctx.fill();
      ctx.restore();
      const d = Math.round(Math.hypot(f.x - view.cam.x, f.y - view.cam.y));
      label(`${f.state === 'home' ? '⚑' : f.state === 'dropped' ? '⚐' : '⚑!'} ${d}m`, ax - Math.cos(a) * 26, ay - Math.sin(a) * 26 + 7, TEAM_COLOR[t], 12);
    }
  }

  function drawCrosshair(view) {
    const { x, y } = view.mouse;
    if (x == null) return;
    const c = view.reloadT > 0 && view.weapon === 'blaster' ? '#ffd166' : WEAPON_COLOR[view.weapon] || '#e8eeff';
    const draw = () => {
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(x + dx * 5, y + dy * 5); ctx.lineTo(x + dx * 12, y + dy * 12); }
      ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.stroke();
    };
    ctx.strokeStyle = 'rgba(3, 5, 12, 0.8)'; ctx.lineWidth = 4; draw();
    ctx.strokeStyle = c; ctx.lineWidth = 2; draw();
    if (view.reloadT > 0) {
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 17, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - view.reloadT / BLASTER.reload)); ctx.stroke();
    }
    if (markerT > 0) {
      ctx.strokeStyle = markerKill ? '#ff4d7e' : '#ffffff'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) { ctx.moveTo(x + dx * 7, y + dy * 7); ctx.lineTo(x + dx * 13, y + dy * 13); }
      ctx.stroke();
    }
  }

  function drawMinimap(view, shown) {
    const mw = MAP_W * MINI, mh = MAP_H * MINI, x0 = 12, y0 = 12;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(miniMap, x0, y0);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(120, 170, 255, 0.4)'; ctx.lineWidth = 1;
    ctx.strokeRect(x0 - 0.5, y0 - 0.5, mw + 1, mh + 1);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.strokeRect(x0 + view.vis.x0 * MINI, y0 + view.vis.y0 * MINI, (view.vis.x1 - view.vis.x0) * MINI, (view.vis.y1 - view.vis.y0) * MINI);
    for (const t of TEAMS) {
      const f = view.flags[t];
      ctx.fillStyle = TEAM_COLOR[t];
      ctx.fillRect(x0 + f.x * MINI - 3, y0 + f.y * MINI - 6, 2, 9);
      ctx.fillRect(x0 + f.x * MINI - 1, y0 + f.y * MINI - 6, 5, 4);
    }
    for (const p of shown) {
      if (!p.alive) continue;
      ctx.fillStyle = p.id === view.me ? '#ffffff' : TEAM_COLOR[p.team];
      ctx.beginPath(); ctx.arc(x0 + p.x * MINI, y0 + p.y * MINI, p.id === view.me ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------- frame ----------
  function draw(view, dt) {
    const time = view.time;
    const me = view.players.find(p => p.id === view.me);
    // Camera: on your ball, leaning a little toward the mouse so you see further where you aim.
    if (me) {
      let lx = 0, ly = 0;
      if (view.mouse.x != null) {
        lx = (view.mouse.x - W / 2) / scale * 0.25; ly = (view.mouse.y - H / 2) / scale * 0.25;
        const l = Math.hypot(lx, ly); if (l > 5) { lx *= 5 / l; ly *= 5 / l; }
      }
      const tx = me.x + lx, ty = me.y + ly;
      const k = Math.min(1, dt * 10);
      cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
      if (Math.hypot(tx - cam.x, ty - cam.y) > 15) { cam.x = tx; cam.y = ty; }
    } else if (view.camTarget) {
      cam.x = view.camTarget.x; cam.y = view.camTarget.y;
    }
    view.cam = cam;
    let sx = 0, sy = 0;
    if (shake > 0) { sx = (Math.random() - 0.5) * shake; sy = (Math.random() - 0.5) * shake; shake = Math.max(0, shake - dt * 1.5); }

    const hw = W / 2 / scale, hh = H / 2 / scale;
    const vis = { x0: cam.x - hw - 1, y0: cam.y - hh - 1, x1: cam.x + hw + 1, y1: cam.y + hh + 1 };
    view.vis = { x0: cam.x - hw, y0: cam.y - hh, x1: cam.x + hw, y1: cam.y + hh };

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = OUTSIDE; ctx.fillRect(0, 0, W, H);
    const ox = W / 2 - (cam.x + sx) * scale, oy = H / 2 - (cam.y + sy) * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mapImg, ox, oy, MAP_W * scale, MAP_H * scale);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);

    for (const t of TEAMS) drawStand(t, time);
    const eye = me || { x: cam.x, y: cam.y };
    const canSee = p => p.team === view.myTeam || lineOfSight(eye.x, eye.y, p.x, p.y);
    const shown = view.players.filter(p => p.alive && canSee(p));

    for (const t of TEAMS) {
      const f = view.flags[t];
      if (f.state !== 'carried' && (t === view.myTeam || lineOfSight(eye.x, eye.y, f.x, f.y))) drawFlag(f.x, f.y, t, time);
    }
    for (const s of view.shots) drawShot(s, time, dt);
    for (const b of view.beams || []) drawBeam(b);
    for (const p of shown) if (p.id !== view.me) drawBall(p, time, false);
    if (me && me.alive) drawBall(me, time, true);
    drawParts(dt);

    // Shade everything outside line of sight; the polygon only changes when the viewpoint moves.
    const key = `${eye.x.toFixed(2)},${eye.y.toFixed(2)},${Math.floor(vis.x0)},${Math.floor(vis.y0)}`;
    if (key !== visKey) {
      visKey = key;
      const box = { x0: Math.floor(vis.x0) - 1, y0: Math.floor(vis.y0) - 1, x1: Math.ceil(vis.x1) + 1, y1: Math.ceil(vis.y1) + 1 };
      visPoly = visibility(eye.x, eye.y, box);
    }
    ctx.fillStyle = SHADE;
    ctx.beginPath();
    ctx.rect(vis.x0 - 3, vis.y0 - 3, vis.x1 - vis.x0 + 6, vis.y1 - vis.y0 + 6);
    if (visPoly.length > 4) {
      ctx.moveTo(visPoly[0], visPoly[1]);
      for (let i = 2; i < visPoly.length; i += 2) ctx.lineTo(visPoly[i], visPoly[i + 1]);
      ctx.closePath();
    }
    ctx.fill('evenodd');
    ctx.strokeStyle = EDGE; ctx.lineWidth = 0.06; ctx.lineCap = 'round';
    ctx.stroke(EDGE_PATH);
    // Flags glow through the dark so you always know where they are.
    for (const t of TEAMS) {
      const f = view.flags[t];
      if (f.state === 'carried') continue;
      ctx.globalAlpha = 0.6; drawFlag(f.x, f.y, t, time, true); ctx.globalAlpha = 1;
    }

    // Screen space from here on.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (me) { const s = toScreen(me.x, me.y); meScreen.x = s.x; meScreen.y = s.y; }
    drawTags(view, shown);
    for (const t of TEAMS) {
      const f = view.flags[t];
      if (f.state === 'dropped') { const s = toScreen(f.x, f.y); label(`${Math.ceil(f.returnT)}`, s.x, s.y - scale * 0.6, TEAM_COLOR[t], 13); }
    }
    if (view.idle) return;
    drawFlagArrows(view);
    if (me && !me.alive) { ctx.fillStyle = 'rgba(40, 0, 20, 0.35)'; ctx.fillRect(0, 0, W, H); }
    if (flashA > 0) {
      ctx.globalAlpha = flashA; ctx.fillStyle = vignette; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
      flashA = Math.max(0, flashA - dt * 1.2);
    }
    drawMinimap(view, shown);
    drawCrosshair(view);
    markerT = Math.max(0, markerT - dt);
  }

  // Lower quality = fewer pixels per frame; used when a computer can't keep up.
  function setQuality(q) { if (q !== quality) { quality = q; resize(); } }

  return { resize, draw, fx, toScreen, meScreen, setQuality, get quality() { return quality; }, get scale() { return scale; } };
}

