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
const normalizeTeamIdNumber = (value) => {
  const clean = String(value ?? "").trim();
  if (!/^\d+$/.test(clean)) return null;

  const numberValue = Number(clean);
  return Number.isSafeInteger(numberValue) ? numberValue : null;
};

const normalizeTeamIdKey = (value) => {
  const clean = String(value ?? "").trim();
  if (!clean) return "";

  const numberValue = normalizeTeamIdNumber(value);
  return numberValue === null ? clean : String(numberValue);
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
      team.teamKills,
    ),
  );

const getTeamLivePoints = (team = {}) =>
  toNumber(
    firstValue(
      team.total_points,
      team.totalPoints,
      team.points,
      team.score,
      team.total_score,
      team.totalScore,
      team.final_score,
      team.finalScore,
      team.total_kills,
      team.totalKills,
      toNumber(firstValue(team.ranking_score, team.rankingScore)) +
        getTeamKills(team),
    ),
  );

const getTeamPlacementPoints = (team = {}) =>
  toNumber(
    firstValue(
      team.placement,
      team.placement_points,
      team.placementPoints,
      team.survival_score,
      team.survivalScore,
      team.ranking_score,
      team.rankingScore,
    ),
  );

const getTeamResultScore = (team = {}) => {
  const explicitScore = firstValue(
    team.total_points,
    team.totalPoints,
    team.points,
    team.score,
    team.total_score,
    team.totalScore,
    team.final_score,
    team.finalScore,
    team.total_kills,
    team.totalKills,
  );

  if (explicitScore !== undefined && explicitScore !== null && explicitScore !== "") {
    return toNumber(explicitScore);
  }

  return getTeamKills(team) + getTeamPlacementPoints(team);
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
    if (typeof value === "number") return value === 1;

    const clean = String(value ?? "").trim().toLowerCase();
    return ["true", "1", "yes", "y", "win", "winner", "booyah"].includes(clean);
  });
};

const isFinalTeamResult = (team = {}) => {
  const value = firstValue(team.final, team.is_final, team.isFinal);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return ["true", "1", "yes", "y", "final"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
};

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

const getBooyahAssetImage = async () => {
  try {
    const result = await pool.query(
      `
      SELECT image_url
      FROM tournament_assets
      WHERE asset_id = $1 AND active = true
      ORDER BY id DESC
      LIMIT 1
      `,
      ["1"],
    );

    return formatUploadUri(result.rows[0]?.image_url || "");
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) {
      console.error("Booyah tournament asset lookup failed:", err.message);
    }
    return "";
  }
};

const addBannerToIndex = (index, row, key) => {
  const teamIdKey = normalizeTeamIdKey(row.team_id);
  if (!teamIdKey || !row.image_url) return;

  if (!index[teamIdKey]) index[teamIdKey] = {};
  if (index[teamIdKey][key]) return;
  index[teamIdKey][key] = formatUploadUri(row.image_url);
};

const buildTeamBannerIndex = async () => {
  const index = {};

  try {
    const fullBannerResult = await pool.query(`
      SELECT team_id, image_url
      FROM full_team_banners
      WHERE active = true AND team_id IS NOT NULL AND team_id <> ''
      ORDER BY id DESC
    `);

    for (const row of fullBannerResult.rows) {
      addBannerToIndex(index, row, "fullTeamBanner");
    }
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) {
      console.error("Full team banner lookup failed:", err.message);
    }
  }

  try {
    const notificationBannerResult = await pool.query(`
      SELECT team_id, image_url
      FROM notification_team_banners
      WHERE active = true AND team_id IS NOT NULL AND team_id <> ''
      ORDER BY id DESC
    `);

    for (const row of notificationBannerResult.rows) {
      addBannerToIndex(index, row, "notificationTeamBanner");
    }
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) {
      console.error("Notification team banner lookup failed:", err.message);
    }
  }

  return index;
};

