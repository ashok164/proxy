const express = require("express");
const axios = require("axios");
const router = express.Router();

const store = require("../Data/store");

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;

const getClientHeaders = () => ({
  "Client-ID": CLIENT_ID ? CLIENT_ID.trim() : "",
});

const fetchRealtimeMatch = async (matchId) => {
  if (!API_URL) {
    const err = new Error("API_URL is not configured");
    err.statusCode = 500;
    throw err;
  }

  const response = await axios.get(`${API_URL}/${matchId}`, {
    headers: getClientHeaders(),
  });

  return response.data;
};

const getRealtimeTeams = (data) => {
  if (Array.isArray(data?.match?.team_stats)) return data.match.team_stats;
  if (Array.isArray(data?.team_stats)) return data.team_stats;
  if (Array.isArray(data?.standings)) return data.standings;
  if (Array.isArray(data?.teams)) return data.teams;

  return [];
};

const getSheetTeam = (teamId) => store.teamMap?.[String(teamId)] || null;

const mergeLegacySheetFields = (team) => {
  const meta = getSheetTeam(team.team_id);

  return {
    ...team,
    team_name: meta?.team_name || team.team_name,
    logo_url: meta?.logo_url || "",
    tag: meta?.tag || "",
    country: meta?.country || "",
  };
};

const mergeStandingsSheetFields = (team) => {
  const meta = getSheetTeam(team.team_id);

  return {
    ...team,
    teamTag: meta?.teamTag || meta?.tag || "",
    teamLogo: meta?.teamLogo || meta?.logo_url || "",
    countryLogo: meta?.countryLogo || meta?.country || "",
  };
};

router.get("/realtime/:matchId", async (req, res) => {
  try {
    const { matchId } = req.params;

    const data = await fetchRealtimeMatch(matchId);

    // FIX: Target data.match.team_stats instead of the root data.team_stats
    if (data?.match?.team_stats && store.teamMap) {
      data.match.team_stats = data.match.team_stats.map(mergeLegacySheetFields);
    }

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/tablestandings/:matchId", async (req, res) => {
  try {
    const { matchId } = req.params;
    const data = await fetchRealtimeMatch(matchId);
    const standings = getRealtimeTeams(data).map(mergeStandingsSheetFields);

    res.json({
      matchId,
      standings,
    });
  } catch (err) {
    const status = err.statusCode || err.response?.status || 500;
    res.status(status).json({
      error: "Failed to fetch table standings",
      message: err.message,
    });
  }
});

module.exports = router;
