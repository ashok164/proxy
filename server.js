const express = require("express");
const cors = require("cors");
const http = require("http");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ================= ROUTES ================= */
const teamRoutes = require("./Routes/teams");
const logoRoutes = require("./Routes/logos");
const realtimeRoutes = require("./Routes/realtime");

app.use("/", realtimeRoutes);
app.use("/", logoRoutes);
app.use("/", teamRoutes);

/* ================= ROOT ================= */
app.get("/", (req, res) => {
  res.send("🚀 Esports Backend Running");
});

app.get("/version", (req, res) => {
  res.json({ version: "v3 ws", time: new Date() });
});

/* ================= SINGLE WS UPGRADE HANDLER ================= */
server.on("upgrade", (req, socket) => {
  console.log("🔥 WS UPGRADE:", req.url);

  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const handled = realtimeRoutes.handleRealtimeWebSocket(req, socket);

  if (!handled) {
    console.log("❌ NOT HANDLED:", req.url);
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});