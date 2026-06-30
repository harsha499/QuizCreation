/**
 * gameSocket.js — WebSocket event handler
 *
 * What changed vs the uploaded version
 * ──────────────────────────────────────
 * The uploaded gameSocket.js already correctly:
 *   • calls assignSocketTeam() on createGame and joinGame  (BUG 3 backend fix)
 *   • passes callerTeam to handleAnswer()                   (BUG 3 backend fix)
 *   • emits roundTransition on round boundary               (round sync fix)
 *
 * The ONE thing missing was the "not_your_turn" branch:
 *   handleAnswer() returns { result: { status:"not_your_turn" } } when the
 *   wrong team's browser submits an answer, but the uploaded gameSocket.js
 *   had `if (!res) return socket.emit("error", ...)` — it only handled null.
 *   A not_your_turn result is NOT null, so it fell through to the broadcast
 *   and sent a confusing answerResult to both browsers.
 *
 *   Fix: check res.result.status === "not_your_turn" and emit "notYourTurn"
 *   only to the caller's socket (not the whole room).
 */

const {
  createGame, joinGame, startGame,
  assignSocketTeam,
  handleAnswer, nextQuestion, endGame, quitGame, getState,
  setTurnEndsAt, getTurnSeconds, handleTimeout,
} = require("../game/quizGameManager");

const generateCode = require("../utils/generateCode");

