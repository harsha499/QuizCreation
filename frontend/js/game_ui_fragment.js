/**
 * game_ui_fragment.js — Frontend game UI controller
 *
 * All 4 bugs fixed in this file. Exact changes vs uploaded version marked ◄ FIX N
 *
 * BUG 1 — Questions skipping (only 5/10 per round)
 *   Was: no client-side issue after backend fix, but submitAnswer() had no guard
 *   so double-clicks could fire two 'answer' events, causing the server to reject
 *   the second one and the UI to freeze (buttons already disabled, but Next never shows).
 *   Fix: submitAnswer() sets a local `submitting` flag so only one emit fires.
 *   Backend guard `if (game.answered) return null` handles the rest.
 *
 * BUG 2 — Wrong team can still click after answering wrong (steal phase)
 *   Was: answerResult steal branch re-enabled ALL buttons unconditionally.
 *   Fix: after re-enabling, immediately call lockButtonsForWrongTeam() which
 *   disables them again for the browser whose myTeam ≠ currentTeam.
 *
 * BUG 3 — Both teams can answer simultaneously
 *   Was: no myTeam variable; every browser could click any button at any time.
 *   Fix: myTeam is set when hosting (= 0) or joining (= 1).
 *   renderQFromServer() calls lockButtonsForWrongTeam() after building buttons.
 *   submitAnswer() has a client-side guard: if myTeam !== currentTeam, no emit.
 *   Server also enforces this via socket.data.teamIndex (already in gameSocket.js).
 *
 * BUG 4 — First-chance order not preserved across questions
 *   Was: no client-side issue — this was purely a backend bug.
 *   Backend fix (nextQuestion sets currentTeam = lastWinner) is already in the
 *   uploaded quizGameManager.js. The client just renders state.currentTeam correctly.
 *   No change needed here beyond making sure syncStateVars reads currentTeam (it does).
 */

// ─── Display-only constants ───────────────────────────────────────────────────
const ROUND_PTS = { 1:[1,0.5], 2:[2,1], 3:[3,1], 4:[4,2], 5:[5,2] };
const ROUND_META = {
  1:{ label:"ROUND 1", diff:"INTERMEDIATE", bgColor:"#7c3aed", sub:"10 questions · AI & AWS fundamentals at depth" },
  2:{ label:"ROUND 2", diff:"EASY-HARD",    bgColor:"#2563eb", sub:"10 questions · Deeper concepts & services" },
  3:{ label:"ROUND 3", diff:"HARD",         bgColor:"#0891b2", sub:"10 questions · Architecture & ML internals" },
  4:{ label:"ROUND 4", diff:"VERY HARD",    bgColor:"#d97706", sub:"10 questions · Advanced AI & cloud patterns" },
  5:{ label:"ROUND 5", diff:"EXPERT",       bgColor:"#dc2626", sub:"10 questions · Expert-level mastery" },
};
const TOTAL = 50;

// ─── Module-level state ───────────────────────────────────────────────────────
let names, scores, correct, wrong, roundScores, history;
let qIndex = 0, currentTeam = 0, answered = false, stealUsed = false;
let gameCode    = "";
let rtTimer     = null;
let submitting  = false;  // ◄ FIX 1: prevents double-emit on rapid clicks

// ◄ FIX 3: which team index THIS browser is (0 = Team A, 1 = Team B, -1 = not set)
// Set to 0 when hosting, 1 when joining. Never changes within a game session.
let myTeam = -1;

// ─── Utilities ────────────────────────────────────────────────────────────────
const fmt = n => Number.isInteger(n) ? String(n) : n.toFixed(1);
const $id = id => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $id(id).classList.add("active");
}

function setStatus(text) {
  const el = $id("socketStatus");
  if (el) el.textContent = text || "";
}

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io();

socket.on("connect", () => console.log("[socket] connected:", socket.id));

socket.on("gameCreated", ({ code, state }) => {
  gameCode = code;
  myTeam   = 0;  // ◄ FIX 3: host is always Team A
  setStatus(`✅ Room created! Share this code with Team B:  ${code}`);
  // Stay on setup screen — waiting for the second player
});

socket.on("gameState", (state) => {
  submitting = false; // ◄ FIX 1: reset submit lock on every new state
  if (gameCode) setStatus(`Room ${gameCode} · ${state.status}`);
  applyAndRender(state);
});

