const socket = io();

let state = {
  username: localStorage.getItem("wc_username") || null,
  balance: 0,
  matches: [],
  leaderboard: [],
  myBets: [],
  activeTab: "upcoming",
  pendingBet: null, // { matchId, pick, matchLabel, pickLabel }
};

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function login(username) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Login failed");
  state.username = data.username;
  state.balance = data.tokens;
  localStorage.setItem("wc_username", data.username);
  showApp();
  refreshAll();
}

function showApp() {
  $("#authGate").style.display = "none";
  $("#app").style.display = "block";
  $("#userPill").textContent = `@${state.username}`;
  $("#balanceVal").textContent = Math.round(state.balance);
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("#usernameInput").value.trim();
  const msg = $("#loginMsg");
  msg.textContent = "";
  msg.className = "msg";
  try {
    await login(username);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "msg err";
  }
});

$("#logoutBtn").addEventListener("click", () => {
  localStorage.removeItem("wc_username");
  state.username = null;
  $("#app").style.display = "none";
  $("#authGate").style.display = "block";
});

if (state.username) {
  showApp();
}

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------
$("#redeemBtn").addEventListener("click", async () => {
  const code = $("#codeInput").value.trim().toUpperCase();
  const msg = $("#redeemMsg");
  msg.textContent = "";
  msg.className = "msg";
  if (!code) return;
  try {
    const res = await fetch("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: state.username, code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.balance = data.balance;
    $("#balanceVal").textContent = Math.round(state.balance);
    msg.textContent = `+${data.tokens} tokens! New balance: ${Math.round(data.balance)}`;
    msg.className = "msg ok";
    $("#codeInput").value = "";
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "msg err";
  }
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.activeTab = btn.dataset.tab;
    renderTab();
  });
});

