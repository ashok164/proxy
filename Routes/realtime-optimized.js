// ⚡ OPTIMIZED REALTIME SYSTEM - Delta-based socket updates with data compression

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const https = require("https");
const os = require("os");
const router = express.Router();

const pool = require("../Database/db");
const {
  buildAssetLookup,
  formatRealtimePlayer,
  getPlayersFromTeamPayload,
  saveMatchPlayers,
} = require("../Data/matchMetadata");

// ================= FIELD NAME COMPRESSION MAPPING =================
const FIELD_MAP = {
  // Outbound compression
  TEAM_ID: "id",
  ROOM_TEAM_ID: "rid",
  TEAM_NAME: "nm",
  TEAM_TAG: "tg",
  KILLS: "k",
  ALIVE: "a",
  PLACEMENT_POINTS: "pp",
  RANKING_SCORE: "rs",
  TOTAL_POINTS: "tp",
  IS_ELIMINATED: "el",
  IS_PLAYING: "pl",
  PLAYERS: "pls",
  RANK: "rnk",
  COUNTRY_LOGO: "cl",
  TEAM_LOGO: "tl",
  FULL_BANNER: "fb",
  NOTIF_BANNER: "nb",
  HP_PERCENT: "hp",
  PLAYER_PIC: "pic",
  PLAYER_NAME: "pnm",
  STATUS: "st",
  ACTIVE_SKILL: "sk",
  CHARACTER: "ch",
  WEAPON: "wp",
};

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;
const TARGET_IP = process.env.VPS_IP || "82.29.155.252";

// ⚡ Enhanced Global Cache with delta tracking
const matchCache = {};
const realtimeMetaCache = {
  data: null,
  expiresAt: 0,
};

const getPushIntervalMs = () =>
  Math.max(50, parseInt(process.env.WS_PUSH_INTERVAL_MS, 10) || 100);

const getMetaCacheTtlMs = () =>
  Math.max(1000, parseInt(process.env.REALTIME_META_CACHE_TTL_MS, 10) || 10000);

const checkLocalIpAvailability = (targetIp) => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === "IPv4" && net.address === targetIp) return true;
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

// Helper functions (keep existing)
const getTeams = (data) => {
  if (Array.isArray(data?.match_stats)) {
    return data.match_stats.flatMap((match) => match?.team_stats || []);
  }
  return data?.match?.team_stats || data?.team_stats || data?.teams || [];
};

const getPlayerStats = (data) =>
  data?.match?.player_stats ||
  data?.player_stats ||
  data?.players ||
  (Array.isArray(data?.match_stats)
    ? data.match_stats.flatMap((match) =>
        (match?.team_stats || []).flatMap((team) => team?.player_stats || []),
      )
    : undefined);

const firstValue = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== "");

