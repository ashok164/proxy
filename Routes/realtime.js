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
const staticIpAgent = isIpValidOnMachine
  ? new https.Agent({ localAddress: TARGET_IP })
  : null;

const getHeaders = () => ({
  "Client-ID": CLIENT_ID,
});

const fetchMatch = async (id) => {
  const config = {
    headers: getHeaders(),
    timeout: 5000,
  };

  if (staticIpAgent) {
    config.httpsAgent = staticIpAgent;
  }

  const res = await axios.get(`${API_URL}/${id}`, config);
  return res.data;
};

const getTeams = (data) =>
  data?.match?.team_stats || data?.team_stats || data?.teams || [];

const normalizeLookupKey = (value) => String(value || "").trim().toLowerCase();

const mergeTeam = (team) => {
  if (!team) return {};

  /* ================= NORMALIZE TEAM ID ================= */
  const rawId =
    team.team_id || team.id || team.teamId || team.team_uid || team.teamCode;

  const teamIdKey = rawId ? String(rawId).trim() : "";

  /* ================= GET SHEET DATA ================= */
  const teamNameKey = normalizeLookupKey(team.team_name || team.name);
  const shortTagKey = normalizeLookupKey(
    team.short_tag || team.teamTag || team.tag,
  );
  const meta =
    (store &&
      store.teamMap &&
      (store.teamMap[teamIdKey] ||
        store.teamMap[teamNameKey] ||
        store.teamMap[shortTagKey])) ||
    {};

  /* ================= BASE URL ================= */
  const base = process.env.BASE_URL || "http://82.29.155.252:3000";

  /* ================= IMAGE FORMATTER ================= */
  const formatImgUri = (value) => {
    if (!value) return "";

    let clean = String(value).trim();

    // already full url
    if (clean.startsWith("http://") || clean.startsWith("https://")) {
      return clean;
    }

    clean = clean.replace(/^\/+/, "");
    clean = clean.replace(/^uploads\//i, "");

    return `${base}/uploads/${clean}`;
  };

  /* ================= SHEET VALUES ================= */
  const sheetTeamName = meta.team_name || meta.name || "";

  const sheetShortTag = meta.short_tag || meta.team_tag || meta.tag || "ashok";

  const sheetCountryLogo = meta.country_logo || "ashok.png";

  const sheetTeamLogo = meta.team_logo || "sumnima.png";

  /* ================= FINAL MERGED VALUES ================= */
  const finalTeamName = sheetTeamName || team.team_name || team.name || "";

  const finalShortTag =
    sheetShortTag || team.short_tag || team.teamTag || team.tag || "";

  const finalCountryLogo = sheetCountryLogo
    ? formatImgUri(sheetCountryLogo)
    : team.country_logo || team.countryLogo || team.flag || "";

  const finalTeamLogo = sheetTeamLogo
    ? formatImgUri(sheetTeamLogo)
    : team.team_logo || team.teamLogo || team.logo || "";

  /* ================= RETURN FINAL OBJECT ================= */
  return {
    ...team,

    team_id: teamIdKey,

    team_name: finalTeamName,
    short_tag: finalShortTag,

    country_logo: finalCountryLogo,
    team_logo: finalTeamLogo,

    // compatibility keys
    teamTag: finalShortTag,
    countryLogo: finalCountryLogo,
    teamLogo: finalTeamLogo,
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
      lastActive: Date.now(),
    };
  }

  if (matchCache[matchId].intervalId) return;

  console.log(
    `🌀 [ENGINE START] Initializing centralized data worker loop for Match ID: ${matchId}`,
  );

  const tick = async () => {
    const entry = matchCache[matchId];

    if (entry.clients.size === 0 && Date.now() - entry.lastActive > 30000) {
      console.log(
        `💤 [ENGINE SLEEP] Suspending central worker loop for inactive Match ID: ${matchId}`,
      );
      clearInterval(entry.intervalId);
      entry.intervalId = null;
      return;
    }

    try {
      const standings = await buildStandings(matchId);
      entry.rawJsonData = standings;

      const jsonString = JSON.stringify({
        type: "tablestandings",
        data: standings,
      });
      entry.latestFrame = frameWSFrame(jsonString);

      for (const socket of entry.clients) {
        if (socket.writable) {
          socket.write(entry.latestFrame);
        }
      }
    } catch (err) {
      console.error(
        `❌ Central Worker Loop Error [Match ID: ${matchId}]:`,
        err.message,
      );
    }
  };

  const intervalDuration = Math.max(
    1000,
    parseInt(process.env.WS_PUSH_INTERVAL_MS, 10) || 1500,
  );
  matchCache[matchId].intervalId = setInterval(tick, intervalDuration);
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
  // Match both standard types and route alternatives safely
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
router.get(
  ["/ws/realtime/:matchId", "/realtime/:matchId", "/tablestandings/:matchId"],
  async (req, res) => {
    try {
      const matchId = req.params.matchId;

      if (matchCache[matchId]) {
        matchCache[matchId].lastActive = Date.now();
        if (matchCache[matchId].rawJsonData) {
          return res.json({
            success: true,
            type: "tablestandings_cached",
            data: matchCache[matchId].rawJsonData,
          });
        }
      }

      console.log(
        `🌐 Cache miss. Instantiating live polling engine for Match: ${matchId}`,
      );
      startCentralEngine(matchId);

      const standingsData = await buildStandings(matchId);
      return res.json({
        success: true,
        type: "tablestandings_static",
        data: standingsData,
      });
    } catch (err) {
      console.error("❌ Browser HTTP GET Endpoint Error:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  },
);

router.handleRealtimeWebSocket = handleWS;
module.exports = router;
