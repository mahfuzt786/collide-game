const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../game');

test('unique pick claims, shared pick cracks', () => {
  const board = g.newBoard(3);
  const results = g.resolveRound(board, new Map([['a', 0], ['b', 4], ['c', 4]]));
  assert.equal(board[0].owner, 'a');
  assert.equal(board[4].cracked, true);
  assert.equal(board[4].owner, null);
  assert.deepEqual(results.map((r) => r.result), ['claim', 'crack']);
});

test('first pick is anywhere, then must touch own land', () => {
  const board = g.newBoard(3);
  assert.equal(g.legalCells(board, 3, 'a').length, 9);
  board[0].owner = 'a';
  assert.deepEqual(g.legalCells(board, 3, 'a'), [1, 3]);
});

test('boxed-in player may pick anywhere empty', () => {
  const board = g.newBoard(3);
  board[0].owner = 'a';
  board[1].cracked = true;
  board[3].owner = 'b';
  assert.deepEqual(g.legalCells(board, 3, 'a'), [2, 4, 5, 6, 7, 8]);
});

test('scores rank by cells then largest connected region', () => {
  const board = g.newBoard(3);
  // a: 0,1 connected (region 2). b: 6,8 split (region 1).
  board[0].owner = 'a';
  board[1].owner = 'a';
  board[6].owner = 'b';
  board[8].owner = 'b';
  const s = g.scores(board, 3, ['b', 'a']);
  assert.deepEqual(s.map((x) => x.id), ['a', 'b']);
  assert.equal(s[0].region, 2);
});

test('board size grows with player count', () => {
  assert.equal(g.boardSizeFor(2), 6);
  assert.equal(g.boardSizeFor(4), 7);
  assert.equal(g.boardSizeFor(8), 9);
});
