const express = require("express");
const cors = require("cors");
const axios = require("axios");
const csv = require("csv-parser");
require("dotenv").config();

const store = require("./data/store");

const app = express();

app.use(cors());
app.use(express.json());

/* ===================== ENV ===================== */
const SHEET_URL = process.env.SHEET_URL;
const PORT = process.env.PORT || 80;

/* ===================== ROUTES ===================== */
const teamRoutes = require("./routes/teams");
const logoRoutes = require("./routes/logos");
const realtimeRoutes = require("./routes/realtime");

app.use("/", realtimeRoutes);
app.use("/", logoRoutes);
app.use("/", teamRoutes);

/* ===================== SHEET LOADER ===================== */
async function loadSheet() {
  try {
    const response = await axios.get(SHEET_URL, {
      responseType: "stream",
    });

    const results = [];

    response.data
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("error", (streamErr) => {
        console.log("CSV parsing stream error:", streamErr.message);
        scheduleNextLoad();
      })
      .on("end", () => {
        const map = {};

        results.forEach((team) => {
          if (!team.team_id) return;
          map[String(team.team_id)] = {
            team_name: team.team_name,
            logo_url: team.logo_url,
            tag: team.tag,
            country: team.country_logo,
          };
        });

        store.teamMap = map;

        console.log(
          "Sheet loaded successfully. Size:",
          Object.keys(store.teamMap).length,
        );
        scheduleNextLoad();
      });
  } catch (err) {
    console.log("Sheet HTTP error:", err.message);
    scheduleNextLoad();
  }
}

function scheduleNextLoad() {
  setTimeout(loadSheet, 30000); // Triggers next loop 30 seconds after execution finishes
}

// Kickstart initial execution loop
loadSheet();

/* ===================== ROOT ===================== */
app.get("/", (req, res) => {
  res.send("🚀 Esports Backend Running");
});

app.get("/version", (req, res) => {
  res.json({ version: "v2", time: new Date() });
});

/* ===================== START ===================== */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
