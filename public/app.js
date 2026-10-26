import { Chess } from './lib/chess.esm.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PIECE_GLYPH = {
  w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
  b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' },
};

const el = (id) => document.getElementById(id);
const boardEl = el('board');
const statusEl = el('status');
const fenInput = el('fenInput');
const suggestionResult = el('suggestionResult');
const suggestBtn = el('suggestBtn');

let chess = new Chess();
let orientation = 'w'; // which side is shown at the bottom
let selected = null; // currently selected square, e.g. "e2"
let legalTargets = []; // verbose moves from the selected square
let lastMove = null; // { from, to } highlight for the last played/suggested move
let searchDepth = 14;
let engineBusy = false;

// Real Stockfish (lite, single-threaded WASM build) driven over the UCI
// text protocol. This is a classic (non-module) worker because stockfish.js
// wires up its own `self.onmessage`/`postMessage` UCI handling when loaded
// as the worker's entry script. No SharedArrayBuffer/cross-origin-isolation
// headers are required, so it works in Safari/iOS PWAs.
const worker = new Worker('lib/stockfish.js');
let engineReady = false;
let readyResolve = null;
let pendingResolve = null;
let lastScoreCp = null;
let lastScoreMate = null;

const engineReadyPromise = new Promise((resolve) => {
  readyResolve = resolve;
});

worker.onmessage = (e) => {
  const line = typeof e.data === 'string' ? e.data : '';

  if (line === 'uciok') {
    worker.postMessage('isready');
    return;
  }
  if (line === 'readyok') {
    engineReady = true;
    if (readyResolve) {
      readyResolve();
      readyResolve = null;
    }
    return;
  }

  const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
  if (scoreMatch) {
    if (scoreMatch[1] === 'cp') {
      lastScoreCp = parseInt(scoreMatch[2], 10);
      lastScoreMate = null;
    } else {
      lastScoreMate = parseInt(scoreMatch[2], 10);
      lastScoreCp = null;
    }
  }

  const bestMoveMatch = line.match(/^bestmove (\S+)/);
  if (bestMoveMatch && pendingResolve) {
    const uciMove = bestMoveMatch[1];
    const resolve = pendingResolve;
    pendingResolve = null;
    if (uciMove === '(none)') {
      resolve({ ok: true, move: null, score: 0, depth: 0 });
      return;
    }
    const from = uciMove.slice(0, 2);
    const to = uciMove.slice(2, 4);
    const promotion = uciMove.length > 4 ? uciMove[4] : undefined;
    let score;
    if (lastScoreMate !== null) {
      score = lastScoreMate === 0 ? 0 : (lastScoreMate > 0 ? 1 : -1) * (100000 - Math.abs(lastScoreMate));
    } else {
      score = lastScoreCp ?? 0;
    }
    resolve({ ok: true, move: { from, to, promotion }, score, depth: requestedDepth });
  }
};

worker.postMessage('uci');

let requestedDepth = 0;

async function requestBestMove(fen, depth, timeMs) {
  if (!engineReady) await engineReadyPromise;
  requestedDepth = depth;
  lastScoreCp = null;
  lastScoreMate = null;
  return new Promise((resolve) => {
    pendingResolve = resolve;
    worker.postMessage('position fen ' + fen);
    worker.postMessage(`go depth ${depth} movetime ${timeMs}`);
  });
}

function squareName(file, rank) {
  return String.fromCharCode(97 + file) + (rank + 1);
}

function renderBoard() {
  boardEl.innerHTML = '';
  const board = chess.board(); // board[0] = rank 8 .. board[7] = rank 1

  for (let displayRow = 0; displayRow < 8; displayRow++) {
    for (let displayCol = 0; displayCol < 8; displayCol++) {
      // Map visual grid position to actual rank/file depending on orientation.
      // board[0] is rank 8, board[7] is rank 1 (see chess.board() above), so the
      // chosen side's back rank must land on the bottom-most display row.
      const rank = orientation === 'w' ? displayRow : 7 - displayRow; // 0..7 -> board array row index
      const file = orientation === 'w' ? displayCol : 7 - displayCol;
      const sq = board[rank][file];
      const name = squareName(file, 7 - rank);

      const squareDiv = document.createElement('div');
      const isLight = (file + (7 - rank)) % 2 !== 0;
      squareDiv.className = `square ${isLight ? 'light' : 'dark'}`;
      squareDiv.dataset.square = name;

      if (selected === name) squareDiv.classList.add('selected');
      if (lastMove && (lastMove.from === name || lastMove.to === name)) {
        squareDiv.classList.add(lastMove.from === name ? 'from' : 'to');
      }
      const target = legalTargets.find((m) => m.to === name);
      if (target) {
        squareDiv.classList.add('legal');
        if (target.captured) squareDiv.classList.add('capture');
      }

      if (sq) {
        const pieceSpan = document.createElement('span');
        pieceSpan.className = `piece ${sq.color === 'w' ? 'piece-white' : 'piece-black'}`;
        pieceSpan.textContent = PIECE_GLYPH[sq.color][sq.type];
        squareDiv.appendChild(pieceSpan);
      }

      squareDiv.addEventListener('click', () => onSquareClick(name));
      boardEl.appendChild(squareDiv);
    }
  }
}

