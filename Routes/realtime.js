const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const https = require("https");
const os = require("os"); // Added to check local network interface availability
const router = express.Router();

const store = require("../Data/store");

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;

const TARGET_IP = process.env.VPS_IP || "82.29.155.252";

// Helper function to safely check if this machine actually owns the public IP interface
const checkLocalIpAvailability = (targetIp) => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.address === targetIp) return true;
    }
  }
  return false;
};

// Only bind localAddress if the server hardware actually owns that IP (Prevents local crash)
const isIpValidOnMachine = checkLocalIpAvailability(TARGET_IP);
const staticIpAgent = isIpValidOnMachine ? new https.Agent({ localAddress: TARGET_IP }) : null;

const getHeaders = () => ({
  "Client-ID": CLIENT_ID,
});

const fetchMatch = async (id) => {
  const config = {
    headers: getHeaders(),
    timeout: 60000 // Prevent request hanging
  };

  if (staticIpAgent) {
    console.log(`📡 [PROXY ACTIVE] Axios fetching from URL: ${API_URL}/${id} via localAddress: ${TARGET_IP}`);
    config.httpsAgent = staticIpAgent;
  } else {
    console.log(`📡 [STANDARD GATEWAY] OS does not own ${TARGET_IP} or running locally. Route via standard interface.`);
  }
  
  const res = await axios.get(`${API_URL}/${id}`, config);
  return res.data;
};

const getTeams = (data) => data?.match?.team_stats || data?.team_stats || [];

const mergeTeam = (team) => {
  const teamIdKey = team.team_id || team.id;
  
  // Guard clause: Safe fallback if store or teamMap failed to initialize from the Database/Sheet
  const meta = (store && store.teamMap) ? store.teamMap[String(teamIdKey)] : null;

  const base = process.env.BASE_URL || "";
  
  const formatImgUri = (fieldValue) => {
    if (!fieldValue) return "";
    if (fieldValue.startsWith("http://") || fieldValue.startsWith("https://")) {
      return fieldValue;
    }
    return `${base}/uploads/${fieldValue}`;
  };

  return {
    ...team,
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
  
  frame[0] = 0x81; 
  dataBuffer.copy(frame, frame.length - len);
  return frame;
};

/* ================= WS ROUTE PARSER ================= */
const parseWS = (url = "") => {
  if (!url) return null;
  const match = url.match(/\/(?:ws\/)?(realtime|tablestandings)\/([^/?#]+)/);
  if (!match) return null;

  return { 
    type: match[1],
    matchId: match[2].trim() 
  };
};

const handleWS = (req, socket) => {
  const route = parseWS(req.url);
  
  if (!route) {
    console.log(`🚫 Rejecting invalid WS URL structure: ${req.url}`);
    return false;
  }

  if (!route.matchId || route.matchId === "undefined") {
    console.log(`⏳ WebSocket handshake active on /${route.type}/, awaiting valid tournament Match ID...`);
    return true; 
  }

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

  console.log(`🚀 WS Connection Established for Match ID: ${route.matchId}`);

  const send = async () => {
    try {
      const data = await buildStandings(route.matchId);
      const jsonString = JSON.stringify({
        type: "tablestandings",
        data,
      });

      if (socket.writable) {
        socket.write(frameWSFrame(jsonString));
      }
    } catch (err) {
      // Enhanced diagnostic logging to trace exact response text from Garena's API gateway
      if (err.response) {
        console.error(`❌ Garena API Rejected Request [Status ${err.response.status}]:`, JSON.stringify(err.response.data));
      } else {
        console.error(`❌ Error fetching/broadcasting match standings [ID: ${route.matchId}]:`, err.message);
      }
    }
  };

  const intervalDuration = parseInt(process.env.WS_PUSH_INTERVAL_MS, 10) || 1500;
  const interval = setInterval(send, intervalDuration);

  socket.on("close", () => {
    console.log(`🔌 Client disconnected from Match ID: ${route.matchId}`);
    clearInterval(interval);
  });
  
  socket.on("error", () => clearInterval(interval));

  send();
  return true;
};

router.handleRealtimeWebSocket = handleWS;

module.exports = router;