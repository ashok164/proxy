const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const https = require("https");
const os = require("os");
const router = express.Router();

const pool = require("../Database/db");

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

const getPlayerStats = (data) =>
  data?.match?.player_stats || data?.player_stats || data?.players || undefined;

const firstValue = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== "");
const normalizeTeamIdNumber = (value) => {
  const clean = String(value ?? "").trim();
  if (!/^\d+$/.test(clean)) return null;

  const numberValue = Number(clean);
  return Number.isSafeInteger(numberValue) ? numberValue : null;
};

const normalizeTeamIdKey = (value) => {
  const numberValue = normalizeTeamIdNumber(value);
  return numberValue === null ? "" : String(numberValue);
};

const getTeamId = (team = {}) =>
  firstValue(
    team.team_id,
    team.id,
    team.teamId,
    team.team_uid,
    team.teamUid,
    team.teamCode,
  );

const getTeamName = (team = {}) =>
  firstValue(team.team_name, team.teamName, team.name, team.team, team.title);

const getTeamTag = (team = {}) =>
  firstValue(
    team.short_tag,
    team.team_tag,
    team.teamTag,
    team.shortTag,
    team.tag,
    team.shortName,
  );

const getPlayerUid = (player = {}) =>
  firstValue(
    player.account_id,
    player.accountId,
    player.accountID,
    player.player_uid,
    player.playerUid,
    player.playerUID,
    player.uid,
    player.player_id,
    player.playerId,
    player.id,
  );

const getPlayerTeamId = (player = {}) =>
  firstValue(
    player.team_id,
    player.teamId,
    player.team_uid,
    player.teamUid,
    player.teamCode,
  );

const addMetaToIndex = (index, meta) => {
  if (!meta) return;

  const teamIdKey = normalizeTeamIdKey(getTeamId(meta));
  if (teamIdKey) index[teamIdKey] = meta;
};

const buildTeamMetaIndex = async () => {
  const index = {};

  try {
    const result = await pool.query(
      "SELECT team_id, team_name, short_tag, team_logo, country_logo FROM teams",
    );

    for (const meta of result.rows) {
      addMetaToIndex(index, meta);
    }
  } catch (err) {
    console.error("DB team metadata lookup failed:", err.message);
  }

  return index;
};