function onSquareClick(name) {
  if (engineBusy) return;

  if (selected) {
    const move = legalTargets.find((m) => m.to === name);
    if (move) {
      applyMove(move);
      selected = null;
      legalTargets = [];
      renderBoard();
      return;
    }
  }

  const piece = chess.get(name);
  if (piece && piece.color === chess.turn()) {
    selected = name;
    legalTargets = chess.moves({ square: name, verbose: true });
  } else {
    selected = null;
    legalTargets = [];
  }
  renderBoard();
}

function applyMove(move) {
  // Auto-promote to queen; chess.js requires a promotion piece for pawns
  // reaching the last rank even if multiple options exist in the move list.
  const result = chess.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
  if (!result) return;
  lastMove = { from: result.from, to: result.to };
  syncFen();
  updateStatus();
  suggestionResult.textContent = '';
  saveCurrentGame();
}

function updateStatus() {
  if (chess.isCheckmate()) {
    statusEl.textContent = `Checkmate — ${chess.turn() === 'w' ? 'Black' : 'White'} wins.`;
  } else if (chess.isStalemate()) {
    statusEl.textContent = 'Stalemate — draw.';
  } else if (chess.isDraw()) {
    statusEl.textContent = 'Draw.';
  } else if (chess.isCheck()) {
    statusEl.textContent = `${chess.turn() === 'w' ? 'White' : 'Black'} to move — check!`;
  } else {
    statusEl.textContent = `${chess.turn() === 'w' ? 'White' : 'Black'} to move`;
  }
  el('undoBtn').disabled = chess.history().length === 0;
}

function syncFen() {
  fenInput.value = chess.fen();
}

async function suggestMove() {
  if (engineBusy) return;
  engineBusy = true;
  suggestBtn.disabled = true;
  suggestionResult.textContent = 'Thinking…';

  const timeMs = searchDepth <= 8 ? 800 : searchDepth <= 14 ? 2500 : 6000;
  const fen = chess.fen();
  try {
    const result = await requestBestMove(fen, searchDepth, timeMs);
    if (!result.ok) {
      suggestionResult.textContent = `Error: ${result.error}`;
    } else if (!result.move) {
      suggestionResult.textContent = 'No legal moves (game over).';
    } else {
      // Stockfish returns moves in raw UCI form (e.g. "e2e4"); derive the SAN
      // notation from a scratch board so the displayed move text matches
      // standard algebraic notation.
      const scratch = new Chess(fen);
      const sanMove = scratch.move({ from: result.move.from, to: result.move.to, promotion: result.move.promotion || 'q' });
      lastMove = { from: result.move.from, to: result.move.to };
      const scoreText = describeScore(result.score);
      suggestionResult.textContent = `Suggested: ${sanMove ? sanMove.san : result.move.from + result.move.to}  (depth ${result.depth}, ${scoreText})`;
      renderBoard();
    }
  } finally {
    engineBusy = false;
    suggestBtn.disabled = false;
  }
}

function describeScore(score) {
  if (score > 90000) return 'mate found';
  if (score < -90000) return 'losing — mate against you';
  const pawns = (score / 100).toFixed(2);
  return `eval ${pawns > 0 ? '+' : ''}${pawns}`;
}

function loadFen(fen) {
  try {
    chess = new Chess(fen);
    selected = null;
    legalTargets = [];
    lastMove = null;
    suggestionResult.textContent = '';
    startNewGame(chess.fen());
    syncFen();
    updateStatus();
    renderBoard();
  } catch (err) {
    statusEl.textContent = 'Invalid FEN.';
  }
}

// --- Recent games (last 10, persisted in localStorage) ---

const GAMES_KEY = 'chessAssistant.recentGames';
const MAX_GAMES = 10;
let currentGame = null; // { id, startFen, moves: [san], fen, orientation, updatedAt }

// Games are persisted in data/games.json on the server. An in-memory cache
// keeps the UI synchronous; localStorage is a fallback if the server is unreachable.
let gamesCache = [];

function readGames() {
  return gamesCache;
}

function writeGames(games) {
  gamesCache = games;
  try {
    localStorage.setItem(GAMES_KEY, JSON.stringify(games));
  } catch (err) {
    // storage unavailable or full
  }
  fetch('api/games', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(games),
  }).catch(() => {});
}

async function loadGames() {
  try {
    const res = await fetch('api/games', { cache: 'no-store' });
    if (res.ok) {
      const games = await res.json();
      if (Array.isArray(games) && games.length) {
        gamesCache = games;
        return;
      }
    }
  } catch (err) {
    // fall through to local copy
  }
  try {
    const local = JSON.parse(localStorage.getItem(GAMES_KEY));
    if (Array.isArray(local)) {
      gamesCache = local;
      // push existing browser-only games up to the server (one-time migration)
      if (local.length) writeGames(local);
    }
  } catch (err) {
    gamesCache = [];
  }
}

