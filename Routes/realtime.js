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
        "Client-ID": CLIENT_ID ? CLIENT_ID.trim() : "",
      },
    });

    const data = response.data;

    // FIX: Target data.match.team_stats instead of the root data.team_stats
    if (data?.match?.team_stats && store.teamMap) {
      data.match.team_stats = data.match.team_stats.map((team) => {
        // Find the metadata row by casting the number ID to a string
        const meta = store.teamMap[String(team.team_id)];

        return {
          ...team,
          // Merge your customized data elements from the Google Sheet 
          team_name: meta?.team_name || team.team_name,
          logo_url: meta?.logo_url || "",
          tag: meta?.tag || "",
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