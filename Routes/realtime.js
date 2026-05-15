const express = require("express");
const axios = require("axios");
const router = express.Router();

const store = require("../data/store");

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;

router.get("/realtime/:matchId", async (req, res) => {
  try {
    const { matchId } = req.params;

    const response = await axios.get(`${API_URL}/${matchId}`, {
      headers: {
        "Client-ID": CLIENT_ID.trim(),
      },
    });

    const data = response.data;

    // FIX: Look up and map 'team_stats' array instead of 'teams'
    if (data?.team_stats && store.teamMap) {
      data.team_stats = data.team_stats.map((team) => {
        // Find the metadata by casting the number ID to a string
        const meta = store.teamMap[String(team.team_id)];

        return {
          ...team,
          // Enrich response with local configurations from your Google Sheet
          team_name: meta?.team_name || team.team_name,
          logo_url: meta?.logo_url || "",
          tag: meta?.tag || "",          // This will now successfully show the team tag!
          country: meta?.country || "",
        };
      });
    }

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;