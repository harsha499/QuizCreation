const socket = io('http://localhost:5000');

let gameCode = '';
let socketGame = false;

function createGame() {
  console.log('Creating game...');
  const teamA = document.getElementById('nameA')?.value.trim() || 'Alpha';
  socket.emit('createGame', { teamA });
}

function joinExistingGame() {
  const code = document.getElementById('gameCodeInput')?.value.trim();
  const teamB = document.getElementById('nameA')?.value.trim() || 'Beta';
  if (!code) return alert('Enter a game code to join');
  socket.emit('joinGame', { code, teamB });
}

function requestState() {
  if (!gameCode) return;
  socket.emit('requestState', { code: gameCode });
}

socket.on('connect', () => {
  console.log('[socket] connected', socket.id);
});

socket.on('gameCreated', ({ code, state }) => {
  gameCode = code;
  socketGame = true;
  const el = document.getElementById('socketStatus');
  if (el) el.innerText = `Game created. Code: ${code}. Waiting for challenger...`;
  document.dispatchEvent(new CustomEvent('socket:gameState', { detail: state }));
});

socket.on('gameState', (state) => {
  socketGame = true;
  document.dispatchEvent(new CustomEvent('socket:gameState', { detail: state }));
});

socket.on('playerUpdate', (info) => {
  const el = document.getElementById('socketStatus');
  if (el) el.innerText = `Room ${info.code} connected: ${info.connected}` + (info.status === 'waiting' ? ' — waiting for second team' : '');
});

socket.on('answerResult', ({ result, state }) => {
  document.dispatchEvent(new CustomEvent('socket:answerResult', { detail: { result, state } }));
});

socket.on('error', (msg) => {
  alert(msg);
});

function emitStartGame() {
  if (!gameCode) return;
  socket.emit('startGame', { code: gameCode });
}

function emitAnswer(chosen) {
  if (!gameCode) return;
  socket.emit('answer', { code: gameCode, chosen });
}

function emitNextQuestion() {
  if (!gameCode) return;
  socket.emit('nextQuestion', { code: gameCode });
}

function emitRestartGame() {
  if (!gameCode) return;
  socket.emit('restartGame', { code: gameCode });
}

window.createGame = createGame;
window.joinExistingGame = joinExistingGame;
window.emitStartGame = emitStartGame;
window.emitAnswer = emitAnswer;
window.emitNextQuestion = emitNextQuestion;
window.emitRestartGame = emitRestartGame;
window.isSocketGame = () => socketGame;
window.getGameCode = () => gameCode;
