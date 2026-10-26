const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const game = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const PICK_MS = Number(process.env.PICK_MS) || 15000;
const REVEAL_MS = Number(process.env.REVEAL_MS) || 2600;
const ROOM_IDLE_MS = 10 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O so codes are easy to read aloud

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const trimmed = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return trimmed || 'Player';
}

function createRoom() {
  const room = {
    code: makeCode(),
    hostId: null,
    players: new Map(), // id -> { id, token, name, color, socketId, connected, left }
    phase: 'lobby',
    size: 0,
    board: [],
    round: 0,
    picks: new Map(),
    deadline: 0,
    timer: null,
    lastReveal: [],
    standings: [],
    emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}

function activePlayers(room) {
  return [...room.players.values()].filter((p) => !p.left);
}

function connectedPlayers(room) {
  return activePlayers(room).filter((p) => p.connected);
}

function nextColor(room) {
  const used = new Set(activePlayers(room).map((p) => p.color));
  return game.COLORS.find((c) => !used.has(c)) || game.COLORS[0];
}

// The host keeps the role across refreshes; it only moves for good when they leave.
function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && !host.left) return;
  const next = connectedPlayers(room)[0] || activePlayers(room)[0];
  room.hostId = next ? next.id : null;
}

// While the host is offline, the first connected player can run the room.
function hostOf(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected && !host.left) return host.id;
  const standIn = connectedPlayers(room)[0];
  return standIn ? standIn.id : room.hostId;
}

function viewFor(room, player) {
  const picking = room.phase === 'picking';
  const players = activePlayers(room).map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    connected: p.connected,
    locked: picking && room.picks.has(p.id),
    cells: room.board.filter((c) => c.owner === p.id).length,
  }));
  return {
    code: room.code,
    phase: room.phase,
    hostId: hostOf(room),
    you: player.id,
    round: room.round,
    size: room.size,
    board: room.board.map((c) => (c.cracked ? 'x' : c.owner)),
    players,
    msLeft: picking ? Math.max(0, room.deadline - Date.now()) : 0,
    pickMs: PICK_MS,
    myPick: picking && room.picks.has(player.id) ? room.picks.get(player.id) : null,
    legal: picking ? game.legalCells(room.board, room.size, player.id) : [],
    reveal: room.phase === 'reveal' || room.phase === 'over' ? room.lastReveal : [],
    standings: room.phase === 'over' ? room.standings : [],
  };
}

function broadcast(room) {
  for (const p of activePlayers(room)) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', viewFor(room, p));
  }
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function startRound(room) {
  clearTimer(room);
  room.phase = 'picking';
  room.round += 1;
  room.picks = new Map();
  room.lastReveal = [];
  room.deadline = Date.now() + PICK_MS;
  room.timer = setTimeout(() => resolve(room), PICK_MS);
  broadcast(room);
}

function resolve(room) {
  if (room.phase !== 'picking') return;
  clearTimer(room);
  room.lastReveal = game.resolveRound(room.board, room.picks);
  room.picks = new Map();
  if (game.isBoardFull(room.board)) {
    room.phase = 'over';
    room.standings = game.scores(room.board, room.size, activePlayers(room).map((p) => p.id));
    broadcast(room);
    return;
  }
  room.phase = 'reveal';
  broadcast(room);
  room.timer = setTimeout(() => {
    room.timer = null;
    // Nobody left to play: park the room instead of spinning through empty rounds.
    // attach() restarts it when someone comes back.
    if (connectedPlayers(room).length === 0) return;
    startRound(room);
  }, REVEAL_MS);
}

function maybeResolveEarly(room) {
  if (room.phase !== 'picking') return;
  const waiting = connectedPlayers(room).filter((p) => !room.picks.has(p.id));
  if (waiting.length === 0 && room.picks.size > 0) resolve(room);
}

function startGame(room) {
  const players = activePlayers(room);
  room.size = game.boardSizeFor(players.length);
  room.board = game.newBoard(room.size);
  room.round = 0;
  room.standings = [];
  startRound(room);
}

