const express = require("express");
const cors = require("cors");
const http = require("http");
const axios = require("axios");
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
const pool = require("./Database/db");
const store = require("./Data/store");

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

app.use("/uploads", express.static(uploadPath));

console.log("📁 Uploads exposed at /uploads");

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 3000;
const SHEET_URL = process.env.SHEET_URL;

const normalizeSheetUrl = (url = "") => {
  const clean = String(url || "").trim();
  if (!clean) return "";

  if (
    clean.includes("docs.google.com/spreadsheets") &&
    clean.includes("/pubhtml")
  ) {
    const sheetUrl = new URL(clean);
    sheetUrl.pathname = sheetUrl.pathname.replace(/\/pubhtml$/, "/pub");
    sheetUrl.searchParams.set("output", "csv");
    return sheetUrl.toString();
  }

  return clean;
};

/* ================= CSV PARSER ================= */
const parseCSVToArray = (csvText) => {
  const parseCSVLine = (line) => {
    const values = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const next = line[i + 1];

      if (char === '"' && inQuotes && next === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }

    values.push(current.trim());
    return values;
  };

  const lines = String(csvText || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  if (!lines.length) return [];

  const headers = parseCSVLine(lines[0])
    .map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));

  const records = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const row = parseCSVLine(lines[i]);
    const obj = {};

    headers.forEach((h, idx) => {
      obj[h] = row[idx] || "";
    });

    const currentId = obj.team_id || obj.id;

    if (currentId) {
      // Clean and normalize the text values safely
      const cleanId = String(currentId).trim();

      records.push({
        rank: (obj.rank || obj.slot || obj.position || "").trim(),
        team_id: cleanId,
        team_name: (obj.team_name || obj.name || "").trim(),
        short_tag: (obj.short_tag || obj.team_tag || obj.tag || "").trim(),
        team_logo: (obj.team_logo || "").trim(),
        country_logo: (obj.country_logo || "").trim(),
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
    const sheetUrl = normalizeSheetUrl(SHEET_URL);
    if (!sheetUrl) {
      throw new Error("SHEET_URL missing");
    }

    // 🔥 FIX: Append a unique timestamp query parameter to bypass Google & Axios caches
    const cacheBusterUrl = sheetUrl.includes("?")
      ? `${sheetUrl}&_cb=${Date.now()}`
      : `${sheetUrl}?_cb=${Date.now()}`;

    const res = await axios.get(cacheBusterUrl, {
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Expires: "0",
      },
    });

    const teams = parseCSVToArray(res.data);

    if (!store.teamMap) store.teamMap = {};
    else Object.keys(store.teamMap).forEach((k) => delete store.teamMap[k]);

    for (const t of teams) {
      store.teamMap[String(t.team_id)] = t;
      if (t.rank) {
        store.teamMap[String(t.rank).trim().toLowerCase()] = t;
      }
      if (t.team_name) {
        store.teamMap[String(t.team_name).trim().toLowerCase()] = t;
      }
      if (t.short_tag) {
        store.teamMap[String(t.short_tag).trim().toLowerCase()] = t;
      }

      await pool.query(
        `INSERT INTO teams (rank, team_id, team_name, short_tag, team_logo, country_logo, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (team_id)
         DO UPDATE SET
           rank = EXCLUDED.rank,
           team_name = EXCLUDED.team_name,
           short_tag = EXCLUDED.short_tag,
           team_logo = EXCLUDED.team_logo,
           country_logo = EXCLUDED.country_logo,
           updated_at = NOW()`,
        [
          t.rank,
          t.team_id,
          t.team_name,
          t.short_tag,
          t.team_logo,
          t.country_logo,
        ],
      );
    }

    console.log(
      `🔄 Sheet synced successfully: ${teams.length} teams processed.`,
    );
  } catch (err) {
    console.error("❌ Sync error:", err.message);
  } finally {
    isSyncing = false;
  }
};

/* ================= AUTO SYNC ================= */
setTimeout(syncSheetToPostgres, 5000);
setInterval(syncSheetToPostgres, 30000);

/* ================= ROUTES ================= */
const logoRoutes = require("./Routes/logos");
const realtimeRoutes = require("./Routes/realtime");
const teamRoutes = require("./Routes/teamRecord");

app.use("/", realtimeRoutes);
app.use("/", logoRoutes);
app.use("/api/teams", teamRoutes);

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