socket.on("answerResult", ({ result, state }) => {
  if (!result || !state) return;

  submitting = false; // ◄ FIX 1: reset submit lock after result arrives

  syncStateVars(state);
  refreshScoreUI();

  if      (result.status === "correct") showNotif("correct", result.message);
  else if (result.status === "steal")   showNotif("pass",    result.message);
  else if (result.status === "miss")    showNotif("nomatch", result.message);

  if (state.question) {
    const btns = $id("options").querySelectorAll(".opt-btn");

    if (result.status === "steal") {
      // ◄ FIX 2: re-enable all buttons for the steal phase, THEN immediately
      // lock them for the browser that is NOT the active team.
      btns.forEach(b => {
        b.disabled = false;
        b.classList.remove("wrong", "correct", "reveal");
      });
      lockButtonsForWrongTeam(state.currentTeam); // ◄ FIX 2

    } else {
      // Correct or miss — lock all, reveal correct answer, show Next button
      btns.forEach(b => b.disabled = true);
      if (btns[state.question.ans]) btns[state.question.ans].classList.add("reveal");
      $id("btnNext").classList.add("show");
    }
  }
});

socket.on("roundTransition", ({ roundMeta, state }) => {
  if (!roundMeta) return;
  showRoundTransition(roundMeta, () => applyAndRender(state));
});

socket.on("playerUpdate", ({ code, connected, status }) => {
  const waiting = status === "waiting" || status === "ready";
  setStatus(
    `Room ${code} · ${connected}/2 player(s) connected` +
    (waiting ? " · waiting for Team B…" : " · game started!")
  );
});

// ◄ FIX 3: server tells this browser it tried to answer out of turn
socket.on("notYourTurn", (msg) => {
  submitting = false;
  showNotif("pass", "⏳ " + (msg || "Wait for your turn!"));
  setTimeout(hideNotif, 2000);
});

socket.on("error", (msg) => {
  submitting = false;
  alert("⚠️  " + msg);
});

// ─── State ────────────────────────────────────────────────────────────────────
function syncStateVars(state) {
  names       = state.names;
  scores      = state.scores;
  correct     = state.correct;
  wrong       = state.wrong;
  roundScores = state.roundScores;
  history     = state.history;
  qIndex      = state.qIndex;
  currentTeam = state.currentTeam;
  answered    = !!state.answered;
  stealUsed   = !!state.stealUsed;
}

function applyAndRender(state) {
  if (!state) return;
  syncStateVars(state);

  if (state.screen === "winnerScreen") {
    showScreen("winnerScreen");
    renderWinner();
  } else if (state.screen === "quizScreen" && state.question) {
    showScreen("quizScreen");
    renderQFromServer(state);
  }
}

// ─── Question rendering ───────────────────────────────────────────────────────
function renderQFromServer(state) {
  const q = state.question;
  if (!q) return;

  const r          = q.r;
  const rm         = ROUND_META[r];
  const [pos, neg] = ROUND_PTS[r];
  const n          = String(qIndex + 1).padStart(2, "0");

  $id("roundChip").textContent    = `${rm.label} · ${rm.diff}`;
  $id("progRoundLbl").textContent = rm.label;
  $id("progFill").style.width     = Math.round((qIndex / TOTAL) * 100) + "%";
  $id("progPct").textContent      = Math.round((qIndex / TOTAL) * 100) + "%";
  $id("qCounter").textContent     = `${n} / ${TOTAL}`;
  $id("qNum").textContent         = `Q_${n}`;
  $id("qPtsHint").textContent     = `+${pos} / −${neg}`;

  refreshScoreUI();

  const tagCls = q.diff === "expert" ? "expert" : q.diff === "hard" ? "hard" : "intermediate";
  $id("qTags").innerHTML =
    `<span class="tag tag-${tagCls}">${rm.diff}</span>` +
    `<span class="tag tag-cat">${q.cat}</span>` +
    `<span class="tag-pts tag">+${pos} / −${neg}</span>`;
  $id("qText").textContent = q.q;

  const LETTERS = ["A","B","C","D"];
  const grid    = $id("options");
  grid.innerHTML = "";

  q.opts.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.className = "opt-btn";
    btn.innerHTML = `<span class="opt-letter">${LETTERS[i]}</span><span>${opt}</span>`;
    btn.onclick   = () => submitAnswer(i);
    // Reconnect recovery: question already resolved
    if (answered) {
      btn.disabled = true;
      if (q.ans !== undefined && i === q.ans) btn.classList.add("reveal");
    }
    grid.appendChild(btn);
  });

  hideNotif();
  submitting = false; // ◄ FIX 1: reset lock when a new question renders

  if (answered) {
    $id("btnNext").classList.add("show");
    $id("btnNext").disabled = false; // BUG 1 fix: re-enable for this question's eventual click
  } else {
    $id("btnNext").classList.remove("show");
    $id("btnNext").disabled = false; // reset in case it was left disabled from previous question
    // ◄ FIX 3: lock buttons for the team that shouldn't answer yet
    lockButtonsForWrongTeam(state.currentTeam);
  }
}