module.exports = (io) => {
  // TIMER: code -> Node setTimeout handle. Owns every setTimeout for the
  // 15s per-turn answer clock — one entry per active room at most.
  const roomTimers = new Map();

  function _clearRoomTimer(code) {
    const handle = roomTimers.get(code);
    if (handle) {
      clearTimeout(handle);
      roomTimers.delete(code);
    }
  }

  /**
   * _startTurnTimer — (re)starts the 15s clock for whichever team currently
   * has the turn in `code`'s room. Always clears any existing timer first
   * so two clocks can never race for the same room.
   *
   * IMPORTANT: setTurnEndsAt() is called here, synchronously, BEFORE this
   * function returns — callers must call getState() AFTER calling this, not
   * before, or the broadcast snapshot will show a stale/null deadline.
   */
  function _startTurnTimer(code) {
    _clearRoomTimer(code);

    const seconds = getTurnSeconds();
    setTurnEndsAt(code, Date.now() + seconds * 1000);

    const handle = setTimeout(() => _onTurnTimeout(code), seconds * 1000);
    roomTimers.set(code, handle);
  }

  /**
   * _onTurnTimeout — fires when a team's 15s clock runs out with no answer.
   * Mirrors the 'answer' handler's broadcast shape (same "answerResult"
   * event) so the frontend doesn't need to know whether a result came from
   * a click or a timeout — it just renders `result` either way.
   */
  function _onTurnTimeout(code) {
    roomTimers.delete(code); // this timer has fired; nothing left to clear

    const res = handleTimeout(code);
    if (!res) return; // room gone, round over, or an answer slipped in just before this fired

    // Timeout opened a steal phase — start the stealer's fresh clock BEFORE
    // pulling getState(), so the one broadcast below already carries the
    // new deadline instead of a stale expired one.
    if (res.result.status === "steal") {
      _startTurnTimer(code);
    }

    const state = getState(code);
    if (!state) return;
    io.to(code).emit("answerResult", { result: res.result, state });
  }


  io.on("connection", (socket) => {
    console.log("[socket] connected:", socket.id);

    // ── Host creates a room ───────────────────────────────────────────────────
    socket.on("createGame", ({ teamA } = {}) => {
      const code = generateCode();
      createGame(code, teamA || "Alpha");

      socket.join(code);
      socket.data.roomCode  = code;
      socket.data.teamIndex = 0;           // host = Team A

      assignSocketTeam(code, socket.id, 0);

      const state = getState(code);
      console.log(`[createGame] code=${code} teamA=${teamA}`);
      socket.emit("gameCreated", { code, state });
    });

    // ── Challenger joins ──────────────────────────────────────────────────────
    socket.on("joinGame", ({ code, teamB } = {}) => {
      if (!code)  return socket.emit("error", "Game code required");
      if (!teamB) return socket.emit("error", "Team name required");

      const joined = joinGame(code, teamB);
      if (!joined)           return socket.emit("error", "Room not found — check your code");
      if (joined === "FULL") return socket.emit("error", "Room is already full (2 teams max)");

      socket.join(code);
      socket.data.roomCode  = code;
      socket.data.teamIndex = 1;           // joiner = Team B

      assignSocketTeam(code, socket.id, 1);

      const started = startGame(code);
      if (!started) return socket.emit("error", "Could not start game");

      // TIMER: kick off Team A's first 15s clock — must happen BEFORE
      // getState() below so the very first broadcast already shows the
      // live countdown.
      _startTurnTimer(code);

      const state    = getState(code);
      const roomSize = io.sockets.adapter.rooms.get(code)?.size || 0;
      console.log(`[joinGame] code=${code} teamB=${teamB} players=${roomSize}`);

      io.to(code).emit("gameState", state);
      io.to(code).emit("playerUpdate", {
        code,
        connected: roomSize,
        names:     state.names,
        status:    state.status,
      });
    });

    // ── Re-sync after page refresh ────────────────────────────────────────────
    socket.on("requestState", ({ code, teamIndex } = {}) => {
      if (!code) return;
      const state = getState(code);
      if (!state) return socket.emit("error", "Room not found");

      socket.join(code);
      socket.data.roomCode = code;

      // Re-register team if the client sends its remembered index
      if (teamIndex !== undefined && teamIndex !== null) {
        socket.data.teamIndex = teamIndex;
        assignSocketTeam(code, socket.id, teamIndex);
      }

      socket.emit("gameState", state);
    });

    // ── Answer submitted ──────────────────────────────────────────────────────
    socket.on("answer", ({ code, chosen } = {}) => {
      if (chosen === undefined) return socket.emit("error", "No answer provided");

      const callerTeam = socket.data.teamIndex;
      if (callerTeam === undefined) {
        return socket.emit("error", "Team not assigned — please rejoin the room");
      }

      const res = handleAnswer(code, Number(chosen), callerTeam);

      // null = question already fully resolved
      if (!res) return socket.emit("error", "Answer rejected — question already resolved");

      // ◄ KEY FIX: handle not_your_turn without broadcasting to the whole room
      if (res.result.status === "not_your_turn") {
        return socket.emit("notYourTurn", res.result.message);
      }

      // TIMER: this turn's clock is spent — quizGameManager already nulled
      // turnEndsAt internally; clear the real setTimeout backing it too.
      _clearRoomTimer(code);

      // Wrong answer just opened a steal chance — give the stealer a fresh
      // 15s clock, started BEFORE getState() so the broadcast below already
      // reflects it.
      if (res.result.status === "steal") {
        _startTurnTimer(code);
      }

      // Valid result — broadcast to both browsers in the room
      const state = getState(code);
      io.to(code).emit("answerResult", { result: res.result, state });
    });

    // ── Advance to next question ──────────────────────────────────────────────
    socket.on("nextQuestion", ({ code } = {}) => {
      if (!code) return;

      const game = nextQuestion(code);

      // null now means one of two things:
      //   1. Room doesn't exist — genuine error
      //   2. Duplicate click: the OTHER browser already advanced this question
      //      (game.answered was already false when this call arrived).
      // We distinguish them by checking if the room still exists at all.
      if (!game) {
        const stillExists = getState(code);
        if (!stillExists) return socket.emit("error", "Room not found");
        // Room exists but nextQuestion was rejected — this was a duplicate
        // "Next Question" click from the other browser. Ignore it silently;
        // that browser will receive the correct state from the FIRST click's
        // broadcast instead. This is the BUG 1 fix in action.
        return;
      }

      // TIMER: clear any leftover handle defensively — the previous
      // question's timer should already be gone (cleared in the 'answer'
      // handler), but never let a stray timeout from an old question fire
      // into the new one.
      _clearRoomTimer(code);

      const state = getState(code);

      if (state.screen === "winnerScreen") {
        return io.to(code).emit("gameState", state);
      }

      if (state.isRoundBoundary) {
        io.to(code).emit("roundTransition", { roundMeta: state.roundMeta, state });
        // TIMER: don't start the new question's clock yet — the client is
        // about to show a 5s round-transition overlay (+350ms fade). Starting
        // now would burn through think-time while teams are still staring at
        // the round-complete screen. Delay matches that overlay exactly, so
        // teams get the FULL 15s once the question is actually visible.
        setTimeout(() => {
          _startTurnTimer(code);
          const freshState = getState(code);
          if (freshState) io.to(code).emit("gameState", freshState);
        }, 5350);
      } else {
        _startTurnTimer(code);
        io.to(code).emit("gameState", getState(code)); // re-fetch: now carries the fresh turnEndsAt
      }
    });

    // ── ENHANCEMENT: either team ends the game early ────────────────────────
    socket.on("quitGame", ({ code } = {}) => {
      if (!code) return;

      const callerTeam = socket.data.teamIndex;
      if (callerTeam === undefined) {
        return socket.emit("error", "Team not assigned — cannot quit");
      }

      const game = quitGame(code, callerTeam);
      if (!game) return socket.emit("error", "Room not found");

      _clearRoomTimer(code); // TIMER: match is over — stop the 15s clock for this room

      console.log(`[quitGame] code=${code} byTeam=${callerTeam}`);
      // Broadcast to BOTH browsers — whichever team clicks it, both flip
      // to the winner/summary screen together.
      io.to(code).emit("gameState", getState(code));
    });

    // ── ENHANCEMENT: "Play Again" — full reset, not an instant rematch ───────
    socket.on("restartGame", ({ code } = {}) => {
      if (!code) return;

      _clearRoomTimer(code); // match is over either way — stop the 15s clock

      const removed = endGame(code);
      if (!removed) {
        // Room already gone — e.g. the OTHER browser's "Play Again" click
        // got here first. Still tell THIS socket to go back to setup so it
        // doesn't get stuck waiting on a room that no longer exists.
        return socket.emit("sessionEnded");
      }

      // Broadcast to BOTH browsers while they're still joined to the room —
      // whichever team clicked it, both go back to the create/join screen
      // together, the same way "quitGame" sends both to the winner screen
      // together.
      io.to(code).emit("sessionEnded");

      // Clean up room membership now that the broadcast has gone out, so no
      // socket lingers attached to a code that no longer maps to any game
      // (avoids a stale membership ever intercepting a future broadcast if
      // generateCode() happens to reissue the same code later).
      const room = io.sockets.adapter.rooms.get(code);
      if (room) {
        for (const sid of [...room]) {
          const s = io.sockets.sockets.get(sid);
          if (!s) continue;
          s.leave(code);
          s.data.roomCode  = undefined;
          s.data.teamIndex = undefined;
        }
      }
    });

    socket.on("disconnect", () => {
      console.log(
        `[socket] disconnected: ${socket.id} ` +
        `(room: ${socket.data.roomCode || "none"}, team: ${socket.data.teamIndex ?? "?"})`
      );
    });
  });
};