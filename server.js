const express = require("express");
const cors = require("cors");
const axios = require("axios");
const csv = require("csv-parser");
require("dotenv").config();

const store = require("./Data/store");

const app = express();

app.use(cors());
app.use(express.json());

/* ===================== ENV ===================== */
const SHEET_URL = process.env.SHEET_URL;
const PORT = process.env.PORT || 80;

const getSheetValue = (row, keys) => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return "";
};

/* ===================== ROUTES ===================== */
const teamRoutes = require("./Routes/teams");
const logoRoutes = require("./Routes/logos");
const realtimeRoutes = require("./Routes/realtime");

app.use("/", realtimeRoutes);
app.use("/", logoRoutes);
app.use("/", teamRoutes);

/* ===================== SHEET LOADER ===================== */
async function loadSheet() {
  if (!SHEET_URL) {
    console.log("SHEET_URL is not configured. Sheet data was not loaded.");
    return;
  }

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
          const teamId = getSheetValue(team, ["team_id", "Team Id", "Team ID"]);
          const teamName = getSheetValue(team, ["team_name", "Team Name"]);
          const teamTag = getSheetValue(team, ["teamTag", "tag", "Team Tag"]);
          const teamLogo = getSheetValue(team, ["teamLogo", "logo_url", "Team Logo"]);
          const countryLogo = getSheetValue(team, [
            "countryLogo",
            "country_logo",
            "Country Logo",
          ]);

          if (!teamId) return;

          map[String(teamId)] = {
            team_name: teamName,
            logo_url: teamLogo,
            tag: teamTag,
            country: countryLogo,
            teamTag,
            teamLogo,
            countryLogo,
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