/**
 * lockButtonsForWrongTeam(activeTeam)
 *
 * ◄ FIX 2 & 3 — the core enforcement function.
 *
 * If myTeam is known (-1 means not yet in a game) and this browser's team
 * is NOT the activeTeam, disable all answer buttons so they cannot click.
 *
 * Called from:
 *   • renderQFromServer()  — fresh question render
 *   • answerResult steal   — after re-enabling for steal phase
 *
 * @param {number} activeTeam  0 or 1 — the team currently allowed to answer
 */
function lockButtonsForWrongTeam(activeTeam) {
  if (myTeam === -1) return; // not in a game yet, leave buttons as-is
  const btns = $id("options").querySelectorAll(".opt-btn");
  if (myTeam !== activeTeam) {
    // This browser is the WRONG team right now — disable all buttons
    btns.forEach(b => b.disabled = true);
  }
  // If myTeam === activeTeam, buttons stay enabled (already enabled by render or re-enable)
}

// ─── Answer submission ────────────────────────────────────────────────────────
function submitAnswer(chosen) {
  // ◄ FIX 1: prevent double-emit on rapid clicks
  if (submitting) return;

  // ◄ FIX 3: client-side guard — belt and braces (server also enforces via socketTeams)
  if (myTeam !== -1 && myTeam !== currentTeam) {
    showNotif("pass", "⏳ Wait for your turn!");
    setTimeout(hideNotif, 2000);
    return;
  }

  submitting = true; // lock until answerResult arrives
  $id("options").querySelectorAll(".opt-btn").forEach(b => b.disabled = true);
  socket.emit("answer", { code: gameCode, chosen });
}

// ─── Score UI ─────────────────────────────────────────────────────────────────
function refreshScoreUI() {
  $id("dispNameA").textContent  = names[0];
  $id("dispNameB").textContent  = names[1];
  $id("dispScoreA").textContent = fmt(scores[0]);
  $id("dispScoreB").textContent = fmt(scores[1]);
  $id("lscNameA").textContent   = names[0];
  $id("lscNameB").textContent   = names[1];
  $id("lscTotA").textContent    = fmt(scores[0]);
  $id("lscTotB").textContent    = fmt(scores[1]);
  updateTurnUI();
  updateScorecard();
}

function updateTurnUI() {
  $id("teamCardA").className = "score-team st-a" + (currentTeam === 0 ? " active-a" : "");
  $id("teamCardB").className = "score-team st-b" + (currentTeam === 1 ? " active-b" : "");
  $id("turnA").textContent   = currentTeam === 0 ? "▶ ANSWERING" : "";
  $id("turnB").textContent   = currentTeam === 1 ? "▶ ANSWERING" : "";
}

function updateScorecard() {
  ["A","B"].forEach((t, i) => {
    const el = $id("lscHist" + t);
    if (!el) return;
    el.innerHTML = "";
    (history[i] || []).slice(-20).forEach(h => {
      const d = document.createElement("div");
      d.className   = "lsc-dot " + h.t;
      d.textContent = h.v;
      d.title       = h.l;
      el.appendChild(d);
    });
  });
}

function flashDelta(team, val) {
  const el = $id(team === 0 ? "deltaA" : "deltaB");
  el.textContent = (val > 0 ? "+" : "") + fmt(val);
  el.className   = "score-delta " + (val > 0 ? "plus" : "minus") + " show";
  setTimeout(() => { el.className = "score-delta " + (val > 0 ? "plus" : "minus"); }, 2000);
}