async function refreshAll() {
  const [matchesRes, leaderboardRes, myBetsRes] = await Promise.all([
    fetch("/api/matches").then((r) => r.json()),
    fetch("/api/leaderboard").then((r) => r.json()),
    fetch(`/api/mybets/${encodeURIComponent(state.username)}`).then((r) => r.json()),
  ]);
  state.matches = matchesRes.matches;
  state.apiWarning = matchesRes.lastFetchError;
  state.leaderboard = leaderboardRes;
  state.myBets = myBetsRes;
  renderTab();
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function calcOdds(pools, pick) {
  // Rough live "odds" shown to the user based on current pool shares.
  // Not fixed odds -- actual payout is computed at settlement time.
  const total = pools.HOME_TEAM + pools.DRAW + pools.AWAY_TEAM;
  const pickTotal = pools[pick];
  if (total === 0 || pickTotal === 0) return "—";
  const impliedReturn = (total * 0.95) / pickTotal;
  return `${impliedReturn.toFixed(2)}x`;
}

function statusLabel(m) {
  if (m.status === "IN_PLAY") return "LIVE";
  if (m.status === "PAUSED") return "HALFTIME";
  if (m.status === "FINISHED") return "FULL TIME";
  if (m.status === "TIMED" || m.status === "SCHEDULED") return "UPCOMING";
  return m.status;
}

function matchCard(m) {
  const homeCrest = m.homeCrest ? `<img src="${m.homeCrest}" alt="">` : "";
  const awayCrest = m.awayCrest ? `<img src="${m.awayCrest}" alt="">` : "";
  const scoreText =
    m.score.home === null && m.score.away === null ? fmtDate(m.utcDate) : `${m.score.home} - ${m.score.away}`;

  let picksHtml = "";
  if (m.bettingOpen) {
    picksHtml = `
      <div class="pick-row">
        <button class="pick-btn" data-match="${m.id}" data-pick="HOME_TEAM" data-label="${m.homeTeam} to win">
          <span>${m.homeTeam}</span>
          <span class="odds">${calcOdds(m.pools, "HOME_TEAM")}</span>
        </button>
        <button class="pick-btn" data-match="${m.id}" data-pick="DRAW" data-label="Draw">
          <span>Draw</span>
          <span class="odds">${calcOdds(m.pools, "DRAW")}</span>
        </button>
        <button class="pick-btn" data-match="${m.id}" data-pick="AWAY_TEAM" data-label="${m.awayTeam} to win">
          <span>${m.awayTeam}</span>
          <span class="odds">${calcOdds(m.pools, "AWAY_TEAM")}</span>
        </button>
      </div>
      <div class="pool-note">Pool so far: ${Math.round(m.pools.HOME_TEAM)} / ${Math.round(m.pools.DRAW)} / ${Math.round(m.pools.AWAY_TEAM)} tokens · odds shift as more bets come in</div>
    `;
  } else if (m.status === "FINISHED") {
    const winnerLabel =
      m.score.winner === "HOME_TEAM" ? m.homeTeam : m.score.winner === "AWAY_TEAM" ? m.awayTeam : "Draw";
    picksHtml = `<div class="pool-note">Result: ${winnerLabel} · bets settled</div>`;
  } else {
    picksHtml = `<div class="pool-note">Betting closed (kickoff reached)</div>`;
  }

  return `
    <div class="match-card">
      <div class="match-top">
        <span>${m.stage?.replace(/_/g, " ") || ""} ${m.group ? "· " + m.group : ""}</span>
        <span class="status-badge status-${m.status}">${statusLabel(m)}</span>
      </div>
      <div class="teams">
        <div class="team home">${homeCrest} ${m.homeTeam}</div>
        <div class="score">${scoreText}</div>
        <div class="team away">${m.awayTeam} ${awayCrest}</div>
      </div>
      ${picksHtml}
    </div>
  `;
}

function renderTab() {
  const content = $("#tabContent");
  const now = Date.now();

  if (state.activeTab === "upcoming") {
    const list = state.matches.filter((m) => m.bettingOpen);
    content.innerHTML = warningBanner() + (list.length
      ? list.map(matchCard).join("")
      : `<div class="empty">No upcoming matches open for betting right now. Check back soon.</div>`);
  } else if (state.activeTab === "live") {
    const list = state.matches.filter((m) => m.status === "IN_PLAY" || m.status === "PAUSED");
    content.innerHTML = warningBanner() + (list.length
      ? list.map(matchCard).join("")
      : `<div class="empty">No matches live right now.</div>`);
  } else if (state.activeTab === "finished") {
    const list = state.matches.filter((m) => m.status === "FINISHED").reverse();
    content.innerHTML = warningBanner() + (list.length
      ? list.map(matchCard).join("")
      : `<div class="empty">No finished matches yet.</div>`);
  } else if (state.activeTab === "mybets") {
    content.innerHTML = state.myBets.length
      ? state.myBets
          .map(
            (b) => `
        <div class="bet-row">
          <div>
            <div>${b.matchLabel}</div>
            <div style="color:var(--muted);font-size:0.78rem;">${b.pick.replace("_TEAM", "")} · staked ${Math.round(b.stake)}</div>
          </div>
          <div style="text-align:right;">
            <div class="bet-status ${b.status}">${b.status.toUpperCase()}</div>
            ${b.status === "won" ? `<div style="color:var(--green);font-size:0.8rem;">+${Math.round(b.payout)}</div>` : ""}
          </div>
        </div>`
          )
          .join("")
      : `<div class="empty">You haven't placed any bets yet.</div>`;
  } else if (state.activeTab === "leaderboard") {
    content.innerHTML = state.leaderboard.length
      ? state.leaderboard
          .map(
            (u, i) => `
        <div class="leaderboard-row">
          <span><span class="rank">#${i + 1}</span> <span class="${u.username === state.username ? "you" : ""}">${u.username}</span></span>
          <span>🪙 ${u.tokens}</span>
        </div>`
          )
          .join("")
      : `<div class="empty">No players yet.</div>`;
  }

  document.querySelectorAll(".pick-btn").forEach((btn) => {
    btn.addEventListener("click", () => openBetModal(btn.dataset.match, btn.dataset.pick, btn.dataset.label));
  });
}

function warningBanner() {
  if (!state.apiWarning) return "";
  return `<div class="empty" style="color:var(--red);">⚠️ ${state.apiWarning}</div>`;
}

// ---------------------------------------------------------------------------
// Bet modal
// ---------------------------------------------------------------------------
function openBetModal(matchId, pick, label) {
  const match = state.matches.find((m) => m.id === Number(matchId));
  state.pendingBet = { matchId: Number(matchId), pick, matchLabel: `${match.homeTeam} vs ${match.awayTeam}` };
  $("#betModalTitle").textContent = state.pendingBet.matchLabel;
  $("#betModalPick").textContent = `Your pick: ${label}`;
  $("#stakeInput").value = "";
  $("#betMsg").textContent = "";
  $("#betMsg").className = "msg";

  const quick = [50, 100, 250, Math.round(state.balance)].filter((v, i, arr) => v > 0 && arr.indexOf(v) === i);
  $("#quickStakes").innerHTML = quick
    .map((v) => `<button data-v="${v}">${v === Math.round(state.balance) ? "All in" : v}</button>`)
    .join("");
  $("#quickStakes").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => ($("#stakeInput").value = b.dataset.v));
  });

  $("#betOverlay").classList.remove("hidden");
}

$("#cancelBetBtn").addEventListener("click", () => $("#betOverlay").classList.add("hidden"));

$("#confirmBetBtn").addEventListener("click", async () => {
  const stake = Number($("#stakeInput").value);
  const msg = $("#betMsg");
  msg.textContent = "";
  msg.className = "msg";
  if (!state.pendingBet) return;
  try {
    const res = await fetch("/api/bet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: state.username,
        matchId: state.pendingBet.matchId,
        pick: state.pendingBet.pick,
        stake,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.balance = data.balance;
    $("#balanceVal").textContent = Math.round(state.balance);
    $("#betOverlay").classList.add("hidden");
    refreshAll();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "msg err";
  }
});

// ---------------------------------------------------------------------------
// Sockets: live updates for everyone
// ---------------------------------------------------------------------------
socket.on("matches:update", (matches) => {
  state.matches = matches;
  if (["upcoming", "live", "finished"].includes(state.activeTab)) renderTab();
});

socket.on("leaderboard:update", (leaderboard) => {
  state.leaderboard = leaderboard;
  if (state.activeTab === "leaderboard") renderTab();
  if (state.username) {
    const me = leaderboard.find((u) => u.username === state.username);
    if (me) {
      state.balance = me.tokens;
      $("#balanceVal").textContent = Math.round(state.balance);
    }
  }
});

socket.on("bet:placed", () => {
  if (state.username) refreshAll();
});

socket.on("bets:settled", () => {
  if (state.username) refreshAll();
});

// Poll as a fallback in case sockets drop
setInterval(() => {
  if (state.username) refreshAll();
}, 30000);
