const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");

/* ================= ENV ================= */
const NODE_ENV = process.env.NODE_ENV || "development";
process.env.NODE_ENV = NODE_ENV;

const envFile = NODE_ENV === "production" ? ".env.production" : ".env.local";

dotenv.config({ path: envFile });

console.log("📦 ENV FILE:", envFile);
console.log("⚙️ MODE:", process.env.NODE_ENV);

if (!process.env.DB_PASSWORD) {
  console.error("❌ DB_PASSWORD missing");
  process.exit(1);
}

/* ================= APP ================= */
const app = express();
const server = http.createServer(app);

/* ================= DB ================= */
const initDB = require("./Database/initDB");

/* ================= INIT DB ================= */
(async () => {
  try {
    await initDB();
    console.log("✅ DB initialized");
  } catch (err) {
    console.error("❌ initDB error:", err.message);
  }
})();

/* ================= MIDDLEWARE ================= */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================================================
   🔥 IMPORTANT FIX: MAKE UPLOADS PUBLIC (VPS SAFE)
========================================================= */
const uploadPath = path.join(__dirname, "uploads");
const publicUploadPath = path.join(__dirname, "public/uploads");

app.use("/uploads", express.static(publicUploadPath));
app.use("/uploads", express.static(uploadPath));

console.log("📁 Uploads exposed at /uploads");

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 3000;

/* ================= ROUTES ================= */
const logoRoutes = require("./Routes/logos");
const realtimeRoutes = require("./Routes/realtime");
const teamRoutes = require("./Routes/teamRecord");
const teamPlayerRoutes = require("./Routes/teamPlayers");
const themeColorRoutes = require("./Routes/themeColors");
const authRoutes = require("./Routes/auth");
const gameAssetRoutes = require("./Routes/gameAssets");

app.use("/", realtimeRoutes);
app.use("/", logoRoutes);
app.use("/", teamPlayerRoutes);
app.use("/", teamPlayerRoutes);
app.use("/api", gameAssetRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/theme", themeColorRoutes);
app.use("/api/auth", authRoutes);

/* ================= VERSION ================= */
app.get("/version", (req, res) => {
  res.json({
    success: true,
    service: "Tournament-Realtime-Data-Streamer",
    version: "2",
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

/* ================= SERVER ================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
});

/* ================= WEBSOCKET ================= */
server.on("upgrade", (req, socket) => {
  try {
    const isWebSocket =
      req.headers.upgrade && req.headers.upgrade.toLowerCase() === "websocket";

    if (!isWebSocket) return;

    const handled = realtimeRoutes?.handleRealtimeWebSocket?.(req, socket);

    if (!handled) socket.destroy();
  } catch (err) {
    console.error("❌ WS error:", err.message);
    socket.destroy();
  }
});

/* ================= ERROR HANDLING ================= */
process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled Rejection:", err.message);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err.message);
});