const buildRoomTeamMappingIndex = async (matchId) => {
  const index = {};

  try {
    const result = await pool.query(
      `
      SELECT room_team_id, permanent_team_id
      FROM match_team_mappings
      WHERE match_id = $1
      `,
      [matchId],
    );

    for (const mapping of result.rows) {
      const roomTeamIdKey = normalizeTeamIdKey(mapping.room_team_id);
      const permanentTeamIdKey = normalizeTeamIdKey(mapping.permanent_team_id);
      if (roomTeamIdKey && permanentTeamIdKey) {
        index[roomTeamIdKey] = permanentTeamIdKey;
      }
    }
  } catch (err) {
    if (err.code === "42P01") {
      console.warn("Match team mappings table missing; falling back to raw room team ids");
    } else {
      console.error("DB match team mapping lookup failed:", err.message);
    }
  }

  return index;
};

const resolvePermanentTeamId = (roomTeamIdKey, roomTeamMap = {}) =>
  roomTeamMap[roomTeamIdKey] || roomTeamIdKey;

const buildHistoricalLeaderboardIndex = async (activeMatchId) => {
  const index = {};

  const result = await pool.query(
    `
    SELECT
      t.team_id,
      t.team_name,
      t.short_tag,
      t.team_logo,
      t.country_logo,
      COALESCE(SUM(mr.kills), 0) AS kills,
      COALESCE(SUM(mr.placement), 0) AS placement,
      COALESCE(SUM(mr.booyah_count), 0) AS booyah_count,
      COALESCE(SUM(mr.total_kills), 0) AS total_kills,
      COUNT(DISTINCT mr.match_id) FILTER (WHERE mr.match_id IS NOT NULL) AS matches_played
    FROM teams t
    LEFT JOIN match_results mr
      ON mr.team_id = t.team_id
      AND mr.match_id <> $1
    GROUP BY
      t.team_id,
      t.team_name,
      t.short_tag,
      t.team_logo,
      t.country_logo
    `,
    [activeMatchId],
  );

  for (const row of result.rows) {
    const teamIdKey = normalizeTeamIdKey(row.team_id);
    if (!teamIdKey) continue;

    index[teamIdKey] = {
      permanentTeamId: teamIdKey,
      teamName: row.team_name || "",
      teamTag: row.short_tag || "",
      teamLogo: formatUploadUri(row.team_logo),
      countryLogo: formatUploadUri(row.country_logo),
      historicalKills: Number(row.kills),
      historicalPlacement: Number(row.placement),
      historicalBooyahCount: Number(row.booyah_count),
      historicalPoints: Number(row.total_kills),
      matchesPlayed: Number(row.matches_played),
    };
  }

  return index;
};

const normalizePlayersList = (players) => {
  if (Array.isArray(players)) return players;
  if (players && typeof players === "object") return Object.values(players);
  return [];
};

