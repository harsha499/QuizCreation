const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const cors     = require("cors");
const path     = require("path");

const gameSocket = require("./sockets/gameSocket");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(cors());
// Serve game.html + js/ + css/ from the frontend folder
 app.use(express.static(path.join(__dirname, "../frontend")));

gameSocket(io);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅  Server → http://localhost:${PORT}`));