const toNumber = (value, fallback = 0) => {
  if (value === undefined || value === null || value === "") return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const hasTeamBooyah = (team = {}) => {
  const values = [
    team.booyah_count,
    team.booyahCount,
    team.booyah_counter,
    team.booyahCounter,
    team.booyah,
    team.is_booyah,
    team.isBooyah,
    team.has_booyah,
    team.hasBooyah,
    team.winner,
    team.isWinner,
    team.is_winner,
  ];

  return values.some((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value > 0;
    const clean = String(value ?? "").trim().toLowerCase();
    return ["true", "1", "yes", "y", "win", "winner", "booyah"].includes(clean);
  });
};

const getTeamBooyahCount = (team = {}) => {
  const explicitValue = firstValue(
    team.booyah_count,
    team.booyahCount,
    team.booyah_counter,
    team.booyahCounter,
  );

  if (explicitValue !== undefined && explicitValue !== null && explicitValue !== "") {
    if (typeof explicitValue === "boolean") return explicitValue ? 1 : 0;
    const clean = String(explicitValue).trim().toLowerCase();
    if (["true", "yes", "y", "win", "winner", "booyah"].includes(clean)) return 1;
    return Math.max(0, toNumber(explicitValue));
  }

  return hasTeamBooyah(team) ? 1 : 0;
};

const normalizeTeamIdKey = (value) => {
  const clean = String(value ?? "").trim();
  if (!clean) return "";
  const numberValue = Number(clean);
  return /^\d+$/.test(clean) && Number.isSafeInteger(numberValue)
    ? String(numberValue)
    : clean;
};

const getTeamId = (team = {}) =>
  firstValue(
    team.team_id,
    team.id,
    team.teamId,
    team.team_uid,
    team.teamUid,
    team.teamCode
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
    team.shortName
  );

const getTeamKills = (team = {}) =>
  toNumber(
    firstValue(
      team.kills,
      team.kill,
      team.kill_count,
      team.killCount,
      team.kill_score,
      team.killScore,
      team.killing_score,
      team.killingScore,
      team.total_kills,
      team.totalKills,
      team.team_kills,
      team.teamKills
    )
  );

// ⚡ OPTIMIZED: Compact Player Representation
const compactPlayer = (player) => ({
  id: firstValue(
    player.account_id,
    player.player_uid,
    player.playerUid,
    player.id,
    ""
  ),
  nm: firstValue(player.nickname, player.player_name, player.playerName, ""),
  hp: Math.max(
    0,
    Math.min(
      100,
      toNumber(
        firstValue(
          player.hp_info?.current_hp,
          player.hpInfo?.currentHp,
          player.hp,
          100
        )
      ) / Math.max(1, toNumber(player.hp_info?.total_hp || 200, 200)) * 100
    )
  ),
  st: player.player_state === 2 || player.isKnocked ? 1 : player.status === "dead" || player.hp <= 0 ? 2 : 0, // 0=alive, 1=knocked, 2=dead
  pic: firstValue(player.player_image, player.player_pic, player.playerPic, ""),
  cam: firstValue(player.camera_link, player.cameraLink, ""),
  k: toNumber(firstValue(player.kills, player.kill, player.kill_count, player.killCount, 0)),
  dmg: toNumber(firstValue(player.damage, player.damage_dealt, player.damageDealt, 0)),
  as: toNumber(firstValue(player.assists, player.assist, player.assist_count, player.assistCount, 0)),
  kd: toNumber(firstValue(player.knockdowns, player.knock_downs, player.knockDowns, player.knocks, 0)),
  sv: toNumber(firstValue(player.survival_time, player.survivalTime, player.survival, 0)),
  ch: firstValue(player.character, player.characterInfo, null),
  acts: firstValue(player.active_skill, player.activeSkill, null),
  ps: firstValue(player.passive_skills, player.passiveSkills, []),
  wu: firstValue(player.weapon_used, player.weaponUsed, player.weapon, null),
  wp: firstValue(player.weapon, player.weapon_used, player.weaponUsed, null),
  ws: firstValue(player.weapon_usages, player.weaponUsages, player.weapons, []),
  pet: firstValue(player.pet, player.petSkill, player.pet_skill, null),
  eq: firstValue(player.equipment_loadouts, player.equipmentLoadouts, player.loadouts, []),
});

// ⚡ OPTIMIZED: Compact Team Representation
const compactTeam = (team) => {
  const players = Array.isArray(team.player_stats)
    ? team.player_stats
    : Array.isArray(team.playerStats)
      ? team.playerStats
      : Array.isArray(team.players)
        ? team.players
        : [];

  const booyahCount = getTeamBooyahCount(team);

  return {
    id: normalizeTeamIdKey(getTeamId(team)),
    rid: normalizeTeamIdKey(firstValue(team.room_team_id, team.roomTeamId, "")),
    nm: getTeamName(team),
    tg: getTeamTag(team),
    k: getTeamKills(team),
    a: Math.max(0, toNumber(team.playersAlive || team.players_alive || players.filter(p => compactPlayer(p).st < 2).length)),
    tp: toNumber(firstValue(team.total_points, team.totalPoints, team.points, team.score, 0)),
    wr: firstValue(team.win_rate, team.winRate, team.winrate, 0),
    el: Boolean(team.is_eliminated || team.isEliminated),
    pl: Boolean(team.is_playing !== false && team.isPlaying !== false),
    pls: players.map(compactPlayer),
    cl: team.country_logo || team.countryLogo || "",
    tl: team.team_logo || team.teamLogo || "",
    fb: "",
    nb: team.notification_team_banner || team.notificationTeamBanner || "",
    bc: booyahCount,
    booyah_count: booyahCount,
    booyahCount,
  };
};

// ⚡ DELTA UPDATE CALCULATION - Only send changed fields
const calculateTeamDelta = (newTeam, oldTeam = {}) => {
  if (!oldTeam || !oldTeam.id || oldTeam.id !== newTeam.id) {
    return newTeam; // Full team if new
  }

  const delta = { id: newTeam.id };
  let hasChanges = false;

  Object.keys(newTeam).forEach((key) => {
    if (key === "id") return; // Skip ID
    
    const newVal = newTeam[key];
    const oldVal = oldTeam[key];

    // Deep comparison for arrays
    if (Array.isArray(newVal) && Array.isArray(oldVal)) {
      if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
        delta[key] = newVal;
        hasChanges = true;
      }
    } else if (newVal !== oldVal) {
      delta[key] = newVal;
      hasChanges = true;
    }
  });

  return hasChanges ? delta : null;
};

