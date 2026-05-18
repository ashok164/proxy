const express = require("express");
const cors = require("cors");
const http = require("http");
const axios = require("axios");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const initDB = require("./Database/initDB");
const pool = require("./Database/db");

const store = require("./Data/store");

initDB();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHEET_URL = process.env.SHEET_URL;

/* ================= SYNC SHEET ================= */
/* ================= SYNC SHEET ================= */
const parseCSVToArray = (csvText) => {
  const lines = csvText.split("\n");
  if (!lines.length) return [];

  // Clean and normalize headers (e.g., "Team Logo" becomes "team_logo")
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

    // Handle flexible variations of the primary ID column key
    const currentId = obj.team_id || obj.id;

    if (currentId) {
      records.push({
        team_id: String(currentId),
        team_name: obj.team_name || obj.name || "",
        short_tag: obj.team_tag || obj.short_tag || obj.tag || "",
        team_logo: obj.team_logo || "", // Extracted from Column E
        country_logo: obj.country_logo || "", // Extracted from Column F
        avatar_id: obj.avatar_id || "", // Extracted from Column G
      });
    }
  }

  return records;
};

const syncSheetToPostgres = async () => {
  try {
    const res = await axios.get(SHEET_URL);
    const teams = parseCSVToArray(res.data);

    // FIX: Do NOT do store.teamMap = {};
    // Instead, safely clear the existing properties without breaking module references
    if (!store.teamMap) {
      store.teamMap = {};
    } else {
      for (const key in store.teamMap) {
        delete store.teamMap[key];
      }
    }

    for (const t of teams) {
      // Direct assignment mutates the referenced object correctly
      store.teamMap[String(t.team_id)] = t;

      await pool.query(
        `INSERT INTO teams (team_id, team_name, short_tag, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (team_id)
         DO UPDATE SET
           team_name = EXCLUDED.team_name,
           short_tag = EXCLUDED.short_tag,
           updated_at = NOW()`,
        [t.team_id, t.team_name, t.short_tag],
      );
    }

    console.log("🔄 Sheet synced:", teams.length);
    console.log(
      "📦 Current store.teamMap contents:",
      JSON.stringify(store.teamMap),
    );
  } catch (err) {
    console.error("❌ Sync error:", err.message);
  }
};

syncSheetToPostgres();
setInterval(syncSheetToPostgres, 30000);

/* ================= ROUTES ================= */
const logoRoutes = require("./Routes/logos");
const realtimeRoutes = require("./Routes/realtime");
const teamRoutes = require("./Routes/teamRecord");

app.use("/", realtimeRoutes);
app.use("/", logoRoutes);
app.use("/api/teams", teamRoutes);

/* ================= SERVER ================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
});

// Inside your app.js (Main File) where server.listen sits:
server.on("upgrade", (req, socket, head) => {
  // Pass the raw upgrade down to your real-time router explicitly
  const handled = realtimeRoutes.handleRealtimeWebSocket(req, socket);
  if (!handled) {
    socket.destroy(); // Destroys bad connections that don't match your sub-routes
  }
});
