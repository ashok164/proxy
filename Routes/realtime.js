const express = require("express");
const axios = require("axios");
const router = express.Router();

const store = require("../data/store");

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;

router.get("/realtime/:matchId", async (req, res) => {
  try {
    const matchId = req.params.matchId;

    const response = await axios.get(`${API_URL}/${matchId}`, {
      headers: {
        "Client-ID": CLIENT_ID.trim(),
      },
    });

    const data = response.data;

    if (data?.teams) {
      data.teams = data.teams.map((team) => {
        const meta = store.teamMap[String(team.team_id)];

        return {
          ...team,
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