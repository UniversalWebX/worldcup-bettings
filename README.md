# World Cup Token Betting Simulator ⚽

A multiplayer, play-money betting simulator for the 2026 FIFA World Cup.
Users redeem hardcoded codes for tokens, then bet those tokens against each
other (pari-mutuel style) on real match outcomes pulled live from
[football-data.org](https://www.football-data.org).

**No real money is ever involved.** This is a simulator/demo.

---

## How it works

- **Login**: username only, no password. It's a play-money leaderboard, not a real account system.
- **Redeem codes**: 20 codes are hardcoded in `server.js` (`REDEEM_CODES`), each redeemable **once, by anyone** — first come, first served. Values range 200–2500 tokens.
- **Betting**: for each upcoming match, you bet tokens on Home / Draw / Away. Betting closes automatically at kickoff.
- **Pari-mutuel payouts**: there are no fixed odds. All tokens bet on a match go into three pools (home/draw/away). When the match finishes:
  - Losers forfeit their stake into the losing pool.
  - The losing pool (minus a 5% house edge, see `HOUSE_EDGE` in `server.js`) is split among winners proportional to their stake.
  - Winners also get their original stake back.
  - This means odds shown in the UI are *live estimates* that move as more people bet — exactly like real pari-mutuel/tote betting.
- **Multiplayer / realtime**: Socket.IO broadcasts new matches, live pool sizes, and leaderboard changes to every connected browser instantly.
- **Data source**: `server.js` polls `GET /v4/competitions/WC/matches` on football-data.org every 60 seconds (well under their 10 req/min free-tier limit) and caches results in memory.

## Project structure

```
worldcup-betting-sim/
├── server.js          # Express + Socket.IO backend, all game logic
├── package.json
├── render.yaml         # One-click Render blueprint
├── .env.example
├── data/db.json         # created automatically — simple JSON "database"
└── public/
    ├── index.html       # UI shell
    └── app.js           # frontend logic (fetch + socket.io client)
```

## Running locally

```bash
npm install
cp .env.example .env
# edit .env and paste in your free football-data.org API token
npm start
# open http://localhost:3000
```

Get a free token at https://www.football-data.org/client/register (takes ~30 seconds,
no credit card). The free tier includes the World Cup competition and allows
10 requests/minute, which this app respects (it polls once per minute).

If you don't set a token, the app still runs — the UI will show a banner
explaining that matches can't load until a token is added.

## Deploying to Render

### Option A — one-click Blueprint
1. Push this folder to a GitHub repo.
2. In the Render dashboard: **New > Blueprint**, point it at your repo (it will pick up `render.yaml` automatically).
3. When prompted, paste your `FOOTBALL_DATA_TOKEN` into the environment variable field.
4. Deploy. Render will run `npm install` then `npm start`.

### Option B — manual Web Service
1. **New > Web Service**, connect your repo.
2. Build command: `npm install`
3. Start command: `npm start`
4. Add an environment variable: `FOOTBALL_DATA_TOKEN = <your key>`
5. (Recommended) Add a persistent disk mounted at `/opt/render/project/src/data` so the JSON "database" survives restarts — see the note below.

### About data persistence
This demo stores users/bets/codes in a flat JSON file (`data/db.json`) for
simplicity. On Render's **free** plan the filesystem is ephemeral and gets
wiped on every redeploy (but persists across simple restarts). That's fine
for a demo or short tournament run. For anything long-lived:
- Attach a [Render Disk](https://render.com/docs/disks) (included in `render.yaml`), or
- Swap the `loadDB`/`saveDB` functions in `server.js` for a real database
  (Render Postgres, Redis, SQLite on a disk, etc.) — the rest of the app
  doesn't care how `db` is persisted.

## Regenerating redeem codes

The codes are just a hardcoded object at the top of `server.js`. To make a
fresh batch:

```js
const crypto = require("crypto");
function block(n) {
  return crypto.randomBytes(n).toString("base64").replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 4);
}
console.log(`WC26-${block(4)}-${block(4)}`);
```

Run it a few times, pick token values per code, and paste the results into
`REDEEM_CODES`.

## Customization ideas
- Add real user accounts (email/password or OAuth) instead of username-only.
- Add per-user code limits (e.g. one redemption per person) instead of global single-use.
- Support other competitions (change `COMPETITION_CODE` — e.g. `CL` for Champions League) if you want to run it year-round.
- Add push notifications / email when a bet the user placed settles.
- Move `data/db.json` to Postgres and deploy with Render's managed database for durability.

## Tech stack
- **Backend**: Node.js, Express, Socket.IO
- **Frontend**: vanilla HTML/CSS/JS (no build step)
- **Data**: football-data.org REST API (World Cup competition, free tier)
- **Hosting**: designed for Render (Web Service + optional Disk)