const buildOverallLeaderboard = async (
  activeMatchId,
  liveTeams = [],
  playerIndex = {},
  bannerIndex = {},
) => {
  const historicalIndex = await buildHistoricalLeaderboardIndex(activeMatchId);
  const liveIndex = {};

  for (const team of liveTeams) {
    const permanentTeamId = normalizeTeamIdKey(
      team.permanentTeamId || team.permanent_team_id || team.team_id,
    );
    if (!permanentTeamId) continue;

    liveIndex[permanentTeamId] = {
      roomTeamId: normalizeTeamIdKey(team.roomTeamId || team.room_team_id),
      liveKills: getTeamKills(team),
      livePoints: getTeamLivePoints(team),
      liveRaw: team,
      teamName: getTeamName(team) || "",
      teamTag: getTeamTag(team) || "",
      teamLogo: team.teamLogo || team.team_logo || "",
      countryLogo: team.countryLogo || team.country_logo || "",
      fullTeamBanner: team.fullTeamBanner || team.full_team_banner || "",
      notificationTeamBanner:
        team.notificationTeamBanner || team.notification_team_banner || "",
      booyahBanner: team.booyahBanner || team.booyah_banner || "",
      booyahImage: team.booyahImage || team.booyah_image || "",
    };
  }

  const teamIds = new Set([
    ...Object.keys(historicalIndex),
    ...Object.keys(liveIndex),
  ]);

  const rows = [...teamIds].map((teamId) => {
    const historical = historicalIndex[teamId] || {
      permanentTeamId: teamId,
      teamName: "",
      teamTag: "",
      teamLogo: "",
      countryLogo: "",
      historicalKills: 0,
      historicalPlacement: 0,
      historicalBooyahCount: 0,
      historicalPoints: 0,
      matchesPlayed: 0,
    };
    const live = liveIndex[teamId] || {
      roomTeamId: null,
      liveKills: 0,
      livePoints: 0,
      teamName: "",
      teamTag: "",
      teamLogo: "",
      countryLogo: "",
    };
    const totalKills = historical.historicalKills + live.liveKills;
    const totalPoints = historical.historicalPoints + live.livePoints;
    const liveRaw = live.liveRaw || {};
    const players = normalizePlayersList(
      firstValue(liveRaw.player_stats, liveRaw.playerStats),
    );
    const rosterPlayers = playerIndex.byTeam?.[teamId] || [];
    const overallPlayers = players.length ? players : rosterPlayers;

    const leaderboardFields = {
      rank: 0,
      permanentTeamId: teamId,
      teamId,
      roomTeamId: live.roomTeamId,
      teamName: live.teamName || historical.teamName,
      teamTag: live.teamTag || historical.teamTag,
      teamLogo: live.teamLogo || historical.teamLogo,
      countryLogo: live.countryLogo || historical.countryLogo,
      fullTeamBanner: live.fullTeamBanner || bannerIndex[teamId]?.fullTeamBanner || "",
      notificationTeamBanner:
        live.notificationTeamBanner || bannerIndex[teamId]?.notificationTeamBanner || "",
      booyahBanner: live.booyahBanner || live.booyahImage || "",
      booyahImage: live.booyahImage || live.booyahBanner || "",
      historicalKills: historical.historicalKills,
      historicalPlacement: historical.historicalPlacement,
      historicalBooyahCount: historical.historicalBooyahCount,
      historicalPoints: historical.historicalPoints,
      liveKills: live.liveKills,
      livePoints: live.livePoints,
      totalKills,
      totalPoints,
      matchesPlayed: historical.matchesPlayed,
      isPlaying: Boolean(liveIndex[teamId]),
      players: overallPlayers,
      player_stats: players,
      playerStats: players,
      player_pics: liveRaw.player_pics || rosterPlayers,
      playerPics: liveRaw.playerPics || rosterPlayers,
    };

    if (!live.liveRaw) return leaderboardFields;

    return {
      ...liveRaw,
      ...leaderboardFields,
      team_id: teamId,
      teamId,
      permanent_team_id: teamId,
      permanentTeamId: teamId,
      room_team_id: live.roomTeamId,
      roomTeamId: live.roomTeamId,
      team_name: leaderboardFields.teamName,
      short_tag: leaderboardFields.teamTag,
      team_logo: leaderboardFields.teamLogo,
      country_logo: leaderboardFields.countryLogo,
      full_team_banner: leaderboardFields.fullTeamBanner,
      notification_team_banner: leaderboardFields.notificationTeamBanner,
      booyah_banner: leaderboardFields.booyahBanner,
      booyah_image: leaderboardFields.booyahImage,
      teamTag: leaderboardFields.teamTag,
      teamLogo: leaderboardFields.teamLogo,
      countryLogo: leaderboardFields.countryLogo,
      fullTeamBanner: leaderboardFields.fullTeamBanner,
      notificationTeamBanner: leaderboardFields.notificationTeamBanner,
      booyahBanner: leaderboardFields.booyahBanner,
      booyahImage: leaderboardFields.booyahImage,
    };
  });

  rows.sort(
    (a, b) =>
      b.totalPoints - a.totalPoints ||
      b.totalKills - a.totalKills ||
      b.historicalBooyahCount - a.historicalBooyahCount ||
      a.teamName.localeCompare(b.teamName),
  );

  return rows.map((row, index) => ({
    ...row,
    rank: index + 1,
  }));
};

