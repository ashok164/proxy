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
      .on("end", () => {
        const map = {};

        results.forEach((team) => {
          map[String(team.team_id)] = {
            team_name: team.team_name,
            logo_url: team.logo_url,
            tag: team.tag,
            country: team.country_logo,
          };
        });

        store.teamMap = map;

        console.log("Sheet loaded:", Object.keys(store.teamMap).length);
      });

  } catch (err) {
    console.log("Sheet error:", err.message);
  }
}

/* auto refresh */
setInterval(loadSheet, 30000);
loadSheet();

/* ===================== ROOT ===================== */

app.get("/", (req, res) => {
  res.send("🚀 Esports Backend Running");
});

/* ===================== START ===================== */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});