function showNotif(type, msg) {
  const n = $id("notif");
  n.className   = `notif ${type} show`;
  n.textContent = msg;
}
function hideNotif() { $id("notif").className = "notif"; }

// ─── Round transition overlay ─────────────────────────────────────────────────
function showRoundTransition(rm, cb) {
  if (rtTimer) { clearInterval(rtTimer); rtTimer = null; }

  const roundNum   = parseInt(rm.label.replace("ROUND ", ""), 10);
  const [pos, neg] = ROUND_PTS[roundNum] || [1, 0.5];

  $id("rtBadge").textContent      = rm.label;
  $id("rtBadge").style.background = rm.bgColor;
  $id("rtTitle").textContent      = rm.diff;
  $id("rtTitle").style.color      = rm.bgColor;
  $id("rtSub").textContent        = rm.sub;
  $id("rtPos").textContent        = `+${pos} pts`;
  $id("rtNeg").textContent        = `−${neg} pt${neg !== 1 ? "s" : ""}`;

  const dotsEl = $id("rtDots");
  dotsEl.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const d = document.createElement("div");
    d.className = "rt-dot" + (i < roundNum ? " done" : i === roundNum ? " active" : "");
    dotsEl.appendChild(d);
  }

  const circumference = 2 * Math.PI * 30;
  const ringFill      = $id("rtRingFill");
  const numEl         = $id("rtNum");
  ringFill.style.stroke           = rm.bgColor;
  ringFill.style.strokeDasharray  = circumference;
  ringFill.style.strokeDashoffset = 0;

  const SECS    = 5;
  let remaining = SECS;
  numEl.textContent = remaining;
  $id("rtOverlay").classList.add("show");

  rtTimer = setInterval(() => {
    remaining--;
    numEl.textContent = remaining;
    ringFill.style.strokeDashoffset = circumference * ((SECS - remaining) / SECS);
    if (remaining <= 0) {
      clearInterval(rtTimer); rtTimer = null;
      $id("rtOverlay").classList.remove("show");
      setTimeout(cb, 350);
    }
  }, 1000);
}

// ─── Winner screen ────────────────────────────────────────────────────────────
function renderWinner() {
  $id("progFill").style.width  = "100%";
  $id("progPct").textContent   = "100%";
  $id("winNameA").textContent  = names[0];
  $id("winNameB").textContent  = names[1];
  $id("winScoreA").textContent = fmt(scores[0]);
  $id("winScoreB").textContent = fmt(scores[1]);
  $id("winBreakA").innerHTML   = `<span class="pos">✓ ${correct[0]} correct</span><br><span class="neg">✗ ${wrong[0]} wrong</span>`;
  $id("winBreakB").innerHTML   = `<span class="pos">✓ ${correct[1]} correct</span><br><span class="neg">✗ ${wrong[1]} wrong</span>`;

  const ring  = $id("winRing");
  const title = $id("winTitle");
  const sub   = $id("winSub");
  const fA    = $id("finalA");
  const fB    = $id("finalB");
  fA.classList.remove("is-winner");
  fB.classList.remove("is-winner");

  if (scores[0] > scores[1]) {
    ring.className    = "winner-ring team-a-ring"; ring.textContent = "🏆";
    title.textContent = `${names[0]} Wins!`;        title.className  = "winner-title ta";
    sub.textContent   = "TEAM A · CONQUERED ALL 5 ROUNDS";
    fA.classList.add("is-winner");
    spawnConfetti("a");
  } else if (scores[1] > scores[0]) {
    ring.className    = "winner-ring team-b-ring"; ring.textContent = "🏆";
    title.textContent = `${names[1]} Wins!`;        title.className  = "winner-title tb";
    sub.textContent   = "TEAM B · CONQUERED ALL 5 ROUNDS";
    fB.classList.add("is-winner");
    spawnConfetti("b");
  } else {
    ring.className    = "winner-ring tie-ring"; ring.textContent = "🤝";
    title.textContent = "It's a Tie!";          title.className  = "winner-title tt";
    sub.textContent   = "PERFECTLY MATCHED · REMATCH?";
    spawnConfetti("tie");
  }

  const rlabels = ["Intermediate","Easy-Hard","Hard","Very Hard","Expert"];
  const rbGrid  = $id("rbGrid");
  rbGrid.innerHTML = "";
  roundScores.forEach((rs, i) => {
    const d = document.createElement("div");
    d.className = "rb-card";
    d.innerHTML =
      `<div class="rb-r">R${i+1}<br><span style="font-size:8px">${rlabels[i].substring(0,6)}</span></div>` +
      `<div class="rb-s"><span class="rb-sa">${fmt(rs[0])}</span> ` +
      `<span style="color:var(--muted)">v</span> ` +
      `<span class="rb-sb">${fmt(rs[1])}</span></div>`;
    rbGrid.appendChild(d);
  });

  $id("statsChips").innerHTML =
    `<span class="stat-chip">50 questions</span>` +
    `<span class="stat-chip">5 rounds</span>` +
    `<span class="stat-chip">Margin: ${fmt(Math.abs(scores[0] - scores[1]))} pts</span>`;
}

