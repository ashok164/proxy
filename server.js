const express = require("express");
const cors = require("cors");
const http = require("http");
const axios = require("axios"); // Added for fetching sheet
require("dotenv").config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHEET_URL = process.env.SHEET_URL;

const store = require("./Data/store");

/* ================= GOOGLE SHEET SYNC (30 SECONDS) ================= */
const parseCSV = (csvText) => {
  const lines = csvText.split("\n");
  if (lines.length === 0) return {};

  // Clean headers: remove carriage returns and spaces
  const headers = lines[0].split(",").map(h => h.trim().replace(/\r/g, ""));
  
  const map = {};

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    
    const row = lines[i].split(",").map(cell => cell.trim().replace(/\r/g, ""));
    const rowData = {};
    
    headers.forEach((header, index) => {
      rowData[header] = row[index] || "";
    });

    // Assume your sheet has a column named 'team_id' or 'id'
    const teamId = rowData.team_id || rowData.id;
    if (teamId) {
      map[String(teamId)] = rowData;
    }
  }
  return map;
};

const updateStoreFromSheet = async () => {
  if (!SHEET_URL) {
    console.error("❌ SHEET_URL is missing in .env");
    return;
  }

  try {
    console.log("🔄 Fetching data from Google Sheet...");
    const response = await axios.get(SHEET_URL);
    const newMap = parseCSV(response.data);
    
    store.teamMap = newMap;
    console.log(`✅ Store updated successfully! Loaded ${Object.keys(newMap).length} teams.`);
  } catch (error) {
    console.error("❌ Error updating store from sheet:", error.message);
  }
};

// Run immediately on boot, then every 30 seconds
updateStoreFromSheet();
setInterval(updateStoreFromSheet, 30 * 1000);


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