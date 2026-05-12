const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID; // Your key from the screenshot
const PORT = process.env.PORT || 80;

app.get("/", (req, res) => {
  res.send("VPS Proxy is Online and Ready");
});

app.get("/realtime/:matchId", async (req, res) => {
  try {
    const matchId = req.params.matchId;
    const finalUrl = `${API_URL}/${matchId}`;

    console.log(`Forwarding request to: ${finalUrl}`);
    console.log(`Using Client-ID: ${CLIENT_ID}`);

    const response = await axios.get(finalUrl, {
      headers: {
        "Client-ID": CLIENT_ID.trim(),
      },
      timeout: 10000,
    });

    console.log("Success! Data received from API.");
    res.json(response.data);
  } catch (error) {
    console.error("API Error:", error.response?.data || error.message);

    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on http://82.29.155.252:${PORT}`);
});
