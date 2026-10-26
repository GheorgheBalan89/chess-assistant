// Static file server for the Chess Assistant PWA, plus a tiny API that persists
// the last 10 games in data/games.json. Chess logic + Stockfish run client-side.
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_GAMES = 10;
const DATA_DIR = path.join(__dirname, 'data');
const GAMES_FILE = path.join(DATA_DIR, 'games.json');

function readGames() {
  try {
    const games = JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
    return Array.isArray(games) ? games : [];
  } catch (err) {
    return [];
  }
}

function sanitizeGames(input) {
  if (!Array.isArray(input)) return null;
  const games = [];
  for (const g of input.slice(0, MAX_GAMES)) {
    if (!g || typeof g.id !== 'string' || typeof g.startFen !== 'string' || !Array.isArray(g.moves)) return null;
    games.push({
      id: g.id.slice(0, 64),
      startFen: g.startFen.slice(0, 100),
      moves: g.moves.filter((m) => typeof m === 'string').map((m) => m.slice(0, 12)).slice(0, 1000),
      fen: typeof g.fen === 'string' ? g.fen.slice(0, 100) : g.startFen,
      orientation: g.orientation === 'b' ? 'b' : 'w',
      updatedAt: Number(g.updatedAt) || Date.now(),
    });
  }
  return games;
}

app.use(express.json({ limit: '1mb' }));

app.get('/api/games', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(readGames());
});

app.put('/api/games', (req, res) => {
  const games = sanitizeGames(req.body);
  if (!games) return res.status(400).json({ error: 'Invalid games payload' });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = GAMES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(games, null, 2));
    fs.renameSync(tmp, GAMES_FILE);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not save games' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Chess Assistant running at http://localhost:${PORT}`);
  console.log('On your iPhone (same Wi-Fi), open http://<this-computer-ip>:' + PORT);
});
