const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const router = express.Router();

const store = require("../Data/store");

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;

const getHeaders = () => ({
  "Client-ID": CLIENT_ID,
});

const fetchMatch = async (id) => {
  const res = await axios.get(`${API_URL}/${id}`, {
    headers: getHeaders(),
  });
  return res.data;
};

const getTeams = (data) => data?.match?.team_stats || data?.team_stats || [];

const mergeTeam = (team) => {
  console.log(team,'team')
  const teamIdKey = team.team_id || team.id;
  const meta = store.teamMap?.[String(teamIdKey)];

  const base = process.env.BASE_URL || "";
  
  // Helper function to safely format asset locations
  const formatImgUri = (fieldValue) => {
    if (!fieldValue) return "";
    // If the value in the sheet is already a full URL, return it as-is
    if (fieldValue.startsWith("http://") || fieldValue.startsWith("https://")) {
      return fieldValue;
    }
    // Otherwise, treat it as a local filename and append your backend uploads directory
    return `${base}/uploads/${fieldValue}`;
  };

  return {
    ...team,
    // Merge properties safely, falling back to live match API keys if the sheet column is blank
    team_name: meta?.team_name || team.team_name,
    teamTag: meta?.short_tag || team.teamTag || "",
    teamLogo: formatImgUri(meta?.team_logo) || team.teamLogo || "",
    countryLogo: formatImgUri(meta?.country_logo) || team.countryLogo || "",
    ranking_score: meta?.ranking_score || team.ranking_score || 0,
  };
};

const buildStandings = async (id) => {
  const data = await fetchMatch(id);
  const teams = getTeams(data).map(mergeTeam);

  return {
    matchId: id,
    standings: teams,
  };
};

/* ================= WS FRAME HELPER ================= */
// Helper to package raw text/JSON data into a standard WebSocket Text Frame (Opcode 0x1)
const frameWSFrame = (payload) => {
  const dataBuffer = Buffer.from(payload, "utf8");
  const len = dataBuffer.length;
  let frame;

  if (len <= 125) {
    frame = Buffer.alloc(2 + len);
    frame[1] = len;
  } else if (len <= 65535) {
    frame = Buffer.alloc(4 + len);
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame = Buffer.alloc(10 + len);
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }
  
  frame[0] = 0x81; // 0x80 (FIN bit set) + 0x01 (Text Frame opcode)
  dataBuffer.copy(frame, frame.length - len);
  return frame;
};

/* ================= WS ================= */
const parseWS = (url = "") => {
  // Fix: Changed 'clean' to 'url'
  const match = url.match(/^\/(?:ws\/)?(realtime|tablestandings)\/([^/]+)$/);
  if (!match) return null;

  // Fix: match[1] is the sub-route directory, match[2] captures the actual ID parameter
  return { matchId: match[2] };
};

const handleWS = (req, socket) => {
  const route = parseWS(req.url);
  if (!route) return false;

  const key = req.headers["sec-websocket-key"];
  if (!key) return true;

  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const send = async () => {
    try {
      const data = await buildStandings(route.matchId);
      const jsonString = JSON.stringify({
        type: "tablestandings",
        data,
      });

      // Fix: Send data packaged inside a valid WS data frame wrapper
      socket.write(frameWSFrame(jsonString));
    } catch (err) {
      console.error("Error broadcasting match standings via WS:", err.message);
    }
  };

  // Warning: An interval of 100ms means hitting your upstream API_URL 10 times per second.
  // Ensure your upstream server won't rate limit you, or turn this up to 1000-2000ms.
  const interval = setInterval(send, 100);

  socket.on("close", () => clearInterval(interval));
  socket.on("error", () => clearInterval(interval));

  send();
  return true;
};

router.handleRealtimeWebSocket = handleWS;

module.exports = router;