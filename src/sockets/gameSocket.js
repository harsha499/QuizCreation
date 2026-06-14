/**
 * gameSocket.js — WebSocket event handler
 *
 * FIX #5 — Round transition out of sync between browsers:
 *   Old code: client detected round boundary locally by checking qIndex % 10.
 *   Because each client ran its own timer, they could drift apart.
 *   Fix: server emits a dedicated 'roundTransition' event when nextQuestion
 *   lands on a boundary. Both browsers receive it simultaneously.
 *
 * FIX #6 — getGameCode was a value not a function:
 *   Old socket.js: `window.getGameCode = code`  (assigns string)
 *   Old game_ui_fragment.js called: `window.getGameCode?.()` (calls it as fn)
 *   Result: always undefined. gameCode was never recovered after page events.
 *   Fix: gameCode lives in game_ui_fragment.js as a plain module-level var;
 *   socket events in this same file set it directly — no window bridge needed.
 */

const {
  createGame, joinGame, startGame,
  handleAnswer, nextQuestion, restartGame, getState,
} = require("../game/quizGameManager");

const generateCode = require("../utils/generateCode");

module.exports = (io) => {
  io.on("connection", (socket) => {
    console.log("[socket] connected:", socket.id);

    // ── Host creates a room ──────────────────────────────────────────────────
    socket.on("createGame", ({ teamA } = {}) => {
      const code = generateCode();
      createGame(code, teamA || "Alpha");
      socket.join(code);
      socket.data.roomCode = code;   // remember for disconnect logging
      const state = getState(code);
      console.log(`[createGame] code=${code} teamA=${teamA}`);
      // Only the host gets 'gameCreated' so it can display the room code
      socket.emit("gameCreated", { code, state });
    });

    // ── Second player joins ──────────────────────────────────────────────────
    socket.on("joinGame", ({ code, teamB } = {}) => {
      if (!code)  return socket.emit("error", "Game code required");
      if (!teamB) return socket.emit("error", "Team name required");

      const joined = joinGame(code, teamB);
      if (!joined)        return socket.emit("error", "Room not found — check your code");
      if (joined === "FULL") return socket.emit("error", "Room is already full (2 teams max)");

      socket.join(code);
      socket.data.roomCode = code;

      // Auto-start as soon as the second player joins
      const started = startGame(code);
      if (!started) return socket.emit("error", "Could not start game");

      const state    = getState(code);
      const roomSize = io.sockets.adapter.rooms.get(code)?.size || 0;
      console.log(`[joinGame] code=${code} teamB=${teamB} players=${roomSize}`);

      // Broadcast full state to BOTH players → they both navigate to quizScreen
      io.to(code).emit("gameState", state);
      io.to(code).emit("playerUpdate", {
        code, connected: roomSize, names: state.names, status: state.status,
      });
    });

    // ── Re-sync on reconnect (e.g. page refresh) ─────────────────────────────
    socket.on("requestState", ({ code } = {}) => {
      const state = getState(code);
      if (!state) return socket.emit("error", "Room not found");
      socket.join(code);
      socket.data.roomCode = code;
      socket.emit("gameState", state);
    });

    // ── Answer submitted ─────────────────────────────────────────────────────
    socket.on("answer", ({ code, chosen } = {}) => {
      if (chosen === undefined) return socket.emit("error", "No answer provided");
      const res = handleAnswer(code, Number(chosen));
      if (!res) return socket.emit("error", "Answer rejected (already answered or game not found)");

      const state = getState(code);
      // Broadcast to BOTH players: result text + updated game state
      io.to(code).emit("answerResult", { result: res.result, state });
    });

    // ── Advance to next question ─────────────────────────────────────────────
    socket.on("nextQuestion", ({ code } = {}) => {
      const game = nextQuestion(code);
      if (!game) return socket.emit("error", "Room not found");

      const state = getState(code);

      if (state.screen === "winnerScreen") {
        // Game over — send both browsers to the winner screen
        io.to(code).emit("gameState", state);
        return;
      }

      // FIX #5: emit dedicated event on round boundary so BOTH browsers show
      // the transition overlay at exactly the same moment
      if (state.isRoundBoundary) {
        io.to(code).emit("roundTransition", { roundMeta: state.roundMeta, state });
      } else {
        io.to(code).emit("gameState", state);
      }
    });

    // ── Restart game ─────────────────────────────────────────────────────────
    socket.on("restartGame", ({ code } = {}) => {
      const game = restartGame(code);
      if (!game) return socket.emit("error", "Room not found");
      io.to(code).emit("gameState", getState(code));
    });

    socket.on("disconnect", () => {
      console.log(`[socket] disconnected: ${socket.id} (room: ${socket.data.roomCode || "none"})`);
    });
  });
};