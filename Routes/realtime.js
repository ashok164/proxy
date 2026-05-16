const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
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

const buildRealtimePayload = async (matchId) => {
  const data = await fetchRealtimeMatch(matchId);

  if (data?.match?.team_stats && store.teamMap) {
    data.match.team_stats = data.match.team_stats.map(mergeLegacySheetFields);
  }

  return data;
};

const buildTableStandingsPayload = async (matchId) => {
  const data = await fetchRealtimeMatch(matchId);
  const standings = getRealtimeTeams(data).map(mergeStandingsSheetFields);

  return {
    matchId,
    standings,
  };
};

const encodeWebSocketFrame = (payload) => {
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

const sendWebSocketJson = (socket, payload) => {
  if (socket.destroyed || socket.writableEnded) return;
  socket.write(encodeWebSocketFrame(JSON.stringify(payload)));
};

const closeWebSocket = (socket, code = 1000, reason = "") => {
  if (socket.destroyed || socket.writableEnded) return;

  const reasonBuffer = Buffer.from(reason);
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);

  const header = Buffer.from([0x88, payload.length]);
  socket.end(Buffer.concat([header, payload]));
};

const acceptWebSocket = (req, socket) => {
  const key = req.headers["sec-websocket-key"];

  if (!key) {
    socket.destroy();
    return false;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      "",
    ].join("\r\n"),
  );

  return true;
};

const parseRealtimeWebSocketPath = (url = "") => {
  const pathname = new URL(url, "http://localhost").pathname;
  const match = pathname.match(/^\/ws\/(realtime|tablestandings)\/([^/]+)$/);

  if (!match) return null;

  return {
    type: match[1],
    matchId: decodeURIComponent(match[2]),
  };
};

const startRealtimeWebSocket = (req, socket) => {
  const route = parseRealtimeWebSocketPath(req.url);

  if (!route) return false;

  if (!acceptWebSocket(req, socket)) return true;

  const intervalMs = Number(process.env.WS_PUSH_INTERVAL_MS || 5000);
  const buildPayload =
    route.type === "tablestandings"
      ? buildTableStandingsPayload
      : buildRealtimePayload;

  const push = async () => {
    try {
      const data = await buildPayload(route.matchId);
      sendWebSocketJson(socket, {
        type: route.type,
        matchId: route.matchId,
        data,
        pushedAt: new Date().toISOString(),
      });
    } catch (err) {
      sendWebSocketJson(socket, {
        type: "error",
        matchId: route.matchId,
        error: err.message,
      });
    }
  };

  const timer = setInterval(push, intervalMs > 0 ? intervalMs : 5000);

  socket.on("data", (buffer) => {
    const opcode = buffer[0] & 0x0f;
    if (opcode === 0x8) closeWebSocket(socket);
  });
  socket.on("close", () => clearInterval(timer));
  socket.on("error", () => clearInterval(timer));

  push();
  return true;
};

router.get("/realtime/:matchId", async (req, res) => {
  try {
    const { matchId } = req.params;
    const data = await buildRealtimePayload(matchId);

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/tablestandings/:matchId", async (req, res) => {
  try {
    const { matchId } = req.params;
    const data = await buildTableStandingsPayload(matchId);

    res.json(data);
  } catch (err) {
    const status = err.statusCode || err.response?.status || 500;
    res.status(status).json({
      error: "Failed to fetch table standings",
      message: err.message,
    });
  }
});

router.handleRealtimeWebSocket = startRealtimeWebSocket;

module.exports = router;
