const {
  createGame,
  joinGame,
  startGame,
  handleAnswer,
  nextQuestion,
  restartGame,
  getState
} = require('../game/quizGameManager');

const generateCode = require('../utils/generateCode');

module.exports = (io) => {
  io.on('connection', (socket) => {
    console.log('[socket] connected', socket.id);

    socket.on('createGame', ({ teamA } = {}) => {
      console.log('[socket] event=createGame data=', { teamA });
      const code = generateCode();
      createGame(code, teamA || 'Alpha');
      socket.join(code);
      const state = getState(code);
      socket.emit('gameCreated', { code, state });
    });

    socket.on('joinGame', ({ code, teamB } = {}) => {
      console.log('[socket] event=joinGame data=', { code, teamB });
      if (!teamB) return socket.emit('error', 'Team name required');
      const joined = joinGame(code, teamB);
      if (!joined) return socket.emit('error', 'Game not found');
      if (joined === 'FULL') return socket.emit('error', 'Game already has two teams');

      socket.join(code);
      if (joined.status === 'ready') {
        const started = startGame(code);
        if (!started) return socket.emit('error', 'Unable to start game');
      }

      const state = getState(code);
      io.to(code).emit('gameState', state);
      io.to(code).emit('playerUpdate', { code, connected: io.sockets.adapter.rooms.get(code)?.size || 0, names: state.names, status: state.status });
    });

    socket.on('startGame', ({ code } = {}) => {
      console.log('[socket] event=startGame data=', { code });
      const game = startGame(code);
      if (!game) return socket.emit('error', 'Game not found or waiting for second team');
      io.to(code).emit('gameState', getState(code));
    });

    socket.on('answer', ({ code, chosen } = {}) => {
      console.log('[socket] event=answer data=', { code, chosen });
      const res = handleAnswer(code, chosen);
      if (!res) return socket.emit('error', 'Game not found or invalid state');
      io.to(code).emit('answerResult', { result: res.result, state: getState(code) });
    });

    socket.on('nextQuestion', ({ code } = {}) => {
      console.log('[socket] event=nextQuestion data=', { code });
      const game = nextQuestion(code);
      if (!game) return socket.emit('error', 'Game not found');
      io.to(code).emit('gameState', getState(code));
    });

    socket.on('restartGame', ({ code } = {}) => {
      console.log('[socket] event=restartGame data=', { code });
      const game = restartGame(code);
      if (!game) return socket.emit('error', 'Game not found');
      io.to(code).emit('gameState', getState(code));
    });

    socket.on('requestState', ({ code } = {}) => {
      const state = getState(code);
      if (!state) return socket.emit('error', 'Game not found');
      socket.emit('gameState', state);
    });
  });
};