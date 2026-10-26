// Static file server for the Chess Assistant PWA, plus a tiny API that persists
// the last 10 games and the puzzle list in data/*.json. Chess logic + Stockfish run client-side.
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_GAMES = 10;
const MAX_PUZZLES = 500;
const DATA_DIR = path.join(__dirname, 'data');

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function sanitizeGames(input) {
  if (!Array.isArray(input)) return null;
  const games = [];
  for (const g of input.slice(0, MAX_GAMES)) {
    if (!g || typeof g.id !== 'string' || typeof g.startFen !== 'string' || !Array.isArray(g.moves)) return null;
    games.push({
      id: g.id.slice(0, 64),
      startFen: g.startFen.slice(0, 100),
      moves: g.moves.filter((m) => typeof m === 'string').map((m) => m.slice(0, 12)).slice(0, 1000),
      fen: str(g.fen, 100) || g.startFen,
      orientation: g.orientation === 'b' ? 'b' : 'w',
      updatedAt: Number(g.updatedAt) || Date.now(),
    });
  }
  return games;
}

function sanitizePuzzles(input) {
  if (!Array.isArray(input)) return null;
  const puzzles = [];
  for (const p of input.slice(0, MAX_PUZZLES)) {
    if (!p || typeof p.id !== 'string' || typeof p.fen !== 'string' || typeof p.bestUci !== 'string') return null;
    puzzles.push({
      id: p.id.slice(0, 64),
      key: str(p.key, 100) || p.fen.split(' ').slice(0, 4).join(' '),
      fen: p.fen.slice(0, 100),
      bestUci: p.bestUci.slice(0, 5),
      bestSan: str(p.bestSan, 12) || p.bestUci,
      score: num(p.score),
      depth: num(p.depth),
      createdAt: Number(p.createdAt) || Date.now(),
      askedCount: num(p.askedCount) || 1,
      attempts: num(p.attempts),
      solved: num(p.solved),
      lastPracticedAt: p.lastPracticedAt == null ? null : num(p.lastPracticedAt),
    });
  }
  return puzzles;
}

app.use(express.json({ limit: '2mb' }));

// Registers GET/PUT /api/<name> backed by data/<name>.json.
function registerStore(name, sanitize) {
  const file = path.join(DATA_DIR, `${name}.json`);
  app.get(`/api/${name}`, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const items = JSON.parse(fs.readFileSync(file, 'utf8'));
      res.json(Array.isArray(items) ? items : []);
    } catch (err) {
      res.json([]);
    }
  });
  app.put(`/api/${name}`, (req, res) => {
    const items = sanitize(req.body);
    if (!items) return res.status(400).json({ error: `Invalid ${name} payload` });
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
      fs.renameSync(tmp, file);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: `Could not save ${name}` });
    }
  });
}

registerStore('games', sanitizeGames);
registerStore('puzzles', sanitizePuzzles);
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Chess Assistant running at http://localhost:${PORT}`);
  console.log('On your iPhone (same Wi-Fi), open http://<this-computer-ip>:' + PORT);
});
