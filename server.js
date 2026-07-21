const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
const { Server } = require("socket.io");

/* ================= ENV ================= */
const NODE_ENV = process.env.NODE_ENV || "development";
process.env.NODE_ENV = NODE_ENV;

const envFile = NODE_ENV === "production" ? ".env.production" : ".env.local";
const envPath = path.join(__dirname, envFile);

dotenv.config({ path: envPath, override: true });

console.log("📦 ENV FILE:", envFile);
console.log("⚙️ MODE:", process.env.NODE_ENV);

if (!process.env.DB_PASSWORD) {
  console.error("❌ DB_PASSWORD missing");
  process.exit(1);
}

/* ================= APP ================= */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
  },
});
const spectatorNamespace = io.of("/spectator-camera");
app.set("spectatorNamespace", spectatorNamespace);
const spectatorCameraWatchers = new Map();

/* ================= DB ================= */
const initDB = require("./Database/initDB");

/* ================= INIT DB ================= */
(async () => {
  try {
    await initDB();
    console.log("✅ DB initialized");
  } catch (err) {
    console.error("❌ initDB error:", err.message);
    throw err;
  }
})();

/* ================= MIDDLEWARE ================= */
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* =========================================================
   🔥 IMPORTANT FIX: MAKE UPLOADS PUBLIC (VPS SAFE)
========================================================= */
const uploadPath = path.join(__dirname, "uploads");
const publicUploadPath = path.join(__dirname, "public/uploads");
const staticImageOptions = {
  etag: true,
  lastModified: true,
  maxAge: "30d",
  immutable: true,
  setHeaders: (res, filePath) => {
    if (/\.(?:png|jpe?g|webp|gif|svg|ico)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
      res.setHeader("Timing-Allow-Origin", "*");
    }
  },
};

app.use("/uploads", express.static(publicUploadPath, staticImageOptions));
app.use("/uploads", express.static(uploadPath, staticImageOptions));
app.use(express.static(path.join(__dirname, "public"), staticImageOptions));

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
const gameDetailRoutes = require("./Routes/gameDetails");
const circleAnalysisRoutes = require("./Routes/circleAnalysis");
const zoneShrinkRoutes = require("./Routes/zoneShrink");
const matchStatsRoutes = require("./Routes/matchStats");
const matchResultRoutes = require("./Routes/matchResults");
const googleSheetsRoutes = require("./Routes/googleSheets");
const spectatorRoutes = require("./Routes/spectator");

spectatorNamespace.on("connection", (socket) => {
  const watcherKeys = new Set();

  const stopWatcher = (watcherKey) => {
    const watcher = spectatorCameraWatchers.get(watcherKey);
    if (!watcher) return;

    watcher.sockets.delete(socket.id);
    if (watcher.sockets.size === 0) {
      clearInterval(watcher.timerId);
      spectatorCameraWatchers.delete(watcherKey);
    }
  };

  socket.on("spectator:join", ({ spectId, tournamentId }) => {
    const normalizedSpectId = String(spectId || "").trim();
    const normalizedTournamentId = String(tournamentId || "").trim();

    if (!normalizedSpectId || !normalizedTournamentId) {
      socket.emit("spectator:error", {
        message: "spectId and tournamentId are required",
      });
      return;
    }

    const roomName = spectatorRoutes.toRoomName(normalizedTournamentId, normalizedSpectId);
    socket.join(roomName);
    socket.emit("spectator:joined", {
      spectId: normalizedSpectId,
      tournamentId: normalizedTournamentId,
      room: roomName,
    });
  });

  socket.on("camera:join", ({ matchId, tournamentId }) => {
    const normalizedMatchId = String(matchId || "").trim();
    const normalizedTournamentId = String(tournamentId || "").trim();

    if (!normalizedMatchId || !normalizedTournamentId) {
      socket.emit("camera:error", {
        message: "matchId and tournamentId are required",
      });
      return;
    }

    const roomName = spectatorRoutes.toCameraRoomName(
      normalizedTournamentId,
      normalizedMatchId,
    );
    const watcherKey = roomName;
    watcherKeys.add(watcherKey);
    socket.join(roomName);

    const startWatcher = () => {
      const existing = spectatorCameraWatchers.get(watcherKey);
      if (existing) {
        existing.sockets.add(socket.id);
        return existing;
      }

      const watcher = {
        sockets: new Set([socket.id]),
        timerId: null,
      };

      const tick = async () => {
        try {
          const payload = await spectatorRoutes.buildSpectatorFeedForMatch(
            normalizedTournamentId,
            normalizedMatchId,
          );
          spectatorNamespace.to(roomName).emit("camera_update", payload);
        } catch (error) {
          spectatorNamespace.to(roomName).emit("camera_error", {
            matchId: normalizedMatchId,
            message: error?.message || "Camera watcher error",
          });
          if (error?.statusCode !== 404) {
            console.error(`Camera watcher error for match ${normalizedMatchId}:`, error.message);
          }
        }
      };

      watcher.timerId = setInterval(tick, 3000);
      spectatorCameraWatchers.set(watcherKey, watcher);
      tick().catch((error) => {
        if (error?.statusCode !== 404) {
          console.error("Initial camera watcher tick failed:", error.message);
        }
      });

      return watcher;
    };

    startWatcher();
    socket.emit("camera:joined", {
      matchId: normalizedMatchId,
      tournamentId: normalizedTournamentId,
      room: roomName,
    });
  });

  socket.on("disconnect", () => {
    watcherKeys.forEach((watcherKey) => stopWatcher(watcherKey));
  });
});

app.use("/", realtimeRoutes);
app.use("/", logoRoutes);
app.use("/", teamPlayerRoutes);
app.use("/", teamPlayerRoutes);
app.use("/:tournamentSlug/api/teams", teamRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/theme", themeColorRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/game-details", gameDetailRoutes);
app.use("/api/circle-analysis", circleAnalysisRoutes);
app.use("/api/zone-shrink", zoneShrinkRoutes);
app.use("/api/match_stats", matchStatsRoutes);
app.use("/api/results", matchResultRoutes);
app.use("/api/results", googleSheetsRoutes);
app.use("/api", spectatorRoutes.router);
app.use("/:tournamentSlug/api", gameAssetRoutes);
app.use("/api", gameAssetRoutes);

/* ================= VERSION ================= */
app.get("/version", (req, res) => {
  res.json({
    success: true,
    service: "Tournament-Realtime-Data-Streamer",
    version: "Version: New Change Optimizes | V2.01",
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

/* ================= SERVER ================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
});

/* ================= WEBSOCKET ================= */
server.on("upgrade", async (req, socket) => {
  try {
    const isWebSocket =
      req.headers.upgrade && req.headers.upgrade.toLowerCase() === "websocket";

    if (!isWebSocket) return;
    if (String(req.url || "").startsWith("/socket.io/")) return;

    const handled = await realtimeRoutes?.handleRealtimeWebSocket?.(req, socket);

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
