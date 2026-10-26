// Pure game rules for Collide. No sockets or timers here, so it can be tested directly.

const MAX_PLAYERS = 8;
const COLORS = ['#ff5d73', '#3ec5ff', '#ffd23f', '#7ae582', '#c77dff', '#ff9f43', '#4ef0d0', '#f15bb5'];

function boardSizeFor(playerCount) {
  if (playerCount <= 2) return 6;
  if (playerCount <= 4) return 7;
  if (playerCount <= 6) return 8;
  return 9;
}

function neighbors(index, size) {
  const r = Math.floor(index / size);
  const c = index % size;
  const out = [];
  if (r > 0) out.push(index - size);
  if (r < size - 1) out.push(index + size);
  if (c > 0) out.push(index - 1);
  if (c < size - 1) out.push(index + 1);
  return out;
}

function newBoard(size) {
  return Array.from({ length: size * size }, () => ({ owner: null, cracked: false }));
}

function isEmpty(cell) {
  return cell.owner === null && !cell.cracked;
}

// A player must expand from their own territory. If they own nothing yet,
// or are fully boxed in, any empty cell is legal.
function legalCells(board, size, playerId) {
  const empty = [];
  const adjacent = new Set();
  let ownsAny = false;
  board.forEach((cell, i) => {
    if (isEmpty(cell)) empty.push(i);
    if (cell.owner === playerId) {
      ownsAny = true;
      for (const n of neighbors(i, size)) if (isEmpty(board[n])) adjacent.add(n);
    }
  });
  if (!ownsAny || adjacent.size === 0) return empty;
  return [...adjacent].sort((a, b) => a - b);
}

// picks: Map<playerId, cellIndex>. Mutates board and returns what happened per cell.
function resolveRound(board, picks) {
  const byCell = new Map();
  for (const [playerId, cell] of picks) {
    if (!byCell.has(cell)) byCell.set(cell, []);
    byCell.get(cell).push(playerId);
  }
  const results = [];
  for (const [cell, players] of byCell) {
    if (players.length === 1) {
      board[cell].owner = players[0];
      results.push({ cell, players, result: 'claim' });
    } else {
      board[cell].cracked = true;
      results.push({ cell, players, result: 'crack' });
    }
  }
  return results.sort((a, b) => a.cell - b.cell);
}

function largestRegion(board, size, playerId) {
  const seen = new Set();
  let best = 0;
  board.forEach((cell, start) => {
    if (cell.owner !== playerId || seen.has(start)) return;
    let count = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const i = stack.pop();
      count++;
      for (const n of neighbors(i, size)) {
        if (!seen.has(n) && board[n].owner === playerId) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    best = Math.max(best, count);
  });
  return best;
}

function scores(board, size, playerIds) {
  return playerIds
    .map((id) => ({
      id,
      cells: board.filter((c) => c.owner === id).length,
      region: largestRegion(board, size, id),
    }))
    .sort((a, b) => b.cells - a.cells || b.region - a.region);
}

function isBoardFull(board) {
  return !board.some(isEmpty);
}

module.exports = {
  MAX_PLAYERS,
  COLORS,
  boardSizeFor,
  neighbors,
  newBoard,
  legalCells,
  resolveRound,
  largestRegion,
  scores,
  isBoardFull,
};
