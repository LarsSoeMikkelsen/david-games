// Peer-to-peer networking through PeerJS (loaded as the global `Peer`).
// The host's browser registers a room id; players connect to it directly over WebRTC.
// The free PeerJS cloud server only introduces the browsers to each other.

const PREFIX = 'predze-arena-';
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they look like 1 and 0
const CONNECT_TIMEOUT = 15000;
const OPTIONS = { debug: 0 };

export const makeCode = () => Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
export const cleanCode = s => (s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

function friendly(err, code) {
  switch (err && err.type) {
    case 'peer-unavailable': return `No game found with code ${code}. Check the code, or ask the host to create a new game.`;
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
      return "Can't reach the matchmaking server. Check your internet connection and try again.";
    case 'browser-incompatible': case 'webrtc':
      return "This browser can't make direct connections. Try a recent Chrome, Firefox or Edge.";
    default: return `Connection problem (${(err && (err.type || err.message)) || 'unknown'}).`;
  }
}

// Host: resolves with { code, send(id, msg), broadcast(msg), kick(id, msg), close() } once the room is registered.
// onJoin(id, hello) returns a reason string to refuse the player (or nothing to accept); onData(id, msg); onLeave(id).
export function hostRoom({ onJoin, onData, onLeave }) {
  if (typeof Peer === 'undefined') return Promise.reject(new Error("The networking library didn't load. Check your internet connection and reload."));
  return new Promise((resolve, reject) => {
    let tries = 0, peer = null, opened = false;
    const conns = new Map(); // id -> DataConnection, only after the player said hello
    let nextId = 1;

    const room = {
      code: null,
      send(id, msg) { const c = conns.get(id); if (c && c.open) c.send(msg); },
      broadcast(msg) { for (const c of conns.values()) if (c.open) c.send(msg); },
      kick(id, msg) { const c = conns.get(id); if (!c) return; if (msg && c.open) c.send(msg); conns.delete(id); setTimeout(() => c.close(), 300); },
      close() { for (const c of conns.values()) c.close(); conns.clear(); if (peer) peer.destroy(); },
    };

    function attempt() {
      const code = makeCode();
      peer = new Peer(PREFIX + code, OPTIONS);
      peer.on('open', () => { opened = true; room.code = code; resolve(room); });
      peer.on('error', err => {
        if (!opened && err.type === 'unavailable-id' && ++tries < 5) { peer.destroy(); attempt(); return; }
        if (!opened) { peer.destroy(); reject(new Error(friendly(err, code))); }
      });
      // Losing the matchmaking server only stops new players joining; reconnect quietly.
      peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000); });
      peer.on('connection', conn => {
        let id = null;
        conn.on('data', msg => {
          if (id) { onData(id, msg); return; }
          if (!msg || msg.t !== 'hello') return;
          id = 'p' + nextId++;
          const refused = onJoin(id, msg);
          if (refused) { id = null; conn.send({ t: 'refused', reason: refused }); setTimeout(() => conn.close(), 500); return; }
          conns.set(id, conn);
          conn.send({ t: 'welcome', id });
        });
        conn.on('close', () => { if (id && conns.has(id)) { conns.delete(id); onLeave(id); } });
        conn.on('error', () => {});
      });
    }
    attempt();
  });
}

// Player: resolves with { send(msg), close() } once connected to the host's room.
export function joinRoom(code, { onData, onClose }) {
  if (typeof Peer === 'undefined') return Promise.reject(new Error("The networking library didn't load. Check your internet connection and reload."));
  return new Promise((resolve, reject) => {
    const peer = new Peer(OPTIONS);
    let done = false, conn = null;
    const fail = msg => { if (done) return; done = true; clearTimeout(timer); peer.destroy(); reject(new Error(msg)); };
    const timer = setTimeout(() => fail("Couldn't connect to the host. One of you may be on a network that blocks direct connections (some mobile, school or work networks)."), CONNECT_TIMEOUT);
    peer.on('error', err => {
      if (!done) fail(friendly(err, code));
    });
    peer.on('open', () => {
      conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      conn.on('open', () => {
        done = true;
        clearTimeout(timer);
        resolve({
          send(msg) { if (conn.open) conn.send(msg); },
          close() { done = true; conn.close(); peer.destroy(); },
        });
      });
      conn.on('data', msg => onData(msg));
      conn.on('close', () => { if (done) onClose(); });
      conn.on('error', () => {});
    });
  });
}
