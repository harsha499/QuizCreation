const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const gameSocket = require('./sockets/gameSocket');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());

gameSocket(io);

server.listen(5000, () => {
  console.log("Server running on 5000");
});