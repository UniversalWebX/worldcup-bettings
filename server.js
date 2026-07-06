/**
 * World Cup Token Betting Simulator
 * -----------------------------------
 * Express + Socket.IO backend. Pulls World Cup 2026 fixtures from
 * football-data.org, lets logged-in (username-only, no password) users
 * redeem hardcoded gift codes for tokens, and place pari-mutuel bets
 * against each other on match outcomes. No real money anywhere.
 */

const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN || "";
const COMPETITION_CODE = "WC"; // FIFA World Cup on football-data.org
const API_BASE = "https://api.football-data.org/v4";
const DB_FILE = path.join(__dirname, "data", "db.json");
const HOUSE_EDGE = 0.05; // 5% cut taken from the losing pool before it's redistributed
const STARTING_TOKENS = 0; // new users start at 0 and must redeem a code
const MATCH_POLL_MS = 60 * 1000; // how often we refresh fixtures/scores
const MIN_BET = 10;

// ---------------------------------------------------------------------------
// Hardcoded, pre-generated redeem codes.
// Each code can be redeemed ONCE total (first user to redeem it gets the tokens).
// Feel free to regenerate / extend this list.
// ---------------------------------------------------------------------------
const REDEEM_CODES = {
  "WC26-CXZ5-2ATO": 200,
  "WC26-9G6D-S1EW": 200,
  "WC26-CXQU-I6WU": 200,
  "WC26-IYF3-N8Z5": 200,
  "WC26-JNQ0-JUH3": 200,
  "WC26-UZQA-AZWR": 200,
  "WC26-2AJJ-R1KI": 200,
  "WC26-PHZZ-QLHB": 200,
  "WC26-KEMW-QZ7I": 500,
  "WC26-TZGA-Y0FD": 500,
  "WC26-8GLW-AI68": 500,
  "WC26-UCDJ-XJSQ": 500,
  "WC26-JYHW-A9TI": 500,
  "WC26-UEGZ-WLQC": 500,
  "WC26-PKGU-LU68": 1000,
  "WC26-INCM-BDJ6": 1000,
  "WC26-ZV4V-NBMP": 1000,
  "WC26-BG0J-PNJZ": 1000,
  "WC26-KOMH-XVVX": 2500,
  "WC26-ONVN-HXBT": 2500,
};

// ---------------------------------------------------------------------------
// Tiny JSON "database". Fine for a demo; swap for Postgres/Redis for
// anything real (see README). Render's free disk is wiped on redeploy.
// ---------------------------------------------------------------------------
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { users: {}, redeemedCodes: {}, bets: [] };
  }
}

function saveDB() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const db = loadDB();
// db.users:         { [username]: { tokens, createdAt } }
// db.redeemedCodes: { [code]: { username, redeemedAt } }
// db.bets:          [{ id, username, matchId, pick, stake, status, payout, matchLabel, placedAt }]

let matchesCache = []; // last fetched fixtures from football-data.org
let lastFetchAt = 0;
let lastFetchError = null;

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function broadcastLeaderboard() {
  io.emit("leaderboard:update", getLeaderboard());
}