const formatUploadUri = (value) => {
  if (!value) return "";

  const base = process.env.BASE_URL || "http://82.29.155.252:3000";
  let clean = String(value).trim();

  if (clean.startsWith("http://") || clean.startsWith("https://")) {
    return clean;
  }

  clean = clean.replace(/^\/+/, "");
  clean = clean.replace(/^uploads\//i, "");

  return `${base}/uploads/${clean}`;
};

const normalizePlayerUidKey = (value) => String(value ?? "").trim();

const buildPlayerIndex = async () => {
  const index = {
    byTeam: {},
    byTeamAndUid: {},
  };

  try {
    const result = await pool.query(
      "SELECT id, team_id, player_uid, player_name, camera_link, player_pic FROM team_players ORDER BY id DESC",
    );

    for (const player of result.rows) {
      const teamIdKey = normalizeTeamIdKey(player.team_id);
      if (!teamIdKey) continue;

      if (!index.byTeam[teamIdKey]) index.byTeam[teamIdKey] = [];
      if (!index.byTeamAndUid[teamIdKey]) index.byTeamAndUid[teamIdKey] = {};

      const formattedPlayer = {
        ...player,
        team_id: teamIdKey,
        playerUid: player.player_uid,
        playerName: player.player_name,
        cameraLink: player.camera_link,
        player_pic: formatUploadUri(player.player_pic),
        playerPic: formatUploadUri(player.player_pic),
      };

      index.byTeam[teamIdKey].push(formattedPlayer);

      const playerUidKey = normalizePlayerUidKey(player.player_uid);
      if (playerUidKey && !index.byTeamAndUid[teamIdKey][playerUidKey]) {
        index.byTeamAndUid[teamIdKey][playerUidKey] = formattedPlayer;
      }
    }
  } catch (err) {
    console.error("DB player metadata lookup failed:", err.message);
  }

  return index;
};

const getPlayerMeta = (player, fallbackTeamIdKey, playerIndex = {}) => {
  const playerTeamIdKey = normalizeTeamIdKey(getPlayerTeamId(player));
  const teamIdKey = playerTeamIdKey || fallbackTeamIdKey;
  const playerUidKey = normalizePlayerUidKey(getPlayerUid(player));

  if (!teamIdKey || !playerUidKey) return null;

  return playerIndex.byTeamAndUid?.[teamIdKey]?.[playerUidKey] || null;
};

const mergePlayerStat = (player, fallbackTeamIdKey, playerIndex = {}) => {
  if (!player || typeof player !== "object") return player;

  const meta = getPlayerMeta(player, fallbackTeamIdKey, playerIndex);
  if (!meta) return player;

  const playerUid = getPlayerUid(player) || meta.playerUid;
  const playerName =
    meta.playerName || player.playerName || player.player_name || "";
  const cameraLink =
    meta.cameraLink || player.cameraLink || player.camera_link || "";
  const playerPic =
    meta.playerPic || player.playerPic || player.player_pic || "";

  return {
    ...player,
    account_id: player.account_id || playerUid,
    player_uid: playerUid,
    player_name: playerName,
    camera_link: cameraLink,
    player_pic: playerPic,

    // compatibility keys for frontend consumers
    accountId: player.accountId || playerUid,
    playerUid,
    uid: player.uid || playerUid,
    playerName,
    name: playerName,
    cameraLink,
    camLink: cameraLink,
    camlink: cameraLink,
    playerPic,
    pic: playerPic,
    playerMetaMatched: true,
  };
};

const mergePlayerStats = (stats, fallbackTeamIdKey, playerIndex = {}) => {
  if (Array.isArray(stats)) {
    return stats.map((player) =>
      mergePlayerStat(player, fallbackTeamIdKey, playerIndex),
    );
  }

  if (stats && typeof stats === "object") {
    return Object.fromEntries(
      Object.entries(stats).map(([key, player]) => [
        key,
        mergePlayerStat(player, fallbackTeamIdKey, playerIndex),
      ]),
    );
  }

  return stats;
};

const filterPlayerStatsByTeam = (stats, teamIdKey) => {
  if (!stats || !teamIdKey) return undefined;

  const belongsToTeam = (player) =>
    normalizeTeamIdKey(getPlayerTeamId(player)) === teamIdKey;

  if (Array.isArray(stats)) {
    return stats.filter(belongsToTeam);
  }

  if (typeof stats === "object") {
    return Object.fromEntries(
      Object.entries(stats).filter(([, player]) => belongsToTeam(player)),
    );
  }

  return undefined;
};

const mergeTeam = (
  team,
  metaIndex = {},
  logoCache = {},
  playerIndex = {},
  externalPlayerStats,
) => {
  if (!team) return {};

  /* ================= NORMALIZE TEAM ID ================= */
  const rawId = getTeamId(team);

  const teamIdKey = normalizeTeamIdKey(rawId);

  /* ================= GET DB TEAM DATA ================= */
  const meta = teamIdKey ? metaIndex[teamIdKey] || {} : {};

  /* ================= IMAGE FORMATTER ================= */
  const formatImgUri = (value) => {
    return formatUploadUri(value);
  };

  /* ================= DB VALUES ================= */
  const dbTeamName = meta.team_name || meta.name || "";

  const dbShortTag = getTeamTag(meta);

  const dbCountryLogo = meta.country_logo;

  const dbTeamLogo = meta.team_logo;

  /* ================= FINAL MERGED VALUES ================= */
  const finalTeamName = dbTeamName || getTeamName(team) || "";

  const finalShortTag = dbShortTag || getTeamTag(team) || "";

  let finalCountryLogo = dbCountryLogo
    ? formatImgUri(dbCountryLogo)
    : formatImgUri(firstValue(team.country_logo, team.countryLogo, team.flag));

  let finalTeamLogo = dbTeamLogo
    ? formatImgUri(dbTeamLogo)
    : formatImgUri(firstValue(team.team_logo, team.teamLogo, team.logo));

  if (teamIdKey && logoCache[teamIdKey]) {
    finalCountryLogo =
      finalCountryLogo || logoCache[teamIdKey].country_logo || "";
    finalTeamLogo = finalTeamLogo || logoCache[teamIdKey].team_logo || "";
  }

  if (teamIdKey && (finalCountryLogo || finalTeamLogo)) {
    logoCache[teamIdKey] = {
      country_logo: finalCountryLogo,
      team_logo: finalTeamLogo,
    };
  }

  const playerPics = teamIdKey ? playerIndex.byTeam?.[teamIdKey] || [] : [];
  const teamPlayerStats =
    team.player_stats !== undefined
      ? team.player_stats
      : filterPlayerStatsByTeam(externalPlayerStats, teamIdKey);
  const playerStats =
    teamPlayerStats !== undefined
      ? mergePlayerStats(teamPlayerStats, teamIdKey, playerIndex)
      : undefined;
  const playerStatsCamel =
    team.playerStats !== undefined
      ? mergePlayerStats(team.playerStats, teamIdKey, playerIndex)
      : undefined;

  /* ================= RETURN FINAL OBJECT ================= */
  const mergedTeam = {
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

    player_stats: (team?.player_stats || []).map((stat) => {
      const matchedPlayer = (team?.player_pics || []).find(
        (pic) =>
          String(pic.player_uid || pic.playerUid) ===
          String(stat.account_id || stat.player_uid || stat.playerUid),
      );

      return {
        ...stat,

        // merged player meta
        player_name:
          matchedPlayer?.player_name ||
          matchedPlayer?.playerName ||
          stat.player_name,

        player_pic:
          matchedPlayer?.player_pic ||
          matchedPlayer?.playerPic ||
          stat.player_pic,

        camera_link:
          matchedPlayer?.camera_link ||
          matchedPlayer?.cameraLink ||
          stat.camera_link,

        playerMetaMatched: !!matchedPlayer,
        team_tag: finalShortTag,
        country_logo: finalCountryLogo,
        team_logo: finalTeamLogo,
        team_name: finalTeamName,
      };
    }),

    metaMatched: Boolean(teamIdKey && meta.team_id),
  };

  if (playerStats !== undefined) mergedTeam.player_stats = playerStats;
  if (playerStatsCamel !== undefined) mergedTeam.playerStats = playerStatsCamel;

  return mergedTeam;
};

const buildStandings = async (id, logoCache = {}) => {
  const data = await fetchMatch(id);
  const metaIndex = await buildTeamMetaIndex();
  const playerIndex = await buildPlayerIndex();
  const externalPlayerStats = getPlayerStats(data);
  const teams = getTeams(data).map((team) =>
    mergeTeam(team, metaIndex, logoCache, playerIndex, externalPlayerStats),
  );

  return {
    matchId: id,
    standings: teams,
    player_stats:
      externalPlayerStats !== undefined
        ? mergePlayerStats(externalPlayerStats, "", playerIndex)
        : undefined,
  };
};

/* ================= CENTRAL DATA STREAM ENGINE ================= */
const startCentralEngine = (matchId) => {
  if (!matchCache[matchId]) {
    matchCache[matchId] = {
      clients: new Set(),
      rawJsonData: null,
      latestFrame: null,
      logoCache: {},
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
      const standings = await buildStandings(matchId, entry.logoCache);
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

      const standingsData = await buildStandings(
        matchId,
        matchCache[matchId]?.logoCache || {},
      );
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
