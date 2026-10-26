// End-to-end: real server, real socket.io clients, short timers.
process.env.PICK_MS = '400';
process.env.REVEAL_MS = '50';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { server, io: ioServer, rooms } = require('../server');

let url;
test.before(() => new Promise((done) => server.listen(0, () => {
  url = `http://localhost:${server.address().port}`;
  done();
})));
test.after(() => new Promise((done) => ioServer.close(() => done())));

function client() {
  const s = io(url, { forceNew: true, transports: ['websocket'] });
  s.states = [];
  s.on('state', (st) => { s.states.push(st); s.last = st; });
  return s;
}

function waitFor(sock, pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    if (sock.last && pred(sock.last)) return resolve(sock.last);
    const t = setTimeout(() => { sock.off('state', on); reject(new Error('timed out waiting for: ' + pred.toString() + ' last=' + JSON.stringify(sock.last && {phase: sock.last.phase, round: sock.last.round, myPick: sock.last.myPick, legal: sock.last.legal.length}))); }, ms);
    const on = (st) => { if (pred(st)) { clearTimeout(t); sock.off('state', on); resolve(st); } };
    sock.on('state', on);
  });
}

function once(sock, event) {
  return new Promise((resolve) => sock.once(event, resolve));
}

test('two players create, join, collide, claim, and finish a game', async () => {
  const alice = client();
  const bob = client();
  alice.emit('create', { name: 'Alice' });
  const { code, token } = await once(alice, 'joined');
  assert.match(code, /^[A-Z]{4}$/);

  bob.emit('join', { code: code.toLowerCase(), name: '  Bob  ' });
  const lobby = await waitFor(alice, (s) => s.players.length === 2);
  assert.equal(lobby.phase, 'lobby');
  assert.deepEqual(lobby.players.map((p) => p.name), ['Alice', 'Bob']);
  assert.equal(lobby.hostId, lobby.you);

  // Only the host can start.
  bob.emit('start');
  alice.emit('start');
  let a = await waitFor(alice, (s) => s.phase === 'picking');
  assert.equal(a.size, 6);
  assert.equal(a.legal.length, 36);

  // Round 1: both pick cell 0 -> it cracks. Picks are hidden from the other player.
  alice.emit('pick', { cell: 0 });
  const bobView = await waitFor(bob, (s) => s.players.some((p) => p.name === 'Alice' && p.locked));
  assert.equal(bobView.myPick, null);
  bob.emit('pick', { cell: 0 });
  a = await waitFor(alice, (s) => s.phase === 'reveal' && s.round === 1);
  assert.equal(a.board[0], 'x');
  assert.equal(a.reveal[0].result, 'crack');

  // Round 2: different cells -> both claim.
  await waitFor(alice, (s) => s.phase === 'picking' && s.round === 2);
  alice.emit('pick', { cell: 1 });
  bob.emit('pick', { cell: 35 });
  a = await waitFor(alice, (s) => s.phase === 'reveal' && s.round === 2);
  const aliceId = a.you;
  assert.equal(a.board[1], aliceId);

  // Round 3: Alice must now grow from cell 1; an illegal pick is refused.
  a = await waitFor(alice, (s) => s.phase === 'picking' && s.round === 3);
  assert.deepEqual(a.legal, [2, 7]);
  const problem = once(alice, 'problem');
  alice.emit('pick', { cell: 20 });
  assert.match((await problem).message, /can't pick/);

  // Refresh: Alice drops and resumes with her token, keeping her seat.
  alice.disconnect();
  const alice2 = client();
  alice2.emit('resume', { code, token });
  a = await waitFor(alice2, (s) => s.round >= 3);
  assert.equal(a.you, aliceId);

  // Play the rest out: each player always takes their first legal cell.
  const autoplay = (sock) => {
    const act = (s) => {
      if (s.phase === 'picking' && s.myPick === null && s.legal.length) sock.emit('pick', { cell: s.legal[0] });
    };
    sock.on('state', act);
    act(sock.last);
  };
  autoplay(alice2);
  autoplay(bob);

  const over = await waitFor(alice2, (s) => s.phase === 'over', 15000);
  assert.ok(!over.board.includes(null), 'board should be full');
  assert.equal(over.standings.length, 2);
  const total = over.standings.reduce((n, s) => n + s.cells, 0);
  assert.equal(total + over.board.filter((c) => c === 'x').length, 36);

  // Host sends everyone back to the lobby.
  alice2.emit('again');
  await waitFor(bob, (s) => s.phase === 'lobby');

  alice2.close();
  bob.close();
});

test('joining a bad code or a started game is refused', async () => {
  const c = client();
  const p = once(c, 'problem');
  c.emit('join', { code: 'ZZZZ', name: 'X' });
  assert.match((await p).message, /No room/);

  const host = client();
  const guest = client();
  host.emit('create', { name: 'H' });
  const { code } = await once(host, 'joined');
  guest.emit('join', { code, name: 'G' });
  await waitFor(host, (s) => s.players.length === 2);
  host.emit('start');
  await waitFor(host, (s) => s.phase === 'picking');
  const late = once(c, 'problem');
  c.emit('join', { code, name: 'Late' });
  assert.match((await late).message, /already started/);

  for (const s of [c, host, guest]) s.close();
  rooms.clear();
});
