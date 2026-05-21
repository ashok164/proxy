const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const https = require("https");
const os = require("os");
const router = express.Router();

const store = require("../Data/store");

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;
const TARGET_IP = process.env.VPS_IP || "82.29.155.252";
const SOCKS_PROXY = process.env.SOCKS_PROXY; // e.g. socks5://localhost:1080 (SSH tunnel for local dev)

// ⚡ Global In-Memory RAM Cache to guarantee 0ms instant browser delivery
const matchCache = {};

const checkLocalIpAvailability = (targetIp) => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.address === targetIp) return true;
    }
  }
  return false;
};

const isIpValidOnMachine = checkLocalIpAvailability(TARGET_IP);
const staticIpAgent = isIpValidOnMachine ? new https.Agent({ localAddress: TARGET_IP }) : null;

// Priority: SOCKS tunnel (local dev) → static IP bind (production VPS) → default
const getOutboundAgent = () => {
  if (SOCKS_PROXY) {
    try {
      const { SocksProxyAgent } = require("socks-proxy-agent");
      return new SocksProxyAgent(SOCKS_PROXY);
    } catch (e) {
      console.warn("⚠️ socks-proxy-agent not available, falling back:", e.message);
    }
  }
  if (staticIpAgent) return staticIpAgent;
  return null;
};

const getHeaders = () => ({
  "Client-ID": CLIENT_ID,
});

const fetchMatch = async (id) => {
  const config = {
    headers: getHeaders(),
    timeout: 5000 // Reduced from 60s to 5s to prevent hanging threads from breaking the server
  };

  const agent = getOutboundAgent();
  if (agent) config.httpsAgent = agent;
  
  const res = await axios.get(`${API_URL}/${id}`, config);
  return res.data;
};

const getTeams = (data) => data?.match?.team_stats || data?.team_stats || [];

const mergeTeam = (team) => {
  const teamIdKey = team.team_id || team.id;
  const meta = (store && store.teamMap) ? store.teamMap[String(teamIdKey)] : null;
  const base = process.env.BASE_URL || "";
  
  const formatImgUri = (fieldValue) => {
    if (!fieldValue) return "";
    if (fieldValue.startsWith("http://") || fieldValue.startsWith("https://")) return fieldValue;
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

/* ================= CENTRAL DATA STREAM ENGINE ================= */
const startCentralEngine = (matchId) => {
  if (!matchCache[matchId]) {
    matchCache[matchId] = {
      clients: new Set(),
      rawJsonData: null,
      latestFrame: null,
      intervalId: null,
      lastActive: Date.now()
    };
  }

  // If the background update loop is already active, do nothing
  if (matchCache[matchId].intervalId) return;

  console.log(`🌀 [ENGINE START] Initializing centralized data worker loop for Match ID: ${matchId}`);

  const tick = async () => {
    const entry = matchCache[matchId];
    
    // Auto-cleanup worker loop if no connections are listening for over 30 seconds
    if (entry.clients.size === 0 && Date.now() - entry.lastActive > 30000) {
      console.log(`💤 [ENGINE SLEEP] Suspending central worker loop for inactive Match ID: ${matchId}`);
      clearInterval(entry.intervalId);
      entry.intervalId = null;
      return;
    }

    try {
      const standings = await buildStandings(matchId);
      entry.rawJsonData = standings;
      
      const jsonString = JSON.stringify({
        type: "tablestandings",
        data: standings
      });
      entry.latestFrame = frameWSFrame(jsonString);

      // Broadcast to all active clients connected to this match instantly from memory
      for (const socket of entry.clients) {
        if (socket.writable) {
          socket.write(entry.latestFrame);
        }
      }
    } catch (err) {
      console.error(`❌ Central Worker Loop Error [Match ID: ${matchId}]:`, err.message);
    }
  };

  // 100ms triggers external API rate-blocking. 1000ms - 1500ms provides clean real-time metrics.
  const intervalDuration = Math.max(1000, parseInt(process.env.WS_PUSH_INTERVAL_MS, 10) || 1500);
  matchCache[matchId].intervalId = setInterval(tick, intervalDuration);
  
  // Fire once immediately to prime the cache
  tick();
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

const parseWS = (url = "") => {
  if (!url) return null;
  const match = url.match(/\/(?:ws\/)?(realtime|tablestandings)\/([^/?#]+)/);
  if (!match) return null;
  return { type: match[1], matchId: match[2].trim() };
};

const handleWS = (req, socket) => {
  const route = parseWS(req.url);
  if (!route || !route.matchId || route.matchId === "undefined") return false;

  const key = req.headers["sec-websocket-key"];
  if (!key) return false; 

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

  const matchId = route.matchId;
  console.log(`🚀 Client joined WebSocket pool for Match ID: ${matchId}`);

  startCentralEngine(matchId);
  
  const entry = matchCache[matchId];
  entry.clients.add(socket);
  entry.lastActive = Date.now();

  // Instantly send the cached state from RAM memory so client UI populates with 0ms delay!
  if (entry.latestFrame && socket.writable) {
    socket.write(entry.latestFrame);
  }

  const cleanUp = () => {
    console.log(`🔌 Client disconnected from Match ID: ${matchId}`);
    if (matchCache[matchId]) {
      matchCache[matchId].clients.delete(socket);
    }
  };

  socket.on("close", cleanUp);
  socket.on("error", cleanUp);

  return true;
};

/* ================= HIGH SPEED BROWSER HTTP ENDPOINTS ================= */

router.get(["/ws/realtime/:matchId", "/realtime/:matchId"], async (req, res) => {
  try {
    const matchId = req.params.matchId;
    
    // ⚡ SERVE FROM SERVER RAM INSTANTLY WITH ZERO DELAY IF VALID CACHE EXISTS!
    if (matchCache[matchId]) {
      matchCache[matchId].lastActive = Date.now();
      if (matchCache[matchId].rawJsonData) {
        return res.json({
          success: true,
          type: "tablestandings_cached",
          data: matchCache[matchId].rawJsonData
        });
      }
    }

    // Cache miss (First time system has ever requested this specific match token)
    console.log(`🌐 Cache miss. Instantiating live polling engine for Match: ${matchId}`);
    startCentralEngine(matchId);
    
    // Pull synchronously just this once to prevent empty response
    const standingsData = await buildStandings(matchId);
    return res.json({
      success: true,
      type: "tablestandings_static",
      data: standingsData
    });

  } catch (err) {
    console.error("❌ Browser HTTP GET Endpoint Error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.handleRealtimeWebSocket = handleWS;
module.exports = router;