function backToLobby(room) {
  clearTimer(room);
  // Players who left mid-game are dropped for good once the room returns to the lobby.
  for (const [id, p] of room.players) if (p.left) room.players.delete(id);
  room.phase = 'lobby';
  room.size = 0;
  room.board = [];
  room.round = 0;
  room.picks = new Map();
  room.lastReveal = [];
  room.standings = [];
  ensureHost(room);
  broadcast(room);
}

io.on('connection', (socket) => {
  let room = null;
  let player = null;

  const fail = (message) => socket.emit('problem', { message });

  function attach(r, p) {
    room = r;
    player = p;
    p.socketId = socket.id;
    p.connected = true;
    r.emptySince = null;
    ensureHost(r);
    socket.emit('joined', { code: r.code, token: p.token });
    broadcast(r);
    // A returning player may have been the last one the round was waiting on.
    maybeResolveEarly(r);
    if (r.phase === 'reveal' && !r.timer) startRound(r);
  }

  function addPlayer(r, name) {
    if (r.phase !== 'lobby') return fail('That game has already started. Ask the host to start a new one.');
    if (activePlayers(r).length >= game.MAX_PLAYERS) return fail(`That room is full (${game.MAX_PLAYERS} players max).`);
    const p = {
      id: crypto.randomUUID().slice(0, 8),
      token: crypto.randomUUID(),
      name: cleanName(name),
      color: nextColor(r),
      socketId: null,
      connected: false,
      left: false,
    };
    r.players.set(p.id, p);
    if (!r.hostId) r.hostId = p.id;
    attach(r, p);
  }

  socket.on('create', ({ name } = {}) => {
    if (player) return;
    addPlayer(createRoom(), name);
  });

  socket.on('join', ({ code, name } = {}) => {
    if (player) return;
    const r = rooms.get(String(code || '').trim().toUpperCase());
    if (!r) return fail('No room with that code. Check the letters and try again.');
    addPlayer(r, name);
  });

  socket.on('resume', ({ code, token } = {}) => {
    if (player) return;
    const r = rooms.get(String(code || '').toUpperCase());
    const p = r && [...r.players.values()].find((x) => x.token === token && !x.left);
    if (!p) return socket.emit('resumeFailed');
    attach(r, p);
  });

  socket.on('start', () => {
    if (!room || room.phase !== 'lobby' || hostOf(room) !== player.id) return;
    if (activePlayers(room).length < 2) return fail('You need at least 2 players to start.');
    startGame(room);
  });

  socket.on('pick', ({ cell } = {}) => {
    if (!room || room.phase !== 'picking') return;
    const legal = game.legalCells(room.board, room.size, player.id);
    if (!Number.isInteger(cell) || !legal.includes(cell)) return fail("You can't pick that cell.");
    room.picks.set(player.id, cell);
    broadcast(room);
    maybeResolveEarly(room);
  });

  socket.on('again', () => {
    if (!room || room.phase !== 'over' || hostOf(room) !== player.id) return;
    backToLobby(room);
  });

  socket.on('leave', () => {
    if (!room) return;
    const r = room;
    if (r.phase === 'lobby') r.players.delete(player.id);
    else player.left = true;
    player.connected = false;
    room = null;
    player = null;
    if (r.hostId && !r.players.has(r.hostId)) r.hostId = null;
    ensureHost(r);
    if (activePlayers(r).length === 0) {
      clearTimer(r);
      rooms.delete(r.code);
      return;
    }
    broadcast(r);
    maybeResolveEarly(r);
  });

  socket.on('disconnect', () => {
    if (!room || !player) return;
    if (player.socketId !== socket.id) return; // already resumed on a newer socket
    player.connected = false;
    if (connectedPlayers(room).length === 0) room.emptySince = Date.now();
    broadcast(room);
    maybeResolveEarly(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > ROOM_IDLE_MS) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Collide running at http://localhost:${PORT}`));
}

module.exports = { server, io, rooms };