// ⚡ BUILD OPTIMIZED STANDINGS
const buildOptimizedStandings = async (id) => {
  try {
    const data = await fetchMatch(id);
    const teams = getTeams(data);

    const standings = teams
      .map((team) => compactTeam(team))
      .sort((a, b) => toNumber(b.tp) - toNumber(a.tp) || toNumber(b.k) - toNumber(a.k))
      .slice(0, 18)
      .map((team, index) => ({
        ...team,
        rnk: index + 1,
      }));

    return {
      success: true,
      ts: Date.now(), // timestamp for change detection
      teams: standings,
    };
  } catch (err) {
    console.error("Error building optimized standings:", err.message);
    return { success: false, teams: [] };
  }
};

// ⚡ OPTIMIZED FRAME CREATION
const frameWSFrame = (payload) => {
  const dataBuffer = Buffer.from(payload, "utf8");
  const len = dataBuffer.length;
  let frame;

  if (len <= 125) {
    frame = Buffer.allocUnsafe(2 + len);
    frame[0] = 0x81;
    frame[1] = len;
  } else if (len <= 0xffff) {
    frame = Buffer.allocUnsafe(4 + len);
    frame[0] = 0x81;
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame = Buffer.allocUnsafe(10 + len);
    frame[0] = 0x81;
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }

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
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const matchId = route.matchId;

  if (!matchCache[matchId]) {
    matchCache[matchId] = {
      clients: new Set(),
      currentStandings: null,
      latestFrame: null,
      deltaFrame: null,
      timerId: null,
      lastTeamStates: new Map(),
      refreshing: false,
    };
  }

  const entry = matchCache[matchId];
  entry.clients.add(socket);

  // Send full snapshot to new client
  if (entry.latestFrame && socket.writable) {
    socket.write(entry.latestFrame);
  }

  startCentralEngine(matchId);

  const cleanup = () => {
    entry.clients.delete(socket);
    socket.destroy();
  };

  socket.on("close", cleanup);
  socket.on("error", cleanup);

  return true;
};

// ⚡ OPTIMIZED CENTRAL ENGINE - Delta-based updates
const startCentralEngine = (matchId) => {
  const entry = matchCache[matchId];

  if (entry.timerId) return; // Already running

  const tick = async () => {
    if (entry.clients.size === 0) {
      entry.timerId = null;
      return; // Stop if no clients
    }

    entry.refreshing = true;

    try {
      const standings = await buildOptimizedStandings(matchId);

      if (!standings.success) {
        entry.refreshing = false;
        entry.timerId = setTimeout(tick, getPushIntervalMs());
        return;
      }

      // DELTA CALCULATION: Only send changed teams + timestamp
      const deltas = [];
      standings.teams.forEach((newTeam) => {
        const oldTeam = entry.lastTeamStates.get(newTeam.id);
        const delta = calculateTeamDelta(newTeam, oldTeam);

        if (delta) {
          deltas.push(delta);
          entry.lastTeamStates.set(newTeam.id, newTeam);
        }
      });

      // Send full payload every 10 updates, delta otherwise
      const updateCount = (entry.updateCount || 0) + 1;
      entry.updateCount = updateCount % 10;

      let payload;
      if (updateCount % 10 === 0 || !entry.latestFrame) {
        // Full snapshot
        payload = {
          type: "full",
          ts: standings.ts,
          teams: standings.teams,
        };
        entry.latestFrame = frameWSFrame(
          JSON.stringify(payload)
        );
      } else {
        // Delta update
        payload = {
          type: "delta",
          ts: standings.ts,
          d: deltas, // Only changed teams
        };
      }

      const frame = payload.type === "full" ? entry.latestFrame : frameWSFrame(JSON.stringify(payload));

      for (const socket of entry.clients) {
        if (socket.writable) {
          socket.write(frame);
        }
      }
    } catch (err) {
      console.error(`Error in central engine [${matchId}]:`, err.message);
    } finally {
      entry.refreshing = false;
      entry.timerId = setTimeout(tick, getPushIntervalMs());
    }
  };

  entry.timerId = setTimeout(tick, 0);
};

// ================= ROUTE HANDLERS =================
router.get("/raw/:matchId", async (req, res) => {
  try {
    const { matchId } = req.params;
    const standings = await buildOptimizedStandings(matchId);
    res.json(standings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get(
  ["/ws/realtime/:matchId", "/realtime/:matchId", "/tablestandings/:matchId"],
  async (req, res) => {
    try {
      const { matchId } = req.params;
      const standings = await buildOptimizedStandings(matchId);
      res.json(standings);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.handleRealtimeWebSocket = handleWS;
router.getCachedStandings = (matchId) =>
  matchCache[matchId]?.currentStandings || null;

module.exports = router;
