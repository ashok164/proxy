const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const router = express.Router();

const store = require("../Data/store");

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;

/* ================= HEADER ================= */
const getClientHeaders = () => ({
  "Client-ID": CLIENT_ID ? CLIENT_ID.trim() : "",
});

/* ================= FETCH ================= */
const fetchRealtimeMatch = async (matchId) => {
  if (!API_URL) throw new Error("API_URL not configured");

  const res = await axios.get(`${API_URL}/${matchId}`, {
    headers: getClientHeaders(),
  });

  return res.data;
};

/* ================= HELPERS ================= */
const getRealtimeTeams = (data) => {
  if (Array.isArray(data?.match?.team_stats)) return data.match.team_stats;
  if (Array.isArray(data?.team_stats)) return data.team_stats;
  if (Array.isArray(data?.standings)) return data.standings;
  if (Array.isArray(data?.teams)) return data.teams;
  return [];
};

const getSheetTeam = (id) => store.teamMap?.[String(id)] || null;

const mergeTeam = (team) => {
  const meta = getSheetTeam(team.team_id);

  return {
    ...team,
    team_name: meta?.team_name || team.team_name,
    teamTag: meta?.teamTag || meta?.tag || "",
    teamLogo: meta?.teamLogo || meta?.logo_url || "",
    countryLogo: meta?.countryLogo || meta?.country || "",
  };
};

/* ================= PAYLOAD ================= */
const buildRealtimePayload = async (matchId) => {
  const data = await fetchRealtimeMatch(matchId);

  if (data?.match?.team_stats) {
    data.match.team_stats = data.match.team_stats.map(mergeTeam);
  }

  return data;
};

const buildTableStandingsPayload = async (matchId) => {
  const data = await fetchRealtimeMatch(matchId);

  const standings = getRealtimeTeams(data).map(mergeTeam);

  return { matchId, standings };
};

/* ================= WS UTIL ================= */
const encodeFrame = (payload) => {
  const message = Buffer.from(payload);
  const length = message.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x81;

  return Buffer.concat([header, message]);
};

const sendWS = (socket, data) => {
  if (socket.destroyed || socket.writableEnded) return;
  socket.write(encodeFrame(JSON.stringify(data)));
};

/* ================= SIMPLE PARSER ================= */
const parseWSRoute = (url = "") => {
  const clean = url.split("?")[0];

  console.log("WS PATH:", clean);

  const match = clean.match(/^\/(?:ws\/)?(realtime|tablestandings)\/([^/]+)$/);

  if (!match) {
    console.log("❌ WS REJECTED:", clean);
    return null;
  }

  return {
    type: match[1],
    matchId: match[2],
  };
};

/* ================= WS HANDLER ================= */
const startRealtimeWebSocket = (req, socket) => {
  const route = parseWSRoute(req.url);

  if (!route) return false;

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return true;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      "",
    ].join("\r\n")
  );

  const interval = Number(process.env.WS_PUSH_INTERVAL_MS || 5000);

  const builder =
    route.type === "tablestandings"
      ? buildTableStandingsPayload
      : buildRealtimePayload;

  const send = async () => {
    try {
      const data = await builder(route.matchId);

      sendWS(socket, {
        type: route.type,
        matchId: route.matchId,
        data,
        pushedAt: new Date().toISOString(),
      });
    } catch (err) {
      sendWS(socket, {
        type: "error",
        matchId: route.matchId,
        message: err.message,
      });
    }
  };

  const timer = setInterval(send, interval);

  socket.on("close", () => clearInterval(timer));
  socket.on("error", () => clearInterval(timer));

  send();

  return true;
};

/* ================= EXPORT ================= */
router.get("/realtime/:matchId", async (req, res) => {
  const data = await buildRealtimePayload(req.params.matchId);
  res.json(data);
});

router.get("/tablestandings/:matchId", async (req, res) => {
  const data = await buildTableStandingsPayload(req.params.matchId);
  res.json(data);
});

router.handleRealtimeWebSocket = startRealtimeWebSocket;

module.exports = router;