function getLeaderboard() {
  return Object.entries(db.users)
    .map(([username, u]) => ({ username, tokens: Math.round(u.tokens) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 50);
}

// ---------------------------------------------------------------------------
// football-data.org integration
// ---------------------------------------------------------------------------
async function fetchWorldCupMatches() {
  if (!FOOTBALL_DATA_TOKEN) {
    lastFetchError =
      "No FOOTBALL_DATA_TOKEN set on the server. Get a free key at football-data.org and set it as an env var.";
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/competitions/${COMPETITION_CODE}/matches`, {
      headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN },
    });
    if (!res.ok) {
      lastFetchError = `football-data.org responded ${res.status}: ${await res.text()}`;
      return;
    }
    const data = await res.json();
    matchesCache = (data.matches || []).map(normalizeMatch);
    lastFetchAt = Date.now();
    lastFetchError = null;
    io.emit("matches:update", getPublicMatches());
    await settleFinishedMatches();
  } catch (err) {
    lastFetchError = String(err);
  }
}

function normalizeMatch(m) {
  return {
    id: m.id,
    utcDate: m.utcDate,
    status: m.status, // SCHEDULED, TIMED, IN_PLAY, PAUSED, FINISHED, POSTPONED, etc.
    stage: m.stage,
    group: m.group,
    homeTeam: m.homeTeam?.name || "TBD",
    awayTeam: m.awayTeam?.name || "TBD",
    homeCrest: m.homeTeam?.crest || null,
    awayCrest: m.awayTeam?.crest || null,
    score: {
      home: m.score?.fullTime?.home ?? null,
      away: m.score?.fullTime?.away ?? null,
      winner: m.score?.winner || null, // HOME_TEAM, AWAY_TEAM, DRAW
    },
  };
}

function bettingIsOpen(match) {
  return (
    (match.status === "SCHEDULED" || match.status === "TIMED") &&
    new Date(match.utcDate).getTime() > Date.now()
  );
}

function poolsForMatch(matchId) {
  const pools = { HOME_TEAM: 0, DRAW: 0, AWAY_TEAM: 0 };
  for (const bet of db.bets) {
    if (bet.matchId === matchId && bet.status === "pending") {
      pools[bet.pick] += bet.stake;
    }
  }
  return pools;
}

function getPublicMatches() {
  const now = Date.now();
  return matchesCache
    .filter((m) => {
      const t = new Date(m.utcDate).getTime();
      // Show a window: matches from 3 days ago to end of tournament
      return t > now - 3 * 24 * 60 * 60 * 1000;
    })
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .map((m) => ({
      ...m,
      bettingOpen: bettingIsOpen(m),
      pools: poolsForMatch(m.id),
    }));
}

// Settle bets for any FINISHED match that still has pending bets, using
// pari-mutuel payout: winners split the (house-edge-adjusted) losing pool
// proportional to their stake, plus they get their own stake back.
async function settleFinishedMatches() {
  const finished = matchesCache.filter((m) => m.status === "FINISHED" && m.score.winner);
  let changed = false;

  for (const match of finished) {
    const pendingBets = db.bets.filter((b) => b.matchId === match.id && b.status === "pending");
    if (pendingBets.length === 0) continue;

    const pools = poolsForMatch(match.id);
    const winningPick = match.score.winner; // HOME_TEAM | AWAY_TEAM | DRAW
    const winningPoolTotal = pools[winningPick] || 0;
    const losingPoolTotal =
      pools.HOME_TEAM + pools.DRAW + pools.AWAY_TEAM - winningPoolTotal;
    const distributable = losingPoolTotal * (1 - HOUSE_EDGE);

    for (const bet of pendingBets) {
      changed = true;
      if (bet.pick === winningPick && winningPoolTotal > 0) {
        const share = bet.stake / winningPoolTotal;
        const winnings = share * distributable;
        const payout = bet.stake + winnings;
        bet.status = "won";
        bet.payout = Math.round(payout * 100) / 100;
        if (db.users[bet.username]) {
          db.users[bet.username].tokens += bet.payout;
        }
      } else {
        bet.status = "lost";
        bet.payout = 0;
      }
      bet.settledAt = new Date().toISOString();
    }
  }

  if (changed) {
    saveDB();
    broadcastLeaderboard();
    io.emit("bets:settled");
  }
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// Login / register by username only. No passwords - this is a play-money demo.
app.post("/api/login", (req, res) => {
  const username = String(req.body.username || "").trim().slice(0, 24);
  if (!/^[a-zA-Z0-9_ -]{2,24}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 2-24 chars (letters, numbers, _, -, space)." });
  }
  if (!db.users[username]) {
    db.users[username] = { tokens: STARTING_TOKENS, createdAt: new Date().toISOString() };
    saveDB();
    broadcastLeaderboard();
  }
  res.json({ username, tokens: db.users[username].tokens });
});

app.post("/api/redeem", (req, res) => {
  const { username, code } = req.body;
  if (!username || !db.users[username]) return res.status(400).json({ error: "Log in first." });
  const cleanCode = String(code || "").trim().toUpperCase();

  if (!(cleanCode in REDEEM_CODES)) {
    return res.status(400).json({ error: "That code doesn't exist." });
  }
  if (db.redeemedCodes[cleanCode]) {
    return res.status(400).json({
      error: `That code was already redeemed by ${db.redeemedCodes[cleanCode].username}.`,
    });
  }

  const tokens = REDEEM_CODES[cleanCode];
  db.users[username].tokens += tokens;
  db.redeemedCodes[cleanCode] = { username, redeemedAt: new Date().toISOString() };
  saveDB();
  broadcastLeaderboard();
  res.json({ tokens, balance: db.users[username].tokens });
});

app.get("/api/matches", (_req, res) => {
  res.json({
    matches: getPublicMatches(),
    lastFetchAt,
    lastFetchError,
  });
});

app.get("/api/leaderboard", (_req, res) => {
  res.json(getLeaderboard());
});

app.get("/api/mybets/:username", (req, res) => {
  const bets = db.bets
    .filter((b) => b.username === req.params.username)
    .sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
  res.json(bets);
});

app.post("/api/bet", (req, res) => {
  const { username, matchId, pick, stake } = req.body;
  const stakeNum = Number(stake);

  if (!username || !db.users[username]) return res.status(400).json({ error: "Log in first." });
  if (!["HOME_TEAM", "DRAW", "AWAY_TEAM"].includes(pick)) {
    return res.status(400).json({ error: "Invalid pick." });
  }
  if (!Number.isFinite(stakeNum) || stakeNum < MIN_BET) {
    return res.status(400).json({ error: `Minimum bet is ${MIN_BET} tokens.` });
  }
  const match = matchesCache.find((m) => m.id === Number(matchId));
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (!bettingIsOpen(match)) return res.status(400).json({ error: "Betting is closed for this match." });

  const user = db.users[username];
  if (user.tokens < stakeNum) return res.status(400).json({ error: "Not enough tokens." });

  user.tokens -= stakeNum;
  const bet = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    username,
    matchId: match.id,
    matchLabel: `${match.homeTeam} vs ${match.awayTeam}`,
    pick,
    stake: stakeNum,
    status: "pending",
    payout: null,
    placedAt: new Date().toISOString(),
  };
  db.bets.push(bet);
  saveDB();

  io.emit("bet:placed", { bet, pools: poolsForMatch(match.id) });
  broadcastLeaderboard();
  res.json({ bet, balance: user.tokens });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasApiToken: !!FOOTBALL_DATA_TOKEN, lastFetchAt, lastFetchError });
});

// ---------------------------------------------------------------------------
// Socket.IO: mostly just broadcasting; clients don't need to emit much.
// ---------------------------------------------------------------------------
io.on("connection", (socket) => {
  socket.emit("matches:update", getPublicMatches());
  socket.emit("leaderboard:update", getLeaderboard());
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
fetchWorldCupMatches();
setInterval(fetchWorldCupMatches, MATCH_POLL_MS);

server.listen(PORT, () => {
  console.log(`World Cup betting sim running on port ${PORT}`);
  if (!FOOTBALL_DATA_TOKEN) {
    console.warn(
      "WARNING: FOOTBALL_DATA_TOKEN is not set. Get a free key at https://www.football-data.org/client/register"
    );
  }
});