function spawnConfetti(w) {
  const bg   = $id("winBg");
  bg.innerHTML = "";
  const cols = w === "a" ? ["#7c6fff","#a89fff","#c4b5fd","#fff","#e8e4ff"]
             : w === "b" ? ["#00b87a","#34d399","#a7f3d0","#fff","#d1fae5"]
             :             ["#7c6fff","#00b87a","#fbbf24","#f87171","#fff"];
  for (let i = 0; i < 100; i++) {
    const p  = document.createElement("div");
    const sz = 5 + Math.random() * 9;
    p.className    = "confetti-p";
    p.style.cssText =
      `left:${Math.random()*100}%;width:${sz}px;height:${sz*(Math.random()>.5?1:2.5)}px;` +
      `background:${cols[i%cols.length]};border-radius:${Math.random()>.5?"50%":"2px"};` +
      `animation-duration:${2.5+Math.random()*2.5}s;animation-delay:${Math.random()*2}s`;
    bg.appendChild(p);
  }
}

// ─── Button actions ───────────────────────────────────────────────────────────
function hostRoom() {
  const teamA = ($id("nameA")?.value.trim()) || "Alpha";
  myTeam = 0;  // ◄ FIX 3: host = Team A
  setStatus("Creating room…");
  socket.emit("createGame", { teamA });
}

function joinRoom() {
  const code  = ($id("gameCodeInput")?.value.trim() || "").toUpperCase();
  const teamB = ($id("nameA")?.value.trim()) || "Beta";
  if (!code) return setStatus("⚠️  Enter a game code first");
  gameCode = code;
  myTeam   = 1;  // ◄ FIX 3: joiner = Team B
  setStatus(`Joining room ${code}…`);
  socket.emit("joinGame", { code, teamB });
}

function nextQ() {
  // BUG 1 FIX (frontend half): disable the button the instant it's clicked.
  // The server now rejects duplicate nextQuestion calls (see quizGameManager.js),
  // but disabling here too avoids a flash of a second click going out at all,
  // and avoids users wondering why their second click did nothing.
  const btn = $id("btnNext");
  if (btn) btn.disabled = true;
  socket.emit("nextQuestion", { code: gameCode });
}

function restartGame() {
  if (rtTimer) { clearInterval(rtTimer); rtTimer = null; }
  submitting = false;
  $id("winBg").innerHTML = "";
  $id("rtOverlay").classList.remove("show");
  socket.emit("restartGame", { code: gameCode });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const btnHost = $id("btnHostSocket");
  const btnJoin = $id("btnJoinSocket");
  const btnNext = $id("btnNext");

  if (btnHost) btnHost.addEventListener("click", hostRoom);
  if (btnJoin) btnJoin.addEventListener("click", joinRoom);
  if (btnNext) btnNext.addEventListener("click", nextQ);

  // restartGame is exposed because the winner screen still uses an inline
  // onclick="restartGame()" attribute (single binding, no duplicate — safe).
  // nextQ is NOT exposed on window anymore: it is bound exactly once via
  // addEventListener above. Exposing it globally was harmless but unnecessary
  // now that the matching inline onclick="nextQ()" has been removed from
  // index.html — removing the export here too avoids any future temptation
  // to re-add an inline onclick that would reintroduce the double-fire bug.
  window.restartGame = restartGame;
});