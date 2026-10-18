// Drawing for Arena. Works in tile units: the canvas transform maps one tile to `scale` CSS pixels,
// centred on the camera. Everything outside the player's line of sight is shaded dark, and enemies
// there are not drawn at all, which gives the top-down view its first-person tension.

import { MAP, MAP_W, MAP_H, isWall, lineOfSight, STANDS, TEAMS, RELOAD } from './sim.js';

export const TEAM_COLOR = { red: '#ff4d7e', blue: '#3fd4ff' };
const TEAM_DARK = { red: '#5a1630', blue: '#0f4257' };
const FLOOR = '#0b1222';
const GRID = 'rgba(80, 120, 200, 0.07)';
const WALL = '#1a2644';
const WALL_TOP = '#22325a';
const EDGE = 'rgba(120, 170, 255, 0.55)';
const SHADE = 'rgba(3, 5, 12, 0.74)';
const VIEW_W = 30, VIEW_H = 18; // the most of the map anyone can see at once, in tiles

// Wall outlines as long straight segments, used both for sight rays and for the glowing edges.
const SEGMENTS = (() => {
  const segs = [];
  const floor = (x, y) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && !isWall(x, y);
  // Horizontal edges: a wall tile with floor above (edge at y) or below (edge at y+1).
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

function visibility(ox, oy, view) {
  const segs = SEGMENTS.filter(([x1, y1, x2, y2]) =>
    Math.max(x1, x2) >= view.x0 && Math.min(x1, x2) <= view.x1 && Math.max(y1, y2) >= view.y0 && Math.min(y1, y2) <= view.y1);
  const { x0, y0, x1, y1 } = view;
  segs.push([x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]);
  const angles = [];
  for (const [ax, ay, bx, by] of segs) {
    for (const [px, py] of [[ax, ay], [bx, by]]) {
      const a = Math.atan2(py - oy, px - ox);
      angles.push(a - 1e-4, a, a + 1e-4);
    }
  }
  angles.sort((a, b) => a - b);
  const pts = [];
  for (const a of angles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let best = Infinity;
    for (const [sx1, sy1, sx2, sy2] of segs) {
      const sx = sx2 - sx1, sy = sy2 - sy1;
      const den = dx * sy - dy * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((sx1 - ox) * sy - (sy1 - oy) * sx) / den;
      const u = ((sx1 - ox) * dy - (sy1 - oy) * dx) / den;
      if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) best = t;
    }
    if (best < Infinity) pts.push(ox + dx * best, oy + dy * best);
  }
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

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1, scale = 40;
  let cam = { x: MAP_W / 2, y: MAP_H / 2 };
  const parts = [];
  let shake = 0, flashA = 0, flashColor = '#ff2a4a', markerT = 0, markerKill = false;
  const meScreen = { x: 0, y: 0 };

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    scale = Math.max(W / VIEW_W, H / VIEW_H);
  }

  const toScreen = (x, y) => ({ x: (x - cam.x) * scale + W / 2, y: (y - cam.y) * scale + H / 2 });

  const fx = {
    spark(x, y, color, n = 8, speed = 6) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random());
        parts.push({ kind: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.35, max: 0.35, color });
      }
    },
    ring(x, y, color, size = 1.5) { parts.push({ kind: 'ring', x, y, life: 0.45, max: 0.45, color, size }); },
    burst(x, y, color) { fx.spark(x, y, color, 22, 9); fx.ring(x, y, color, 2.2); },
    shake(a) { shake = Math.max(shake, a); },
    flash(color, a = 0.35) { flashColor = color; flashA = Math.max(flashA, a); },
    marker(kill = false) { markerT = 0.18; markerKill = kill; },
  };

  // ---------- pieces ----------
  function drawFloor(v) {
    ctx.fillStyle = FLOOR;
    ctx.fillRect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);
    for (const t of TEAMS) {
      const s = STANDS[t];
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 7);
      g.addColorStop(0, t === 'red' ? 'rgba(255, 77, 126, 0.16)' : 'rgba(63, 212, 255, 0.16)');
      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(s.x - 7, s.y - 7, 14, 14);
    }
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    for (let x = Math.max(0, Math.floor(v.x0)); x <= Math.min(MAP_W, Math.ceil(v.x1)); x++) { ctx.moveTo(x, v.y0); ctx.lineTo(x, v.y1); }
    for (let y = Math.max(0, Math.floor(v.y0)); y <= Math.min(MAP_H, Math.ceil(v.y1)); y++) { ctx.moveTo(v.x0, y); ctx.lineTo(v.x1, y); }
    ctx.stroke();
  }

  function drawWalls(v) {
    const xa = Math.max(0, Math.floor(v.x0)), xb = Math.min(MAP_W - 1, Math.ceil(v.x1));
    const ya = Math.max(0, Math.floor(v.y0)), yb = Math.min(MAP_H - 1, Math.ceil(v.y1));
    // Outside the map counts as wall too.
    ctx.fillStyle = WALL;
    if (v.x0 < 0) ctx.fillRect(v.x0, v.y0, -v.x0, v.y1 - v.y0);
    if (v.y0 < 0) ctx.fillRect(v.x0, v.y0, v.x1 - v.x0, -v.y0);
    if (v.x1 > MAP_W) ctx.fillRect(MAP_W, v.y0, v.x1 - MAP_W, v.y1 - v.y0);
    if (v.y1 > MAP_H) ctx.fillRect(v.x0, MAP_H, v.x1 - v.x0, v.y1 - MAP_H);
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      if (!isWall(x, y)) continue;
      ctx.fillStyle = WALL;
      ctx.fillRect(x, y, 1.02, 1.02);
      ctx.fillStyle = WALL_TOP;
      ctx.fillRect(x + 0.12, y + 0.12, 0.76, 0.76);
    }
  }

  function drawEdges(v, alpha) {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 0.06;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of SEGMENTS) {
      if (Math.max(x1, x2) < v.x0 || Math.min(x1, x2) > v.x1 || Math.max(y1, y2) < v.y0 || Math.min(y1, y2) > v.y1) continue;
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawStand(team, time) {
    const s = STANDS[team], c = TEAM_COLOR[team];
    ctx.strokeStyle = c;
    ctx.lineWidth = 0.08;
    ctx.globalAlpha = 0.5 + 0.2 * Math.sin(time * 3);
    ctx.beginPath(); ctx.arc(s.x, s.y, 1, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([0.25, 0.2]);
    ctx.beginPath(); ctx.arc(s.x, s.y, 1.3, time * 0.5, time * 0.5 + Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawFlag(x, y, team, time, small = false) {
    const c = TEAM_COLOR[team], k = small ? 0.6 : 1;
    if (!small) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, 1.4);
      g.addColorStop(0, team === 'red' ? 'rgba(255, 77, 126, 0.45)' : 'rgba(63, 212, 255, 0.45)');
      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill();
    }
    const wave = Math.sin(time * 6) * 0.06;
    ctx.strokeStyle = '#e8eeff'; ctx.lineWidth = 0.07 * k;
    ctx.beginPath(); ctx.moveTo(x - 0.15 * k, y + 0.45 * k); ctx.lineTo(x - 0.15 * k, y - 0.5 * k); ctx.stroke();
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(x - 0.15 * k, y - 0.5 * k);
    ctx.quadraticCurveTo(x + 0.15 * k, y - 0.42 * k + wave, x + 0.45 * k, y - 0.3 * k);
    ctx.quadraticCurveTo(x + 0.15 * k, y - 0.18 * k - wave, x - 0.15 * k, y - 0.1 * k);
    ctx.closePath(); ctx.fill();
  }

  function drawRobot(p, time, isMe) {
    const c = TEAM_COLOR[p.team];
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath(); ctx.ellipse(0.06, 0.1, 0.42, 0.36, 0, 0, Math.PI * 2); ctx.fill();
    if (isMe) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'; ctx.lineWidth = 0.04;
      ctx.beginPath(); ctx.arc(0, 0, 0.55, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.rotate(p.aim);
    // Blaster barrel.
    ctx.fillStyle = '#c9d4ee';
    ctx.fillRect(0.1, -0.08, 0.5, 0.16);
    ctx.fillStyle = c;
    ctx.fillRect(0.5, -0.08, 0.1, 0.16);
    // Side treads.
    ctx.fillStyle = '#2a3554';
    ctx.fillRect(-0.3, -0.42, 0.55, 0.14);
    ctx.fillRect(-0.3, 0.28, 0.55, 0.14);
    // Body.
    ctx.fillStyle = TEAM_DARK[p.team];
    ctx.strokeStyle = c; ctx.lineWidth = 0.07;
    ctx.beginPath(); ctx.arc(0, 0, 0.34, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // Visor pointing where it aims.
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(0.08, 0, 0.15, -1.1, 1.1); ctx.lineTo(0.08, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(0.16, 0, 0.045, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (p.carrying) drawFlag(p.x - 0.1, p.y - 0.35, p.team === 'red' ? 'blue' : 'red', time, true);
    if (p.shield) {
      ctx.strokeStyle = c; ctx.lineWidth = 0.05; ctx.globalAlpha = 0.6;
      ctx.setLineDash([0.18, 0.12]);
      ctx.beginPath(); ctx.arc(p.x, p.y, 0.58, time * 2, time * 2 + Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
  }

  function drawShot(s) {
    const len = Math.hypot(s.vx, s.vy) || 1, ux = s.vx / len, uy = s.vy / len;
    const tail = Math.min(0.9, s.dist == null ? 0.9 : s.dist);
    ctx.lineCap = 'round';
    ctx.strokeStyle = TEAM_COLOR[s.team]; ctx.globalAlpha = 0.35; ctx.lineWidth = 0.22;
    ctx.beginPath(); ctx.moveTo(s.x - ux * tail, s.y - uy * tail); ctx.lineTo(s.x, s.y); ctx.stroke();
    ctx.globalAlpha = 1; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.07;
    ctx.beginPath(); ctx.moveTo(s.x - ux * tail * 0.8, s.y - uy * tail * 0.8); ctx.lineTo(s.x, s.y); ctx.stroke();
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
        ctx.fillRect(p.x - 0.05, p.y - 0.05, 0.1, 0.1);
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
    const fs = Math.max(11, Math.min(14, scale * 0.3));
    for (const p of shown) {
      if (p.id === view.me || !p.alive) continue;
      const s = toScreen(p.x, p.y);
      const top = s.y - scale * 0.62;
      const w = scale * 0.8;
      ctx.fillStyle = 'rgba(3, 5, 12, 0.7)';
      ctx.fillRect(s.x - w / 2, top, w, 4);
      ctx.fillStyle = TEAM_COLOR[p.team];
      ctx.fillRect(s.x - w / 2, top, w * p.hp / 100, 4);
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
    const c = view.reloadT > 0 ? '#ffd166' : '#e8eeff';
    ctx.strokeStyle = 'rgba(3, 5, 12, 0.8)'; ctx.lineWidth = 4;
    const draw = () => {
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(x + dx * 5, y + dy * 5); ctx.lineTo(x + dx * 12, y + dy * 12); }
      ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.stroke();
    };
    draw();
    ctx.strokeStyle = c; ctx.lineWidth = 2; draw();
    if (view.reloadT > 0) {
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 17, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - view.reloadT / RELOAD)); ctx.stroke();
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
    // Camera: on your robot, leaning a little toward the mouse so you see further where you aim.
    if (me) {
      let lx = 0, ly = 0;
      if (view.mouse.x != null) {
        lx = (view.mouse.x - W / 2) / scale * 0.25; ly = (view.mouse.y - H / 2) / scale * 0.25;
        const l = Math.hypot(lx, ly); if (l > 4) { lx *= 4 / l; ly *= 4 / l; }
      }
      const tx = me.x + lx, ty = me.y + ly;
      const k = Math.min(1, dt * 10);
      cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
      if (Math.hypot(tx - cam.x, ty - cam.y) > 12) { cam.x = tx; cam.y = ty; }
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
    ctx.fillStyle = FLOOR; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (W / 2 - (cam.x + sx) * scale), dpr * (H / 2 - (cam.y + sy) * scale));

    drawFloor(vis);
    for (const t of TEAMS) drawStand(t, time);
    drawWalls(vis);

    const eye = me || { x: cam.x, y: cam.y };
    const canSee = p => p.team === view.myTeam || lineOfSight(eye.x, eye.y, p.x, p.y);
    const shown = view.players.filter(p => p.alive && canSee(p));

    for (const t of TEAMS) {
      const f = view.flags[t];
      if (f.state !== 'carried' && canSee({ team: t === view.myTeam ? t : '', x: f.x, y: f.y })) drawFlag(f.x, f.y, t, time);
    }
    for (const s of view.shots) drawShot(s);
    for (const p of shown) if (p.id !== view.me) drawRobot(p, time, false);
    if (me && me.alive) drawRobot(me, time, true);
    drawParts(dt);

    // Shade everything outside line of sight.
    const poly = visibility(eye.x, eye.y, vis);
    ctx.fillStyle = SHADE;
    ctx.beginPath();
    ctx.rect(vis.x0 - 2, vis.y0 - 2, vis.x1 - vis.x0 + 4, vis.y1 - vis.y0 + 4);
    if (poly.length > 4) {
      ctx.moveTo(poly[0], poly[1]);
      for (let i = 2; i < poly.length; i += 2) ctx.lineTo(poly[i], poly[i + 1]);
      ctx.closePath();
    }
    ctx.fill('evenodd');
    drawEdges(vis, 0.55);
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
    if (me && !me.alive) {
      ctx.fillStyle = 'rgba(40, 0, 20, 0.35)'; ctx.fillRect(0, 0, W, H);
    }
    if (flashA > 0) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(0, 0, 0, 0)'); g.addColorStop(1, flashColor);
      ctx.globalAlpha = flashA; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
      flashA = Math.max(0, flashA - dt * 1.2);
    }
    drawMinimap(view, shown);
    drawCrosshair(view);
    markerT = Math.max(0, markerT - dt);
  }

  return { resize, draw, fx, toScreen, meScreen, get scale() { return scale; } };
}