let matchResultsTableReady = false;

const ensureMatchResultsTable = async () => {
  if (matchResultsTableReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_results (
      id SERIAL PRIMARY KEY,
      match_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      team_name TEXT,
      team_tag TEXT,
      team_logo TEXT,
      country_logo TEXT,
      kills INTEGER NOT NULL DEFAULT 0,
      placement INTEGER NOT NULL DEFAULT 0,
      booyah_count INTEGER NOT NULL DEFAULT 0,
      total_kills INTEGER NOT NULL DEFAULT 0,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT match_results_match_team_unique UNIQUE (match_id, team_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_match_results_match_id
    ON match_results(match_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_match_results_team_id
    ON match_results(team_id);
  `);

  matchResultsTableReady = true;
};

const saveRealtimeResultsSnapshot = async (matchId, standings = {}) => {
  const teams = Array.isArray(standings.standings) ? standings.standings : [];
  if (!teams.length) {
    return { savedCount: 0, skippedCount: 0, booyahDetected: false };
  }

  const booyahDetected = teams.some(hasTeamBooyah);
  if (!booyahDetected || !teams.some(isFinalTeamResult)) {
    return { savedCount: 0, skippedCount: 0, booyahDetected: false };
  }

  await ensureMatchResultsTable();

  let savedCount = 0;
  let skippedCount = 0;

  for (const team of teams) {
    const roomTeamId = normalizeTeamIdKey(team.roomTeamId || team.room_team_id || getTeamId(team));
    const permanentTeamId = normalizeTeamIdKey(
      team.permanentTeamId || team.permanent_team_id || team.team_id || team.teamId,
    );

    if (
      !roomTeamId ||
      !permanentTeamId ||
      permanentTeamId === "-1" ||
      !team.mappingMatched
    ) {
      skippedCount += 1;
      continue;
    }

    const result = await pool.query(
      `
      INSERT INTO match_results (
        match_id,
        team_id,
        team_name,
        team_tag,
        team_logo,
        country_logo,
        kills,
        placement,
        booyah_count,
        total_kills,
        raw_payload,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
      ON CONFLICT (match_id, team_id) DO UPDATE
      SET
        team_name = EXCLUDED.team_name,
        team_tag = EXCLUDED.team_tag,
        team_logo = EXCLUDED.team_logo,
        country_logo = EXCLUDED.country_logo,
        kills = EXCLUDED.kills,
        placement = EXCLUDED.placement,
        booyah_count = EXCLUDED.booyah_count,
        total_kills = EXCLUDED.total_kills,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
      RETURNING *
      `,
      [
        matchId,
        permanentTeamId,
        getTeamName(team) || "",
        getTeamTag(team) || "",
        team.team_logo || team.teamLogo || "",
        team.country_logo || team.countryLogo || "",
        Math.trunc(getTeamKills(team)),
        Math.trunc(getTeamPlacementPoints(team)),
        hasTeamBooyah(team) ? 1 : 0,
        Math.trunc(getTeamResultScore(team)),
        JSON.stringify({
          ...team,
          roomTeamId,
          permanentTeamId,
          source: "realtime-booyah",
        }),
      ],
    );

    await saveMatchPlayers(
      pool,
      result.rows[0].id,
      matchId,
      permanentTeamId,
      getPlayersFromTeamPayload(team),
    );

    savedCount += 1;
  }

  return { savedCount, skippedCount, booyahDetected };
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

const formatRealtimePlayerStats = (stats, assetLookup = {}) => {
  const baseUrl = process.env.BASE_URL || "http://82.29.155.252:3000";

  if (Array.isArray(stats)) {
    return stats.map((player) => formatRealtimePlayer(player, baseUrl, assetLookup));
  }

  if (stats && typeof stats === "object") {
    return Object.fromEntries(
      Object.entries(stats).map(([key, player]) => [
        key,
        formatRealtimePlayer(player, baseUrl, assetLookup),
      ]),
    );
  }

  return stats;
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

const getPlayerMeta = (
  player,
  fallbackTeamIdKey,
  playerIndex = {},
  roomTeamMap = {},
) => {
  const playerTeamIdKey = normalizeTeamIdKey(getPlayerTeamId(player));
  const teamIdKey = playerTeamIdKey
    ? resolvePermanentTeamId(playerTeamIdKey, roomTeamMap)
    : fallbackTeamIdKey;
  const playerUidKey = normalizePlayerUidKey(getPlayerUid(player));

  if (!teamIdKey || !playerUidKey) return null;

  return playerIndex.byTeamAndUid?.[teamIdKey]?.[playerUidKey] || null;
};

const mergePlayerStat = (
  player,
  fallbackTeamIdKey,
  playerIndex = {},
  roomTeamMap = {},
) => {
  if (!player || typeof player !== "object") return player;

  const meta = getPlayerMeta(player, fallbackTeamIdKey, playerIndex, roomTeamMap);
  if (!meta) return player;

  const playerUid = getPlayerUid(player) || meta.playerUid;
  const roomTeamId = normalizeTeamIdKey(getPlayerTeamId(player));
  const resolvedTeamId = roomTeamId
    ? resolvePermanentTeamId(roomTeamId, roomTeamMap)
    : fallbackTeamIdKey;
  const playerName =
    meta.playerName || player.playerName || player.player_name || "";
  const cameraLink =
    meta.cameraLink || player.cameraLink || player.camera_link || "";
  const playerPic =
    meta.playerPic || player.playerPic || player.player_pic || "";

  return {
    ...player,
    room_team_id: roomTeamId || player.room_team_id,
    roomTeamId: roomTeamId || player.roomTeamId,
    team_id: resolvedTeamId,
    teamId: resolvedTeamId,
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

const mergePlayerStats = (
  stats,
  fallbackTeamIdKey,
  playerIndex = {},
  roomTeamMap = {},
) => {
  if (Array.isArray(stats)) {
    return stats.map((player) =>
      mergePlayerStat(player, fallbackTeamIdKey, playerIndex, roomTeamMap),
    );
  }

  if (stats && typeof stats === "object") {
    return Object.fromEntries(
      Object.entries(stats).map(([key, player]) => [
        key,
        mergePlayerStat(player, fallbackTeamIdKey, playerIndex, roomTeamMap),
      ]),
    );
  }

  return stats;
};

const filterPlayerStatsByTeam = (stats, roomTeamIdKey) => {
  if (!stats || !roomTeamIdKey) return undefined;

  const belongsToTeam = (player) =>
    normalizeTeamIdKey(getPlayerTeamId(player)) === roomTeamIdKey;

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
  roomTeamMap = {},
  assetLookup = {},
  bannerIndex = {},
  booyahAssetImage = "",
) => {
  if (!team) return {};

  /* ================= NORMALIZE TEAM ID ================= */
  const rawId = getTeamId(team);

  const roomTeamIdKey = normalizeTeamIdKey(rawId);
  const teamIdKey = resolvePermanentTeamId(roomTeamIdKey, roomTeamMap);

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
  const teamBanners = teamIdKey ? bannerIndex[teamIdKey] || {} : {};
  const fullTeamBanner = teamBanners.fullTeamBanner || "";
  const notificationTeamBanner = teamBanners.notificationTeamBanner || "";
  const booyahBanner = hasTeamBooyah(team) ? booyahAssetImage : "";

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
  const teamPlayerPics = Array.isArray(team?.player_pics)
    ? team.player_pics
    : Array.isArray(team?.playerPics)
      ? team.playerPics
      : [];
  const mergedPlayerPics = playerPics.length ? playerPics : teamPlayerPics;
  const teamPlayerStats =
    team.player_stats !== undefined
      ? team.player_stats
      : filterPlayerStatsByTeam(externalPlayerStats, roomTeamIdKey);
  const playerStats =
    teamPlayerStats !== undefined
      ? mergePlayerStats(teamPlayerStats, teamIdKey, playerIndex, roomTeamMap)
      : undefined;
  const playerStatsCamel =
    team.playerStats !== undefined
      ? mergePlayerStats(team.playerStats, teamIdKey, playerIndex, roomTeamMap)
      : undefined;

  /* ================= RETURN FINAL OBJECT ================= */
  const mergedTeam = {
    ...team,

    team_id: teamIdKey,
    teamId: teamIdKey,
    permanent_team_id: teamIdKey,
    permanentTeamId: teamIdKey,
    room_team_id: roomTeamIdKey,
    roomTeamId: roomTeamIdKey,

    team_name: finalTeamName,
    short_tag: finalShortTag,

    country_logo: finalCountryLogo,
    team_logo: finalTeamLogo,
    full_team_banner: fullTeamBanner,
    notification_team_banner: notificationTeamBanner,
    booyah_banner: booyahBanner,
    booyah_image: booyahBanner,

    // compatibility keys
    teamTag: finalShortTag,
    countryLogo: finalCountryLogo,
    teamLogo: finalTeamLogo,
    fullTeamBanner,
    notificationTeamBanner,
    booyahBanner,
    booyahImage: booyahBanner,

    player_pics: mergedPlayerPics,
    playerPics: mergedPlayerPics,

    player_stats: (team?.player_stats || []).map((stat) => {
      const matchedPlayer = mergedPlayerPics.find(
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
        team_id: teamIdKey,
        teamId: teamIdKey,
        permanent_team_id: teamIdKey,
        permanentTeamId: teamIdKey,
        room_team_id: roomTeamIdKey,
        roomTeamId: roomTeamIdKey,
        country_logo: finalCountryLogo,
        team_logo: finalTeamLogo,
        full_team_banner: fullTeamBanner,
        notification_team_banner: notificationTeamBanner,
        booyah_banner: booyahBanner,
        booyah_image: booyahBanner,
        fullTeamBanner,
        notificationTeamBanner,
        booyahBanner,
        booyahImage: booyahBanner,
        team_name: finalTeamName,
      };
    }),

    metaMatched: Boolean(teamIdKey && meta.team_id),
    mappingMatched: Boolean(roomTeamIdKey && roomTeamMap[roomTeamIdKey]),
  };

  if (playerStats !== undefined) {
    mergedTeam.player_stats = formatRealtimePlayerStats(playerStats, assetLookup);
  }
  if (playerStatsCamel !== undefined) {
    mergedTeam.playerStats = formatRealtimePlayerStats(playerStatsCamel, assetLookup);
  }
  mergedTeam.players = normalizePlayersList(mergedTeam.player_stats);

  return mergedTeam;
};

const buildStandings = async (id, logoCache = {}) => {
  const data = await fetchMatch(id);
  const metaIndex = await buildTeamMetaIndex();
  const roomTeamMap = await buildRoomTeamMappingIndex(id);
  const playerIndex = await buildPlayerIndex();
  const bannerIndex = await buildTeamBannerIndex();
  const booyahAssetImage = await getBooyahAssetImage();
  const assetLookup = await buildAssetLookup(
    pool,
    process.env.BASE_URL || "http://82.29.155.252:3000",
  );
  const externalPlayerStats = getPlayerStats(data);
  const teams = getTeams(data).map((team) =>
    mergeTeam(
      team,
      metaIndex,
      logoCache,
      playerIndex,
      externalPlayerStats,
      roomTeamMap,
      assetLookup,
      bannerIndex,
      booyahAssetImage,
    ),
  );
  const overallLeaderboard = await buildOverallLeaderboard(
    id,
    teams,
    playerIndex,
    bannerIndex,
  );

  return {
    matchId: id,
    roomTeamMap,
    standings: teams,
    overall: overallLeaderboard,
    overallLeaderboard,
    player_stats:
      externalPlayerStats !== undefined
        ? formatRealtimePlayerStats(
            mergePlayerStats(externalPlayerStats, "", playerIndex, roomTeamMap),
            assetLookup,
          )
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
      resultSaved: false,
      resultSaveInFlight: false,
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
router.getCachedStandings = (matchId) => matchCache[matchId]?.rawJsonData || null;
module.exports = router;
