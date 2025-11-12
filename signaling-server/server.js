const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  socket.on("join", ({ session }) => {
    if (!session) return;
    socket.join(session);
    socket.data.session = session;
    console.log(`${socket.id} joined ${session}`);
    socket.to(session).emit("peer-joined", { peerId: socket.id });
    const clients = io.sockets.adapter.rooms.get(session) || new Set();
    io.in(session).emit("room-info", { count: clients.size });
  });

  socket.on("host-ready", ({ session }) => {
    console.log("host-ready for", session, "from", socket.id);
  });

  socket.on("offer", ({ to, sdp }) => { if (to) io.to(to).emit("offer", { from: socket.id, sdp }); });
  socket.on("answer", ({ to, sdp }) => { if (to) io.to(to).emit("answer", { from: socket.id, sdp }); });
  socket.on("ice-candidate", ({ to, candidate }) => { if (to) io.to(to).emit("ice-candidate", { from: socket.id, candidate }); });

  socket.on("leave", ({ session }) => {
    socket.leave(session);
    socket.to(session).emit("peer-left", { peerId: socket.id });
    const clients = io.sockets.adapter.rooms.get(session) || new Set();
    io.in(session).emit("room-info", { count: clients.size });
  });

  socket.on("disconnect", () => {
    const session = socket.data.session;
    if (session) {
      socket.to(session).emit("peer-left", { peerId: socket.id });
      const clients = io.sockets.adapter.rooms.get(session) || new Set();
      io.in(session).emit("room-info", { count: clients.size });
    }
    console.log("socket disconnected", socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log("Signaling server running on port", PORT));
