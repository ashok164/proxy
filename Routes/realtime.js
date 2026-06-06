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
const { resolveTeamIdentities } = require("../Data/teamIdentityVerifier");
const {
  getTournamentIdFromRequest,
  hasExplicitTournamentSlug,
} = require("../Data/tournamentContext");

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;
const TARGET_IP = process.env.VPS_IP || "82.29.155.252";
const VPS_PROXY_BASE_URL =
  process.env.VPS_PROXY_BASE_URL ||
  (TARGET_IP ? `http://${TARGET_IP}:${process.env.VPS_PORT || process.env.PORT || 3000}` : "");

// ⚡ Global In-Memory RAM Cache to guarantee 0ms instant browser delivery
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

const fetchGarenaMatch = async (id) => {
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

const shouldUseVpsProxy = () =>
  !isIpValidOnMachine &&
  Boolean(VPS_PROXY_BASE_URL) &&
  String(process.env.USE_VPS_UPSTREAM_PROXY || "true").toLowerCase() !== "false";

const fetchMatch = async (id) => {
  if (shouldUseVpsProxy()) {
    const proxyUrl = `${VPS_PROXY_BASE_URL.replace(/\/$/, "")}/internal/garena-match/${encodeURIComponent(id)}`;
    const res = await axios.get(proxyUrl, { timeout: 7000 });
    return res.data?.data || res.data;
  }

  return fetchGarenaMatch(id);
};

const getUpstreamErrorStatus = (err) => err?.response?.status || null;

const formatUpstreamError = (err) => {
  const status = getUpstreamErrorStatus(err);
  const detail = err?.response?.data;
  const detailText =
    typeof detail === "string"
      ? detail
      : detail
        ? JSON.stringify(detail)
        : "";

  return [
    err.message,
    status ? `status=${status}` : "",
    detailText ? `body=${detailText.slice(0, 300)}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
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
    team.permanent_team_id,
    team.permanentTeamId,
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

const buildTeamMetaIndex = async (tournamentId = null) => {
  const index = {};

  try {
    const result = await pool.query(
      `SELECT team_id, permanent_team_id, team_name, short_tag, team_logo, country_logo
       FROM teams
       WHERE $1::integer IS NULL OR tournament_id = $1`,
      [tournamentId],
    );

    for (const meta of result.rows) {
      addMetaToIndex(index, meta);
    }
  } catch (err) {
    console.error("DB team metadata lookup failed:", err.message);
  }

  return index;
};

const getBooyahAssetImage = async (tournamentId = null) => {
  try {
    const result = await pool.query(
      `
      SELECT image_url
      FROM tournament_assets
      WHERE asset_id = $1 AND active = true AND ($2::integer IS NULL OR tournament_id = $2)
      ORDER BY id DESC
      LIMIT 1
      `,
      ["1", tournamentId],
    );

    return formatUploadUri(result.rows[0]?.image_url || "");
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) {
      console.error("Booyah tournament asset lookup failed:", err.message);
    }
    return "";
  }
};

const getChampionBannerImage = async (tournamentId = null) => {
  try {
    const result = await pool.query(
      `
      SELECT image_url
      FROM tournament_assets
      WHERE asset_id = $1 AND active = true AND ($2::integer IS NULL OR tournament_id = $2)
      ORDER BY id DESC
      LIMIT 1
      `,
      ["2", tournamentId],
    );

    return formatUploadUri(result.rows[0]?.image_url || "");
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) {
      console.error("Champion banner tournament asset lookup failed:", err.message);
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

const buildTeamBannerIndex = async (tournamentId = null) => {
  const index = {};

  try {
    const fullBannerResult = await pool.query(`
      SELECT team_id, image_url
      FROM full_team_banners
      WHERE active = true AND team_id IS NOT NULL AND team_id <> ''
        AND ($1::integer IS NULL OR tournament_id = $1)
      ORDER BY id DESC
    `, [tournamentId]);

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
        AND ($1::integer IS NULL OR tournament_id = $1)
      ORDER BY id DESC
    `, [tournamentId]);

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

const ensureTournamentSettingsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_settings (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER,
      overall_ranking_enabled BOOLEAN NOT NULL DEFAULT false,
      broadcast_theme_enabled BOOLEAN NOT NULL DEFAULT true,
      champion_rush_enabled BOOLEAN NOT NULL DEFAULT false,
      show_country_flags BOOLEAN NOT NULL DEFAULT false,
      show_live_standings_points BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE tournament_settings
    ADD COLUMN IF NOT EXISTS overall_ranking_enabled BOOLEAN NOT NULL DEFAULT false
  `);
  await pool.query(`
    ALTER TABLE tournament_settings
    ADD COLUMN IF NOT EXISTS broadcast_theme_enabled BOOLEAN NOT NULL DEFAULT true
  `);
  await pool.query(`
    ALTER TABLE tournament_settings
    ADD COLUMN IF NOT EXISTS champion_rush_enabled BOOLEAN NOT NULL DEFAULT false
  `);
  await pool.query(`
    ALTER TABLE tournament_settings
    ADD COLUMN IF NOT EXISTS show_country_flags BOOLEAN NOT NULL DEFAULT false
  `);
  await pool.query(`
    ALTER TABLE tournament_settings
    ADD COLUMN IF NOT EXISTS show_live_standings_points BOOLEAN NOT NULL DEFAULT false
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_settings_tournament_unique
    ON tournament_settings(tournament_id)
  `);
};

const toBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const clean = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(clean)) return true;
  if (["false", "0", "no", "off"].includes(clean)) return false;
  return fallback;
};

const getTournamentSettings = async (tournamentId = null) => {
  await ensureTournamentSettingsTable();
  const result = await pool.query(
    `
    INSERT INTO tournament_settings (tournament_id, updated_at)
    VALUES ($1, NOW())
    ON CONFLICT (tournament_id) DO UPDATE
    SET updated_at = tournament_settings.updated_at
    RETURNING
      overall_ranking_enabled,
      broadcast_theme_enabled,
      champion_rush_enabled,
      show_country_flags,
      show_live_standings_points
    `,
    [tournamentId],
  );

  const row = result.rows[0] || {};

  return {
    overallRankingEnabled: Boolean(row.overall_ranking_enabled),
    overall_ranking_enabled: Boolean(row.overall_ranking_enabled),
    broadcastThemeEnabled: Boolean(row.broadcast_theme_enabled),
    championRushEnabled: Boolean(row.champion_rush_enabled),
    showCountryFlags: Boolean(row.show_country_flags),
    showLiveStandingsPoints: Boolean(row.show_live_standings_points),
  };
};

const resolvePermanentTeamId = (roomTeamIdKey, roomTeamMap = {}) =>
  roomTeamMap[roomTeamIdKey] || "";

const buildHistoricalLeaderboardIndex = async (activeMatchId, tournamentId = null) => {
  const index = {};

  const result = await pool.query(
    `
    SELECT
      COALESCE(t.permanent_team_id, t.team_id) AS team_id,
      t.team_id AS display_team_id,
      t.team_name,
      t.short_tag,
      t.team_logo,
      t.country_logo,
      t.is_playing,
      COALESCE(SUM(mr.kills), 0) AS kills,
      COALESCE(SUM(mr.placement), 0) AS placement,
      COALESCE(SUM(mr.booyah_count), 0) AS booyah_count,
      COALESCE(SUM(mr.total_kills), 0) AS total_kills,
      COUNT(DISTINCT mr.match_id) FILTER (WHERE mr.match_id IS NOT NULL) AS matches_played
    FROM teams t
    LEFT JOIN match_results mr
      ON COALESCE(mr.permanent_team_id, mr.team_id) = COALESCE(t.permanent_team_id, t.team_id)
      AND mr.tournament_id = t.tournament_id
      AND mr.match_id <> $1
    WHERE $2::integer IS NULL OR t.tournament_id = $2
    GROUP BY
      COALESCE(t.permanent_team_id, t.team_id),
      t.team_id,
      t.team_name,
      t.short_tag,
      t.team_logo,
      t.country_logo,
      t.is_playing
    `,
    [activeMatchId, tournamentId],
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
      isPlaying: Boolean(row.is_playing),
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
  tournamentId = null,
  options = {},
) => {
  const historicalIndex = await buildHistoricalLeaderboardIndex(activeMatchId, tournamentId);
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
    ...Object.keys(liveIndex),
    ...Object.entries(historicalIndex)
      .filter(([, team]) => team.isPlaying)
      .map(([teamId]) => teamId),
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
      isPlaying: Boolean(liveIndex[teamId] || historical.isPlaying),
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
      permanent_team_id TEXT,
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
    ALTER TABLE match_results
    ADD COLUMN IF NOT EXISTS permanent_team_id TEXT;
  `);

  await pool.query(`
    UPDATE match_results
    SET permanent_team_id = team_id
    WHERE permanent_team_id IS NULL OR TRIM(permanent_team_id) = '';
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
      !team.identityMatched
    ) {
      skippedCount += 1;
      continue;
    }

    const result = await pool.query(
      `
      INSERT INTO match_results (
        match_id,
        team_id,
        permanent_team_id,
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
      VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
      ON CONFLICT (match_id, team_id) DO UPDATE
      SET
        permanent_team_id = EXCLUDED.permanent_team_id,
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

const compactRealtimePlayer = (player = {}) => ({
  account_id: firstValue(player.account_id, player.player_uid, player.playerUid, ""),
  nickname: firstValue(player.nickname, player.player_name, player.playerName, player.name, ""),
  player_state: firstValue(player.player_state, player.playerState, 0),
  be_killed_time: firstValue(player.be_killed_time, player.beKilledTime, 0),
  hp_info: {
    current_hp: firstValue(player.hp_info?.current_hp, player.hpInfo?.currentHp, 0),
    total_hp: firstValue(player.hp_info?.total_hp, player.hpInfo?.totalHp, 200),
  },
  player_image: firstValue(player.player_image, player.player_pic, player.playerPic, ""),
  camera_link: firstValue(player.camera_link, player.cameraLink, ""),
  character: player.character,
  active_skill: player.active_skill || player.activeSkill,
  weapon: player.weapon,
  pet: player.pet,
});

const compactRealtimeTeam = (team = {}) => {
  const players = normalizePlayersList(firstValue(team.player_stats, team.playerStats, team.players));

  return {
    team_id: firstValue(team.permanent_team_id, team.team_id, team.permanentTeamId, team.teamId, ""),
    room_team_id: firstValue(team.room_team_id, team.roomTeamId, ""),
    team_name: firstValue(team.team_name, team.teamName, team.name, ""),
    short_tag: firstValue(team.short_tag, team.teamTag, team.tag, ""),
    team_logo: firstValue(team.team_logo, team.teamLogo, ""),
    country_logo: firstValue(team.country_logo, team.countryLogo, ""),
    full_team_banner: firstValue(team.full_team_banner, team.fullTeamBanner, ""),
    notification_team_banner: firstValue(
      team.notification_team_banner,
      team.notificationTeamBanner,
      "",
    ),
    booyah_banner: firstValue(team.booyah_banner, team.booyah_image, team.booyahBanner, ""),
    rank: firstValue(team.rank, 0),
    killing_score: getTeamKills(team),
    ranking_score: getTeamPlacementPoints(team),
    live_kills: firstValue(team.liveKills, team.live_kills, getTeamKills(team)),
    live_points: firstValue(team.livePoints, team.live_points, getTeamLivePoints(team)),
    total_points: firstValue(team.totalPoints, team.total_points, getTeamResultScore(team)),
    historical_kills: firstValue(team.historicalKills, team.historical_kills, 0),
    historical_points: firstValue(team.historicalPoints, team.historical_points, 0),
    matches_played: firstValue(team.matchesPlayed, team.matches_played, 0),
    win_rate: firstValue(team.win_rate, team.winRate, team.winrate, 0),
    is_playing: firstValue(team.isPlaying, team.is_playing, players.length > 0),
    is_eliminated: Boolean(team.is_eliminated),
    identity_matched: Boolean(team.identityMatched || team.identity_matched),
    player_stats: players.map(compactRealtimePlayer),
  };
};

const normalizePlayerUidKey = (value) => String(value ?? "").trim();

const buildPlayerIndex = async (tournamentId = null) => {
  const index = {
    byTeam: {},
    byTeamAndUid: {},
  };

  try {
    const result = await pool.query(
      `SELECT id, team_id, player_uid, player_name, camera_link, player_pic
       FROM team_players
       WHERE $1::integer IS NULL OR tournament_id = $1
       ORDER BY id DESC`,
      [tournamentId],
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
  const booyahCount = getTeamBooyahCount(team);
  const booyahBanner = booyahCount > 0 ? booyahAssetImage : "";

  /* ================= FINAL MERGED VALUES ================= */
  const finalTeamName = dbTeamName || dbShortTag || "";

  const finalShortTag = dbShortTag || dbTeamName || "";

  let finalCountryLogo = dbCountryLogo ? formatImgUri(dbCountryLogo) : "";

  let finalTeamLogo = dbTeamLogo ? formatImgUri(dbTeamLogo) : "";

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
  const playerPicByUid = new Map(
    mergedPlayerPics
      .map((pic) => [
        String(firstValue(pic.player_uid, pic.playerUid, pic.account_id, "")),
        pic,
      ])
      .filter(([uid]) => uid),
  );
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
    booyah_count: booyahCount,
    booyah_banner: booyahBanner,
    booyah_image: booyahBanner,

    // compatibility keys
    teamTag: finalShortTag,
    countryLogo: finalCountryLogo,
    teamLogo: finalTeamLogo,
    fullTeamBanner,
    notificationTeamBanner,
    booyahCount,
    booyahBanner,
    booyahImage: booyahBanner,

    player_pics: mergedPlayerPics,
    playerPics: mergedPlayerPics,

    player_stats: (team?.player_stats || []).map((stat) => {
      const matchedPlayer = playerPicByUid.get(
        String(firstValue(stat.account_id, stat.player_uid, stat.playerUid, "")),
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
    identityMatched: Boolean(teamIdKey && meta.team_id),
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

const buildStandings = async (id, logoCache = {}, tournamentId = null) => {
  const data = await fetchMatch(id);
  const meta = await getRealtimeMeta(tournamentId);
  const {
    metaIndex,
    playerIndex,
    bannerIndex,
    booyahAssetImage,
    championBanner,
    assetLookup,
  } = meta;
  const externalPlayerStats = getPlayerStats(data);
  const rawTeams = getTeams(data);
  const settings = await getTournamentSettings(tournamentId);
  const activeChampionBanner = settings.championRushEnabled ? championBanner : "";
  const {
    roomTeamMap,
    corrections: teamIdentityMatches,
    detections: teamIdentityDetections,
  } = await resolveTeamIdentities(pool, {
    matchId: id,
    teams: rawTeams,
    getRoomTeamId: getTeamId,
    getPlayersFromTeam: (team) =>
      team.player_stats !== undefined
        ? team.player_stats
        : filterPlayerStatsByTeam(externalPlayerStats, normalizeTeamIdKey(getTeamId(team))),
    normalizeTeamId: normalizeTeamIdKey,
    tournamentId,
    playingOnly: true,
  });
  const teams = rawTeams
    .map((team) =>
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
    )
    .filter((team) => team.identityMatched);
  const overallLeaderboard = await buildOverallLeaderboard(
    id,
    teams,
    playerIndex,
    bannerIndex,
    tournamentId,
    settings,
  );
  const liveMatchStandings = teams.map(compactRealtimeTeam);
  const liveOverall = overallLeaderboard.map(compactRealtimeTeam);

  return {
    success: true,
    matchId: id,
    schema: "realtime.v2",
    settings,
    champion_banner: activeChampionBanner,
    teamIdentityMatches,
    teamIdentityDetections,
    liveStandings2: liveOverall,
    liveMatchStandings,
    liveOverall,
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

const buildLiveBroadcastPayload = (standings = {}) => ({
  success: true,
  schema: standings.schema || "realtime.v2",
  matchId: standings.matchId,
  settings: standings.settings || {},
  champion_banner: standings.champion_banner || "",
  teamIdentityMatches: standings.teamIdentityMatches || [],
  liveMatchStandings: standings.liveMatchStandings || [],
  liveOverall: standings.liveOverall || [],
});

const wantsFullRealtimePayload = (req) =>
  ["1", "true", "yes", "legacy"].includes(
    String(req.query?.full || req.query?.legacy || "").toLowerCase(),
  );

const buildHttpTableStandingsPayload = (standings = {}, req) => {
  if (wantsFullRealtimePayload(req)) return standings;
  return buildLiveBroadcastPayload(standings);
};

const getRealtimeMeta = async (tournamentId = null) => {
  const now = Date.now();
  const cacheKey = String(tournamentId || "default");
  const cachedData = realtimeMetaCache.data?.[cacheKey];
  if (cachedData && realtimeMetaCache.expiresAt > now) {
    return cachedData;
  }

  if (realtimeMetaCache.promise?.[cacheKey]) return realtimeMetaCache.promise[cacheKey];

  if (!realtimeMetaCache.promise || typeof realtimeMetaCache.promise.then === "function") {
    realtimeMetaCache.promise = {};
  }
  if (!realtimeMetaCache.data || typeof realtimeMetaCache.data.then === "function") {
    realtimeMetaCache.data = {};
  }

  realtimeMetaCache.promise[cacheKey] = Promise.all([
    buildTeamMetaIndex(tournamentId),
    buildPlayerIndex(tournamentId),
    buildTeamBannerIndex(tournamentId),
    getBooyahAssetImage(tournamentId),
    getChampionBannerImage(tournamentId),
    buildAssetLookup(pool, process.env.BASE_URL || "http://82.29.155.252:3000"),
  ])
    .then(([
      metaIndex,
      playerIndex,
      bannerIndex,
      booyahAssetImage,
      championBanner,
      assetLookup,
    ]) => {
      const data = {
        metaIndex,
        playerIndex,
        bannerIndex,
        booyahAssetImage,
        championBanner,
        assetLookup,
      };
      realtimeMetaCache.data[cacheKey] = data;
      realtimeMetaCache.expiresAt = Date.now() + getMetaCacheTtlMs();
      return data;
    })
    .finally(() => {
      if (realtimeMetaCache.promise) delete realtimeMetaCache.promise[cacheKey];
    });

  return realtimeMetaCache.promise[cacheKey];
};

/* ================= CENTRAL DATA STREAM ENGINE ================= */
const getMatchCacheKey = (matchId, tournamentId = null) =>
  `${tournamentId || "default"}:${matchId}`;

const startCentralEngine = (matchId, tournamentId = null) => {
  const cacheKey = getMatchCacheKey(matchId, tournamentId);

  if (!matchCache[cacheKey]) {
    matchCache[cacheKey] = {
      clients: new Set(),
      rawJsonData: null,
      latestFrame: null,
      logoCache: {},
      timerId: null,
      refreshing: false,
      lastActive: Date.now(),
      resultSaved: false,
      resultSaveInFlight: false,
    };
  }

  if (matchCache[cacheKey].timerId || matchCache[cacheKey].refreshing) return;

  console.log(
    `🌀 [ENGINE START] Initializing centralized data worker loop for Match ID: ${matchId}`,
  );

  const tick = async () => {
    const entry = matchCache[cacheKey];

    if (entry.clients.size === 0 && Date.now() - entry.lastActive > 30000) {
      console.log(
        `💤 [ENGINE SLEEP] Suspending central worker loop for inactive Match ID: ${matchId}`,
      );
      if (entry.timerId) clearTimeout(entry.timerId);
      entry.timerId = null;
      return;
    }

    entry.refreshing = true;
    entry.timerId = null;
    let retryDelayMs = getPushIntervalMs();

    try {
      const standings = await buildStandings(matchId, entry.logoCache, tournamentId);
      entry.rawJsonData = standings;

      const jsonString = JSON.stringify({
        type: "tablestandings",
        data: buildLiveBroadcastPayload(standings),
      });
      entry.latestFrame = frameWSFrame(jsonString);

      for (const socket of entry.clients) {
        if (socket.writable) {
          socket.write(entry.latestFrame);
        }
      }
    } catch (err) {
      const upstreamStatus = getUpstreamErrorStatus(err);
      if (upstreamStatus >= 400 && upstreamStatus < 500) {
        retryDelayMs = Math.max(5000, retryDelayMs);
      }
      console.error(
        `❌ Central Worker Loop Error [Match ID: ${matchId}]:`,
        formatUpstreamError(err),
      );
    } finally {
      entry.refreshing = false;
      entry.timerId = setTimeout(tick, retryDelayMs);
    }
  };

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
  // Supports /realtime/:matchId and /:tournamentSlug/realtime/:matchId.
  const match = url.match(
    /\/(?:(?<tournamentSlug>[a-z0-9][a-z0-9-]*)\/)?(?:ws\/)?(?<type>realtime|tablestandings)\/(?<matchId>[^/?#]+)/i,
  );
  if (!match) return null;
  return {
    type: match.groups.type,
    matchId: match.groups.matchId.trim(),
    tournamentSlug: match.groups.tournamentSlug,
  };
};

const handleWS = async (req, socket) => {
  const route = parseWS(req.url);
  if (!route || !route.matchId || route.matchId === "undefined") return false;

  const parsedUrl = new URL(req.url, "http://localhost");
  req.query = { ...(req.query || {}), ...Object.fromEntries(parsedUrl.searchParams.entries()) };
  if (route.tournamentSlug) {
    req.params = { ...(req.params || {}), tournamentSlug: route.tournamentSlug };
  }
  if (!hasExplicitTournamentSlug(req)) return false;

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
  const tournamentId = await getTournamentIdFromRequest(pool, req);
  const cacheKey = getMatchCacheKey(matchId, tournamentId);
  console.log(`🚀 Client joined WebSocket pool for Match ID: ${matchId}`);

  startCentralEngine(matchId, tournamentId);

  const entry = matchCache[cacheKey];
  entry.clients.add(socket);
  entry.lastActive = Date.now();

  if (entry.latestFrame && socket.writable) {
    socket.write(entry.latestFrame);
  }

  const cleanUp = () => {
    console.log(`🔌 Client disconnected from Match ID: ${matchId}`);
    if (matchCache[cacheKey]) {
      matchCache[cacheKey].clients.delete(socket);
    }
  };

  socket.on("close", cleanUp);
  socket.on("error", cleanUp);

  return true;
};

/* ================= HIGH SPEED BROWSER HTTP ENDPOINTS ================= */
router.get("/internal/garena-match/:matchId", async (req, res) => {
  try {
    const matchId = String(req.params.matchId || "").trim();
    if (!matchId) {
      return res
        .status(400)
        .json({ success: false, message: "matchId is required" });
    }

    const data = await fetchGarenaMatch(matchId);
    return res.json({ success: true, matchId, data });
  } catch (err) {
    console.error("Internal Garena match proxy failed:", formatUpstreamError(err));

    const status = err.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: err.response?.data?.message || err.message,
      data: err.response?.data,
    });
  }
});

router.get("/raw/:matchId", async (req, res) => {
  try {
    const matchId = String(req.params.matchId || "").trim();

    if (!matchId || matchId === "undefined") {
      return res
        .status(400)
        .json({ success: false, message: "matchId is required" });
    }

    const data = await fetchMatch(matchId);

    return res.json({
      success: true,
      type: "garena_raw",
      matchId,
      data,
    });
  } catch (err) {
    console.error("Raw Garena match fetch failed:", err.message);

    const status = err.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: err.response?.data?.message || err.message,
      data: err.response?.data,
    });
  }
});

router.get("/settings", async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const settings = await getTournamentSettings(tournamentId);
    return res.json({ success: true, data: settings });
  } catch (err) {
    console.error("Realtime settings fetch failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

const broadcastDisplaySettingsRoutes = [
  "/api/broadcast-display-settings",
  "/:tournamentSlug/api/broadcast-display-settings",
];

router.get(broadcastDisplaySettingsRoutes, async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const settings = await getTournamentSettings(tournamentId);
    return res.json({
      success: true,
      settings: {
        broadcastThemeEnabled: settings.broadcastThemeEnabled,
        championRushEnabled: settings.championRushEnabled,
        showCountryFlags: settings.showCountryFlags,
        showLiveStandingsPoints: settings.showLiveStandingsPoints,
      },
    });
  } catch (err) {
    console.error("Broadcast display settings fetch failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.patch(broadcastDisplaySettingsRoutes, async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    await ensureTournamentSettingsTable();

    const current = await getTournamentSettings(tournamentId);
    const input = req.body?.settings || req.body || {};
    const next = {
      broadcastThemeEnabled: toBoolean(
        input.broadcastThemeEnabled ?? input.broadcast_theme_enabled,
        current.broadcastThemeEnabled,
      ),
      championRushEnabled: toBoolean(
        input.championRushEnabled ?? input.champion_rush_enabled,
        current.championRushEnabled,
      ),
      showCountryFlags: toBoolean(
        input.showCountryFlags ?? input.show_country_flags,
        current.showCountryFlags,
      ),
      showLiveStandingsPoints: toBoolean(
        input.showLiveStandingsPoints ?? input.show_live_standings_points,
        current.showLiveStandingsPoints,
      ),
    };

    const result = await pool.query(
      `
      INSERT INTO tournament_settings (
        tournament_id,
        broadcast_theme_enabled,
        champion_rush_enabled,
        show_country_flags,
        show_live_standings_points,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (tournament_id) DO UPDATE
      SET broadcast_theme_enabled = EXCLUDED.broadcast_theme_enabled,
          champion_rush_enabled = EXCLUDED.champion_rush_enabled,
          show_country_flags = EXCLUDED.show_country_flags,
          show_live_standings_points = EXCLUDED.show_live_standings_points,
          updated_at = NOW()
      RETURNING
        broadcast_theme_enabled,
        champion_rush_enabled,
        show_country_flags,
        show_live_standings_points
      `,
      [
        tournamentId,
        next.broadcastThemeEnabled,
        next.championRushEnabled,
        next.showCountryFlags,
        next.showLiveStandingsPoints,
      ],
    );
    const row = result.rows[0] || {};

    return res.json({
      success: true,
      settings: {
        broadcastThemeEnabled: Boolean(row.broadcast_theme_enabled),
        championRushEnabled: Boolean(row.champion_rush_enabled),
        showCountryFlags: Boolean(row.show_country_flags),
        showLiveStandingsPoints: Boolean(row.show_live_standings_points),
      },
    });
  } catch (err) {
    console.error("Broadcast display settings update failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/settings", async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    await ensureTournamentSettingsTable();
    const overallRankingEnabled = toBoolean(
      req.body.overallRankingEnabled ?? req.body.overall_ranking_enabled,
      false,
    );
    const result = await pool.query(
      `
      INSERT INTO tournament_settings (tournament_id, overall_ranking_enabled, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (tournament_id) DO UPDATE
      SET overall_ranking_enabled = EXCLUDED.overall_ranking_enabled,
          updated_at = NOW()
      RETURNING overall_ranking_enabled
      `,
      [tournamentId, overallRankingEnabled],
    );
    const enabled = Boolean(result.rows[0]?.overall_ranking_enabled);
    return res.json({
      success: true,
      data: {
        overallRankingEnabled: enabled,
        overall_ranking_enabled: enabled,
      },
    });
  } catch (err) {
    console.error("Realtime settings update failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get(
  [
    "/ws/realtime/:matchId",
    "/realtime/:matchId",
    "/tablestandings/:matchId",
    "/:tournamentSlug/ws/realtime/:matchId",
    "/:tournamentSlug/realtime/:matchId",
    "/:tournamentSlug/tablestandings/:matchId",
  ],
  async (req, res) => {
    try {
      const matchId = req.params.matchId;
      if (!hasExplicitTournamentSlug(req)) {
        return res.status(400).json({
          success: false,
          message: "Tournament slug is required for realtime table views",
        });
      }

      const tournamentId = await getTournamentIdFromRequest(pool, req);
      const cacheKey = getMatchCacheKey(matchId, tournamentId);

      if (matchCache[cacheKey]) {
        matchCache[cacheKey].lastActive = Date.now();
        if (matchCache[cacheKey].rawJsonData) {
          return res.json({
            success: true,
            type: "tablestandings_cached",
            data: buildHttpTableStandingsPayload(matchCache[cacheKey].rawJsonData, req),
          });
        }
      }

      console.log(
        `🌐 Cache miss. Instantiating live polling engine for Match: ${matchId}`,
      );
      startCentralEngine(matchId, tournamentId);

      const standingsData = await buildStandings(
        matchId,
        matchCache[cacheKey]?.logoCache || {},
        tournamentId,
      );
      if (false && matchCache[cacheKey]) {
        matchCache[cacheKey].rawJsonData = standingsData;
        matchCache[cacheKey].latestFrame = frameWSFrame(
          JSON.stringify({
            type: "tablestandings",
            data: buildLiveBroadcastPayload(standingsData),
          }),
        );
      }
      return res.json({
        success: true,
        type: "tablestandings_static",
        data: buildHttpTableStandingsPayload(standingsData, req),
      });
    } catch (err) {
      console.error("❌ Browser HTTP GET Endpoint Error:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  },
);

router.handleRealtimeWebSocket = handleWS;
router.getCachedStandings = (matchId, tournamentId = null) =>
  matchCache[getMatchCacheKey(matchId, tournamentId)]?.rawJsonData || null;
module.exports = router;