function startNewGame(startFen) {
  const games = readGames();
  // An untouched newest game is replaced instead of using up a slot.
  if (games.length && games[0].moves.length === 0) games.shift();
  currentGame = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    startFen,
    moves: [],
    fen: startFen,
    orientation,
    updatedAt: Date.now(),
  };
  games.unshift(currentGame);
  writeGames(games.slice(0, MAX_GAMES));
}

function saveCurrentGame() {
  if (!currentGame) return;
  currentGame.moves = chess.history();
  currentGame.fen = chess.fen();
  currentGame.orientation = orientation;
  currentGame.updatedAt = Date.now();
  const games = readGames().filter((g) => g.id !== currentGame.id);
  games.unshift(currentGame);
  writeGames(games.slice(0, MAX_GAMES));
}

function openGame(id) {
  const game = readGames().find((g) => g.id === id);
  if (!game) return;
  try {
    const restored = new Chess(game.startFen);
    for (const san of game.moves) restored.move(san);
    chess = restored;
  } catch (err) {
    statusEl.textContent = 'Could not load that game.';
    return;
  }
  currentGame = game;
  orientation = game.orientation || 'w';
  [...el('sideSelect').children].forEach((b) => b.classList.toggle('active', b.dataset.side === orientation));
  selected = null;
  legalTargets = [];
  const last = chess.history({ verbose: true }).pop();
  lastMove = last ? { from: last.from, to: last.to } : null;
  suggestionResult.textContent = '';
  saveCurrentGame();
  syncFen();
  updateStatus();
  renderBoard();
  showTab('game');
}

function deleteGame(id) {
  const wasCurrent = currentGame && currentGame.id === id;
  writeGames(readGames().filter((g) => g.id !== id));
  if (wasCurrent) {
    currentGame = null;
    loadFen(START_FEN);
  }
  renderRecent();
}

function renderRecent() {
  const list = el('recentList');
  list.innerHTML = '';
  const games = readGames();
  if (!games.length) {
    list.innerHTML = '<div class="empty">No games yet.</div>';
    return;
  }
  for (const g of games) {
    const item = document.createElement('div');
    item.className = 'game-item';
    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 'title';
    const plies = g.moves.length;
    title.textContent = `${new Date(g.updatedAt).toLocaleString()}${currentGame && currentGame.id === g.id ? ' (current)' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = plies ? `${Math.ceil(plies / 2)} moves · ${g.moves.slice(-4).join(' ')}` : 'No moves yet';
    info.append(title, meta);
    info.addEventListener('click', () => openGame(g.id));
    const open = document.createElement('button');
    open.textContent = 'Open';
    open.addEventListener('click', () => openGame(g.id));
    const del = document.createElement('button');
    del.textContent = '🗑';
    del.setAttribute('aria-label', 'Delete game');
    del.addEventListener('click', () => deleteGame(g.id));
    item.append(info, open, del);
    list.appendChild(item);
  }
}

function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  el('gameView').classList.toggle('hidden', tab !== 'game');
  el('recentView').classList.toggle('hidden', tab !== 'recent');
  if (tab === 'recent') renderRecent();
}

el('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) showTab(btn.dataset.tab);
});

// --- UI wiring ---

el('menuBtn').addEventListener('click', () => el('panel').classList.toggle('hidden'));

el('sideSelect').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-side]');
  if (!btn) return;
  [...el('sideSelect').children].forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  orientation = btn.dataset.side;
  saveCurrentGame();
  renderBoard();
});

el('strengthSelect').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-depth]');
  if (!btn) return;
  [...el('strengthSelect').children].forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  searchDepth = parseInt(btn.dataset.depth, 10);
});

el('loadFenBtn').addEventListener('click', () => loadFen(fenInput.value.trim()));
el('copyFenBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(chess.fen());
  suggestionResult.textContent = 'FEN copied.';
});
el('resetBtn').addEventListener('click', () => loadFen(START_FEN));
el('flipBtn').addEventListener('click', () => {
  orientation = orientation === 'w' ? 'b' : 'w';
  saveCurrentGame();
  renderBoard();
});
el('undoBtn').addEventListener('click', () => {
  chess.undo();
  selected = null;
  legalTargets = [];
  lastMove = null;
  saveCurrentGame();
  syncFen();
  updateStatus();
  renderBoard();
});

suggestBtn.addEventListener('click', suggestMove);

// iOS install hint: only show in Safari browser tab, not once already installed.
if (!window.navigator.standalone) {
  el('installHint').classList.remove('hidden');
}

await loadGames();
const savedGames = readGames();
if (savedGames.length) openGame(savedGames[0].id);
else loadFen(START_FEN);
