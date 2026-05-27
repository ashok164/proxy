const express = require("express");
const axios = require("axios");

const router = express.Router();

const MATCH_STATS_API =
  "https://matchstats.sea.ffesports.com/api/match_stats/match_data";
const MATCH_STATS_TIMEOUT_MS =
  parseInt(process.env.MATCH_STATS_TIMEOUT_MS, 10) || 75000;
const MATCH_STATS_RETRIES =
  parseInt(process.env.MATCH_STATS_RETRIES, 10) || 0;

const shouldRetry = (err) =>
  ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(err.code);

const fetchMatchStats = async (payload) => {
  let lastError;

  for (let attempt = 0; attempt <= MATCH_STATS_RETRIES; attempt++) {
    try {
      return await axios.post(MATCH_STATS_API, payload, {
        timeout: MATCH_STATS_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        validateStatus: () => true,
      });
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err) || attempt === MATCH_STATS_RETRIES) break;
    }
  }

  throw lastError;
};

router.post("/match_data", async (req, res) => {
  try {
    const upstreamResponse = await fetchMatchStats(req.body);

    return res.status(upstreamResponse.status).json(upstreamResponse.data);
  } catch (err) {
    console.error("Match stats proxy failed:", err.message);
    const isTimeout = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT";

    return res.status(isTimeout ? 504 : 502).json({
      success: false,
      message: isTimeout
        ? "Match stats upstream request timed out"
        : "Failed to fetch match stats",
      error: err.message,
    });
  }
});

module.exports = router;
