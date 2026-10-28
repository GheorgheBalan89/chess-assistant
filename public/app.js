import { Chess } from './lib/chess.esm.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
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
  drawBoard(boardEl, chess, { orientation, selected, legalTargets, lastMove }, onSquareClick);
}

function drawBoard(container, game, view, onClick) {
  container.innerHTML = '';
  const board = game.board(); // board[0] = rank 8 .. board[7] = rank 1
  const { orientation, selected, legalTargets, lastMove } = view;

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
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const pieceSvg = document.createElementNS(SVG_NS, 'svg');
        pieceSvg.setAttribute('class', 'piece');
        pieceSvg.setAttribute('viewBox', '0 0 45 45');
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', `pieces.svg#${sq.color}${sq.type}`);
        pieceSvg.appendChild(use);
        squareDiv.appendChild(pieceSvg);
      }

      squareDiv.addEventListener('click', () => onClick(name));
      container.appendChild(squareDiv);
    }
  }
}

function onSquareClick(name) {
  if (engineBusy) return;

  if (selected) {
    const move = legalTargets.find((m) => m.to === name);
    if (move) {
      const from = move.from;
      const finish = (promotion) => {
        applyMove({ from, to: name, promotion });
        selected = null;
        legalTargets = [];
        renderBoard();
      };
      if (move.isPromotion()) {
        askPromotion(chess.turn()).then((p) => { if (p) finish(p); });
      } else {
        finish(undefined);
      }
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

function askPromotion(color) {
  return new Promise((resolve) => {
    const modal = el('promoModal');
    const choices = el('promoChoices');
    choices.textContent = '';
    const close = (value) => {
      modal.classList.add('hidden');
      resolve(value);
    };
    for (const type of ['q', 'r', 'n', 'b']) {
      const btn = document.createElement('button');
      btn.className = 'promoChoice';
      btn.setAttribute('aria-label', { q: 'Queen', r: 'Rook', n: 'Knight', b: 'Bishop' }[type]);
      btn.innerHTML = `<svg viewBox="0 0 45 45"><use href="pieces.svg#${color}${type}"></use></svg>`;
      btn.addEventListener('click', () => close(type));
      choices.appendChild(btn);
    }
    el('promoCancel').onclick = () => close(null);
    modal.classList.remove('hidden');
  });
}

function applyMove(move) {
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
      if (sanMove) {
        addPuzzle({
          fen,
          bestUci: result.move.from + result.move.to + (result.move.promotion || ''),
          bestSan: sanMove.san,
          score: result.score,
          depth: result.depth,
        });
      }
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

// Persisted lists live in data/*.json on the server. An in-memory cache keeps the
// UI synchronous; localStorage is a fallback if the server is unreachable.
function createStore(name, localKey) {
  let cache = [];
  const store = {
    read: () => cache,
    write(items) {
      cache = items;
      try {
        localStorage.setItem(localKey, JSON.stringify(items));
      } catch (err) {
        // storage unavailable or full
      }
      fetch(`api/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
      }).catch(() => {});
    },
    async load() {
      try {
        const res = await fetch(`api/${name}`, { cache: 'no-store' });
        if (res.ok) {
          const items = await res.json();
          if (Array.isArray(items) && items.length) {
            cache = items;
            return;
          }
        }
      } catch (err) {
        // fall through to local copy
      }
      try {
        const local = JSON.parse(localStorage.getItem(localKey));
        if (Array.isArray(local)) {
          cache = local;
          // push existing browser-only data up to the server (one-time migration)
          if (local.length) store.write(local);
        }
      } catch (err) {
        cache = [];
      }
    },
  };
  return store;
}

const gamesStore = createStore('games', GAMES_KEY);
const readGames = gamesStore.read;
const writeGames = gamesStore.write;

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

// --- Puzzles: every position you asked the engine about, kept for practice ---

const MAX_PUZZLES = 500;
const puzzlesStore = createStore('puzzles', 'chessAssistant.puzzles');
let pz = null; // active puzzle session: { puzzle, game, selected, legalTargets, lastMove, solved }

function positionKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

function addPuzzle({ fen, bestUci, bestSan, score, depth }) {
  const key = positionKey(fen);
  const puzzles = puzzlesStore.read().slice();
  const existing = puzzles.find((p) => p.key === key);
  if (existing) {
    // Same position asked again: keep the stats, refresh the answer if searched deeper.
    if (depth >= existing.depth) Object.assign(existing, { bestUci, bestSan, score, depth, fen });
    existing.askedCount = (existing.askedCount || 1) + 1;
    puzzlesStore.write(puzzles);
    return;
  }
  puzzles.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    key,
    fen,
    bestUci,
    bestSan,
    score,
    depth,
    createdAt: Date.now(),
    askedCount: 1,
    attempts: 0,
    solved: 0,
    lastPracticedAt: null,
  });
  puzzlesStore.write(puzzles.slice(0, MAX_PUZZLES));
}

function updatePuzzle(id, patch) {
  const puzzles = puzzlesStore.read().map((p) => (p.id === id ? { ...p, ...patch } : p));
  puzzlesStore.write(puzzles);
  if (pz && pz.puzzle.id === id) pz.puzzle = { ...pz.puzzle, ...patch };
}

function renderPuzzleList() {
  const list = el('puzzleList');
  list.innerHTML = '';
  const puzzles = puzzlesStore.read();
  if (!puzzles.length) {
    list.innerHTML = '<div class="empty">No puzzles yet. Positions where you tap “Suggest Best Move” are added here automatically.</div>';
    return;
  }
  for (const p of puzzles) {
    const item = document.createElement('div');
    item.className = 'game-item';
    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = `${p.fen.split(' ')[1] === 'w' ? 'White' : 'Black'} to move`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${new Date(p.createdAt).toLocaleDateString()} · solved ${p.solved}/${p.attempts} tries`;
    info.append(title, meta);
    info.addEventListener('click', () => openPuzzle(p.id));
    const open = document.createElement('button');
    open.textContent = 'Solve';
    open.addEventListener('click', () => openPuzzle(p.id));
    const del = document.createElement('button');
    del.textContent = '🗑';
    del.setAttribute('aria-label', 'Delete puzzle');
    del.addEventListener('click', () => {
      puzzlesStore.write(puzzlesStore.read().filter((x) => x.id !== p.id));
      renderPuzzleList();
    });
    item.append(info, open, del);
    list.appendChild(item);
  }
}

function drawPuzzle() {
  drawBoard(el('puzzleBoard'), pz.game, {
    orientation: pz.puzzle.fen.split(' ')[1],
    selected: pz.selected,
    legalTargets: pz.legalTargets,
    lastMove: pz.lastMove,
  }, onPuzzleSquareClick);
}

function openPuzzle(id) {
  const puzzle = puzzlesStore.read().find((p) => p.id === id);
  if (!puzzle) return;
  pz = { puzzle, game: new Chess(puzzle.fen), selected: null, legalTargets: [], lastMove: null, solved: false };
  el('puzzleList').classList.add('hidden');
  el('puzzleSolve').classList.remove('hidden');
  el('puzzleStatus').textContent = `Find the best move for ${puzzle.fen.split(' ')[1] === 'w' ? 'White' : 'Black'}.`;
  el('puzzleShowBtn').disabled = false;
  drawPuzzle();
}

function closePuzzle() {
  pz = null;
  el('puzzleSolve').classList.add('hidden');
  el('puzzleList').classList.remove('hidden');
  renderPuzzleList();
}

function onPuzzleSquareClick(name) {
  if (!pz || pz.solved) return;
  const game = pz.game;

  if (pz.selected) {
    const move = pz.legalTargets.find((m) => m.to === name);
    if (move) {
      const attempt = pz.puzzle.bestUci.slice(0, 4) === move.from + move.to;
      pz.selected = null;
      pz.legalTargets = [];
      if (attempt) {
        game.move({ from: move.from, to: move.to, promotion: pz.puzzle.bestUci[4] || move.promotion || 'q' });
        pz.lastMove = { from: move.from, to: move.to };
        pz.solved = true;
        el('puzzleStatus').textContent = `Correct! ${pz.puzzle.bestSan} ✓`;
        el('puzzleShowBtn').disabled = true;
        updatePuzzle(pz.puzzle.id, {
          attempts: pz.puzzle.attempts + 1,
          solved: pz.puzzle.solved + 1,
          lastPracticedAt: Date.now(),
        });
      } else {
        el('puzzleStatus').textContent = 'Not the best move — try again.';
        updatePuzzle(pz.puzzle.id, { attempts: pz.puzzle.attempts + 1, lastPracticedAt: Date.now() });
      }
      drawPuzzle();
      return;
    }
  }

  const piece = game.get(name);
  if (piece && piece.color === game.turn()) {
    pz.selected = name;
    pz.legalTargets = game.moves({ square: name, verbose: true });
  } else {
    pz.selected = null;
    pz.legalTargets = [];
  }
  drawPuzzle();
}

el('puzzleShowBtn').addEventListener('click', () => {
  if (!pz || pz.solved) return;
  const uci = pz.puzzle.bestUci;
  pz.lastMove = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
  pz.selected = null;
  pz.legalTargets = [];
  el('puzzleStatus').textContent = `Solution: ${pz.puzzle.bestSan}`;
  drawPuzzle();
});
el('puzzleBackBtn').addEventListener('click', closePuzzle);

function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  el('gameView').classList.toggle('hidden', tab !== 'game');
  el('recentView').classList.toggle('hidden', tab !== 'recent');
  el('puzzlesView').classList.toggle('hidden', tab !== 'puzzles');
  if (tab === 'recent') renderRecent();
  if (tab === 'puzzles') closePuzzle();
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

await Promise.all([gamesStore.load(), puzzlesStore.load()]);
const savedGames = readGames();
if (savedGames.length) openGame(savedGames[0].id);
else loadFen(START_FEN);
