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
  handleAnswer, nextQuestion, restartGame, getState,
} = require("../game/quizGameManager");

const generateCode = require("../utils/generateCode");

module.exports = (io) => {
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

      // Valid result — broadcast to both browsers in the room
      const state = getState(code);
      io.to(code).emit("answerResult", { result: res.result, state });
    });

    // ── Advance to next question ──────────────────────────────────────────────
    socket.on("nextQuestion", ({ code } = {}) => {
      const game = nextQuestion(code);
      if (!game) return socket.emit("error", "Room not found");

      const state = getState(code);

      if (state.screen === "winnerScreen") {
        return io.to(code).emit("gameState", state);
      }

      if (state.isRoundBoundary) {
        io.to(code).emit("roundTransition", { roundMeta: state.roundMeta, state });
      } else {
        io.to(code).emit("gameState", state);
      }
    });

    // ── Restart ───────────────────────────────────────────────────────────────
    socket.on("restartGame", ({ code } = {}) => {
      const game = restartGame(code);
      if (!game) return socket.emit("error", "Room not found");
      io.to(code).emit("gameState", getState(code));
    });

    socket.on("disconnect", () => {
      console.log(
        `[socket] disconnected: ${socket.id} ` +
        `(room: ${socket.data.roomCode || "none"}, team: ${socket.data.teamIndex ?? "?"})`
      );
    });
  });
};