const express = require("express");
const cors = require("cors");
const http = require("http");
const axios = require("axios");

/* ================= ENV FIX (LOCAL + PROD) ================= */
const dotenv = require("dotenv");

/* SAFE NODE_ENV (VERY IMPORTANT FOR VPS) */
const NODE_ENV = process.env.NODE_ENV || "development";

// Crucial step: Explicitly attach it to process.env so router files can see it
process.env.NODE_ENV = NODE_ENV; 

const envFile =
  NODE_ENV === "production"
    ? ".env.production"
    : ".env.local";

dotenv.config({ path: envFile });

/* DEBUG (TEMP BUT IMPORTANT) */
console.log("📦 ENV LOADED FILE:", envFile);
console.log("⚙️ RUNNING IN MODE:", process.env.NODE_ENV);
console.log("🔑 DB_PASSWORD EXISTS:", !!process.env.DB_PASSWORD);

/* Safety check */
if (!process.env.DB_PASSWORD) {
  console.error("❌ DB_PASSWORD missing in env file");
  process.exit(1);
}
/* ================= ENV FIX END ================= */

const app = express();
const server = http.createServer(app);

const initDB = require("./Database/initDB");
const pool = require("./Database/db");

const store = require("./Data/store");

/* ================= DB INIT SAFE ================= */
(async () => {
  try {
    await initDB();
    console.log("✅ DB initialized");
  } catch (err) {
    console.error("❌ initDB error:", err.message);
  }
})();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHEET_URL = process.env.SHEET_URL;

/* ================= CSV PARSER ================= */
const parseCSVToArray = (csvText) => {
  const lines = csvText.split("\n");
  if (!lines.length) return [];

  const headers = lines[0]
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));

  const records = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const row = lines[i].split(",").map((c) => c.trim());
    const obj = {};

    headers.forEach((h, idx) => {
      obj[h] = row[idx] || "";
    });

    const currentId = obj.team_id || obj.id;

    if (currentId) {
      records.push({
        team_id: String(currentId),
        team_name: obj.team_name || obj.name || "",
        short_tag: obj.team_tag || obj.short_tag || obj.tag || "",
        team_logo: obj.team_logo || "",
        country_logo: obj.country_logo || "",
        avatar_id: obj.avatar_id || "",
      });
    }
  }

  return records;
};

/* ================= SYNC LOCK ================= */
let isSyncing = false;

/* ================= SYNC SHEET ================= */
const syncSheetToPostgres = async () => {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const res = await axios.get(SHEET_URL);
    const teams = parseCSVToArray(res.data);

    if (!store.teamMap) {
      store.teamMap = {};
    } else {
      for (const key in store.teamMap) {
        delete store.teamMap[key];
      }
    }

    for (const t of teams) {
      store.teamMap[String(t.team_id)] = t;

      await pool.query(
        `INSERT INTO teams (team_id, team_name, short_tag, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (team_id)
         DO UPDATE SET
           team_name = EXCLUDED.team_name,
           short_tag = EXCLUDED.short_tag,
           updated_at = NOW()`,
        [t.team_id, t.team_name, t.short_tag]
      );
    }

    console.log("🔄 Sheet synced:", teams.length);
  } catch (err) {
    console.error("❌ Sync error:", err.message);
  } finally {
    isSyncing = false;
  }
};

/* ================= START SYNC ================= */
setTimeout(syncSheetToPostgres, 5000);
setInterval(syncSheetToPostgres, 30000);

/* ================= ROUTES ================= */
const logoRoutes = require("./Routes/logos");
const realtimeRoutes = require("./Routes/realtime");
const teamRoutes = require("./Routes/teamRecord");

app.use("/", realtimeRoutes);
app.use("/", logoRoutes);
app.use("/api/teams", teamRoutes);

/* ================= EXPLICIT VERSION ENDPOINT ================= */
// Target URL: http://localhost:3000/version
app.get("/version", (req, res) => {
  return res.json({
    success: true,
    service: "Tournament-Realtime-Data-Streamer",
    version: "1.2.0 ws",
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

/* ================= SERVER ================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
});

/* ================= WS UPGRADE SEQUENCE WITH VERSION MANAGEMENT ================= */
server.on("upgrade", (req, socket, head) => {
  try {
    const isWebSocket = req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket';
    
    // If it's a browser page lookup (HTTP GET), hand off control back to standard Express handlers
    if (!isWebSocket) {
      return; 
    }

    /* === OPTIONAL: WS LEVEL CLIENT VERSION GATEWAY === */
    // If you pass "x-client-version" in your handshake config, you can explicitly reject older software
    const clientVersion = req.headers["x-client-version"];
    console.log(`🔌 Incoming WS upgrade handshake connection. Client build version: ${clientVersion || "None Provided"}`);

    const handled = realtimeRoutes?.handleRealtimeWebSocket?.(req, socket);

    if (!handled) {
      console.log("⚠️ WS Upgrade request matched nothing or failed verification. Closing connection.");
      socket.destroy();
    }
  } catch (err) {
    console.error("❌ WS upgrade error:", err.message);
    socket.destroy();
  }
});

/* ================= GLOBAL SAFETY ================= */
process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled Rejection:", err.message);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err.message);
});