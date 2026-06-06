const express = require("express");
const axios = require("axios");
const https = require("https");
const os = require("os");

const pool = require("../Database/db");
const realtimeRoutes = require("./realtime");
const {
  ensureMatchMetadataTables,
  getPlayersFromTeamPayload,
  loadPlayersForMatchResults,
  saveMatchPlayers,
} = require("../Data/matchMetadata");
const { resolveTeamIdentities } = require("../Data/teamIdentityVerifier");
const {
  ensureTournamentColumn,
  getTournamentIdFromRequest,
} = require("../Data/tournamentContext");

const router = express.Router({ mergeParams: true });

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;
const TARGET_IP = process.env.VPS_IP || "82.29.155.252";

const getBaseUrl = (req) => `${req.protocol}://${req.get("host")}`;

const toNullableString = (value) => {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean === "" ? null : clean;
};

const toInteger = (value, fallback = 0) => {
  if (value === undefined || value === null || value === "") return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : fallback;
};

const normalizeTeamId = (value) => {
  const clean = String(value ?? "").trim();
  if (!/^\d+$/.test(clean)) return clean;

  const numberValue = Number(clean);
  return Number.isSafeInteger(numberValue) ? String(numberValue) : clean;
};

const getBodyValue = (body, ...names) => {
  for (const name of names) {
    if (body[name] !== undefined) return body[name];
  }

  const lowerNameMap = Object.keys(body || {}).reduce((acc, key) => {
    acc[key.toLowerCase()] = key;
    return acc;
  }, {});

  for (const name of names) {
    const actualKey = lowerNameMap[String(name).toLowerCase()];
    if (actualKey && body[actualKey] !== undefined) return body[actualKey];
  }

  return undefined;
};

const firstValue = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== "");

const checkLocalIpAvailability = (targetIp) => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.address === targetIp) return true;
    }
  }
  return false;
};

const staticIpAgent = checkLocalIpAvailability(TARGET_IP)
  ? new https.Agent({ localAddress: TARGET_IP })
  : null;

const getHeaders = () => ({
  "Client-ID": CLIENT_ID,
});

const fetchRealtimeMatch = async (matchId) => {
  const config = {
    headers: getHeaders(),
    timeout: 5000,
  };

  if (staticIpAgent) {
    config.httpsAgent = staticIpAgent;
  }

  const response = await axios.get(`${API_URL}/${matchId}`, config);

  return response.data;
};

const fetchCachedWebsocketMatch = (matchId, tournamentId = null) =>
  realtimeRoutes.getCachedStandings?.(matchId, tournamentId);

const getRealtimeTeams = (data) =>
  data?.data?.standings ||
  data?.standings ||
  (Array.isArray(data?.match_stats)
    ? data.match_stats.flatMap((match) => match?.team_stats || [])
    : null) ||
  data?.match?.team_stats ||
  data?.team_stats ||
  data?.teams ||
  [];

const getRealtimePlayerStats = (data) =>
  data?.match?.player_stats ||
  data?.player_stats ||
  data?.players ||
  (Array.isArray(data?.match_stats)
    ? data.match_stats.flatMap((match) =>
        (match?.team_stats || []).flatMap((team) => team?.player_stats || []),
      )
    : undefined);

const getRealtimeTeamId = (team = {}) =>
  firstValue(
    team.team_id,
    team.id,
    team.teamId,
    team.team_uid,
    team.teamUid,
    team.teamCode,
  );

const getRealtimePlayerTeamId = (player = {}) =>
  firstValue(
    player.team_id,
    player.teamId,
    player.team_uid,
    player.teamUid,
    player.teamCode,
  );

const normalizePlayersList = (players) => {
  if (Array.isArray(players)) return players;
  if (players && typeof players === "object") return Object.values(players);
  return [];
};

const filterRealtimePlayerStatsByTeam = (stats, roomTeamId) => {
  if (!stats || !roomTeamId) return undefined;

  const belongsToTeam = (player) =>
    normalizeTeamId(getRealtimePlayerTeamId(player)) === roomTeamId;

  if (Array.isArray(stats)) return stats.filter(belongsToTeam);

  if (typeof stats === "object") {
    return Object.fromEntries(
      Object.entries(stats).filter(([, player]) => belongsToTeam(player)),
    );
  }

  return undefined;
};

const getRealtimeTeamName = (team = {}) =>
  firstValue(team.team_name, team.teamName, team.name, team.team, team.title);

const getRealtimeTeamTag = (team = {}) =>
  firstValue(
    team.short_tag,
    team.team_tag,
    team.teamTag,
    team.shortTag,
    team.tag,
    team.shortName,
  );

const getRealtimeKills = (team = {}) =>
  toInteger(
    firstValue(
      team.killing_score,
      team.killingScore,
      team.kill_count,
      team.killCount,
      team.kill_score,
      team.killScore,
      team.kills,
      team.total_kills,
      team.totalKills,
      team.team_kills,
      team.teamKills,
    ),
  );

const getRealtimePlacementPoints = (team = {}) =>
  toInteger(
    firstValue(
      team.placement,
      team.placement_points,
      team.placementPoints,
      team.survival_score,
      team.ranking_score,
      team.rankingScore,
    ),
  );

const getRealtimeTotalScore = (team = {}) => {
  const explicitScore = firstValue(
      team.total_score,
      team.totalScore,
      team.total_points,
      team.totalPoints,
      team.final_score,
      team.finalScore,
      team.score,
      team.points,
  );

  if (explicitScore !== undefined && explicitScore !== null && explicitScore !== "") {
    return toInteger(explicitScore);
  }

  return getRealtimeKills(team) + getRealtimePlacementPoints(team);
};

const hasRealtimeBooyah = (team = {}) => {
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

const getRealtimeBooyahCount = (team = {}) => {
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

    return Math.max(0, toInteger(explicitValue));
  }

  return hasRealtimeBooyah(team) ? 1 : 0;
};

const getStoredBooyahCount = (row = {}) => {
  const storedCount = toInteger(row.booyah_count);
  return storedCount > 0 ? storedCount : getRealtimeBooyahCount(row.raw_payload || {});
};

const BOOYAH_COUNT_SQL = `
  CASE
    WHEN booyah_count > 0 THEN booyah_count
    WHEN (raw_payload->>'booyah_count') ~ '^[0-9]+$' THEN (raw_payload->>'booyah_count')::integer
    WHEN (raw_payload->>'booyahCount') ~ '^[0-9]+$' THEN (raw_payload->>'booyahCount')::integer
    WHEN (raw_payload->>'booyah_counter') ~ '^[0-9]+$' THEN (raw_payload->>'booyah_counter')::integer
    WHEN (raw_payload->>'booyahCounter') ~ '^[0-9]+$' THEN (raw_payload->>'booyahCounter')::integer
    WHEN LOWER(COALESCE(raw_payload->>'booyah', raw_payload->>'is_booyah', raw_payload->>'isBooyah', raw_payload->>'winner', raw_payload->>'isWinner', raw_payload->>'is_winner', '')) IN ('true', '1', 'yes', 'y', 'win', 'winner', 'booyah') THEN 1
    ELSE 0
  END
`;

const isRealtimeFinal = (team = {}) => {
  const value = firstValue(team.final, team.is_final, team.isFinal);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return ["true", "1", "yes", "y", "final"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
};

const formatImageUrl = (baseUrl, logoPath) => {
  if (!logoPath) return "";
  if (logoPath.startsWith("http://") || logoPath.startsWith("https://")) {
    return logoPath;
  }

  return `${baseUrl}/uploads/${logoPath.replace(/^\/?uploads\//i, "")}`;
};

const getBooyahAssetImage = async (baseUrl, tournamentId) => {
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

    return formatImageUrl(baseUrl, result.rows[0]?.image_url || "");
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) {
      console.error("Booyah tournament asset lookup failed:", err.message);
    }
    return "";
  }
};

const isChampionRushEnabled = async (tournamentId) => {
  try {
    const result = await pool.query(
      `
      SELECT champion_rush_enabled
      FROM tournament_settings
      WHERE ($1::integer IS NULL AND tournament_id IS NULL) OR tournament_id = $1
      LIMIT 1
      `,
      [tournamentId],
    );

    return Boolean(result.rows[0]?.champion_rush_enabled);
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) {
      console.error("Champion Rush setting lookup failed:", err.message);
    }
    return false;
  }
};

const getChampionBannerImage = async (baseUrl, tournamentId) => {
  const championRushEnabled = await isChampionRushEnabled(tournamentId);
  if (!championRushEnabled) return "";

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

    return formatImageUrl(baseUrl, result.rows[0]?.image_url || "");
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) {
      console.error("Champion banner tournament asset lookup failed:", err.message);
    }
    return "";
  }
};

const addBannerToIndex = (index, row, key, baseUrl) => {
  const teamId = normalizeTeamId(row.team_id);
  if (!teamId || !row.image_url) return;

  if (!index[teamId]) index[teamId] = {};
  if (index[teamId][key]) return;
  index[teamId][key] = formatImageUrl(baseUrl, row.image_url);
};

const buildTeamBannerIndex = async (baseUrl, tournamentId) => {
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
      addBannerToIndex(index, row, "fullTeamBanner", baseUrl);
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
      addBannerToIndex(index, row, "notificationTeamBanner", baseUrl);
    }
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) {
      console.error("Notification team banner lookup failed:", err.message);
    }
  }

  return index;
};

let matchResultsTableReady = false;

const ensureMatchResultsTable = async () => {
  if (matchResultsTableReady) {
    await ensureMatchMetadataTables(pool);
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_results (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER,
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
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await ensureTournamentColumn(pool, "match_results");
  await pool.query("ALTER TABLE match_results DROP CONSTRAINT IF EXISTS match_results_match_team_unique");
  await pool.query("DROP INDEX IF EXISTS idx_match_results_match_team_unique");

  await pool.query(`
    ALTER TABLE match_results
    ADD COLUMN IF NOT EXISTS permanent_team_id TEXT
  `);
  await pool.query(`
    UPDATE match_results
    SET permanent_team_id = team_id
    WHERE permanent_team_id IS NULL OR TRIM(permanent_team_id) = ''
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_match_results_match_id
    ON match_results(match_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_match_results_team_id
    ON match_results(team_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_match_results_permanent_team_id
    ON match_results(permanent_team_id);
  `);

  await pool.query(`
    DELETE FROM match_results mr
    USING match_results duplicate
      WHERE
      mr.tournament_id = duplicate.tournament_id
      AND mr.match_id = duplicate.match_id
      AND mr.team_id = duplicate.team_id
      AND mr.id < duplicate.id;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_match_results_tournament_match_team_unique
    ON match_results(tournament_id, match_id, team_id);
  `);

  matchResultsTableReady = true;
  await ensureMatchMetadataTables(pool);
};

const normalizeStandingsPayload = (body) => {
  const standings = Array.isArray(body?.data?.standings)
    ? body.data.standings
    : Array.isArray(body?.standings)
      ? body.standings
      : null;

  if (!standings) return null;

  const matchId = toNullableString(
    getBodyValue(body?.data || {}, "matchId", "match_id", "matchID") ||
      getBodyValue(body || {}, "matchId", "match_id", "matchID"),
  );

  return standings.map((team) => ({
    ...team,
    matchId: getBodyValue(team, "matchId", "match_id", "matchID") || matchId,
  }));
};

const normalizeResultsPayload = (body) => {
  if (Array.isArray(body)) return body;
  const standingsRecords = normalizeStandingsPayload(body);
  if (standingsRecords) return standingsRecords;
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.data)) return body.data;
  if (body && typeof body === "object") return [body];
  return [];
};

const normalizeMatchIdsPayload = (body) => {
  const value = Array.isArray(body)
    ? body
    : body?.matchIds || body?.match_ids || body?.matchId || body?.match_id;

  if (Array.isArray(value)) {
    return value.map(toNullableString).filter(Boolean);
  }

  if (value !== undefined && value !== null) {
    return String(value)
      .split(",")
      .map(toNullableString)
      .filter(Boolean);
  }

  return [];
};

const normalizeResult = (input) => {
  const matchId = toNullableString(
    getBodyValue(input, "matchIds", "matchId", "match_id", "matchID"),
  );
  const teamId = normalizeTeamId(
    getBodyValue(input, "teamId", "team_id", "teamID"),
  );

  const kills = toInteger(
    getBodyValue(input, "kills", "killing_score", "killingScore", "kill_count", "killCount"),
  );
  const placement = toInteger(
    getBodyValue(input, "placement", "ranking_score", "rankingScore"),
  );
  const explicitTotalKills = getBodyValue(input, "totalKills", "total_kills", "totalScore", "total_score");

  return {
    matchId,
    teamId: toNullableString(teamId),
    teamName: toNullableString(getBodyValue(input, "teamName", "team_name")),
    teamTag: toNullableString(
      getBodyValue(input, "teamTag", "team_tag", "shortTag", "short_tag"),
    ),
    teamLogo: toNullableString(getBodyValue(input, "teamLogo", "team_logo")),
    countryLogo: toNullableString(
      getBodyValue(input, "countryLogo", "country_logo"),
    ),
    kills,
    placement,
    booyahCount: getRealtimeBooyahCount(input),
    totalKills:
      explicitTotalKills !== undefined
        ? toInteger(explicitTotalKills)
        : kills + placement,
    rawPayload: input,
  };
};

const saveRealtimeResultsForMatch = async (matchId, tournamentId = null) => {
  await ensureMatchResultsTable();
  await ensureTournamentColumn(pool, "match_results");
  await ensureTournamentColumn(pool, "match_result_players");

  const cachedPayload = fetchCachedWebsocketMatch(matchId, tournamentId);
  const payload = cachedPayload || (await fetchRealtimeMatch(matchId));
  const source = cachedPayload ? "websocket-cache" : "realtime";
  const teams = getRealtimeTeams(payload);
  const externalPlayerStats = getRealtimePlayerStats(payload);

  if (!teams.length) {
    return {
      matchId,
      savedRows: [],
      skippedRows: [],
      booyahDetected: false,
    };
  }

  const booyahDetected = teams.some(hasRealtimeBooyah);
  const finalDetected = teams.some(isRealtimeFinal);
  if (!booyahDetected || !finalDetected) {
    return {
      matchId,
      savedRows: [],
      skippedRows: [],
      booyahDetected: false,
      finalDetected,
    };
  }

  const savedRows = [];
  const skippedRows = [];
  const verification = await resolveTeamIdentities(pool, {
    matchId,
    teams,
    getRoomTeamId: getRealtimeTeamId,
    getPlayersFromTeam: (team) =>
      team.player_stats !== undefined
        ? team.player_stats
        : filterRealtimePlayerStatsByTeam(
            externalPlayerStats,
            normalizeTeamId(getRealtimeTeamId(team)),
          ),
    normalizeTeamId,
    tournamentId,
    playingOnly: true,
  });
  const verifiedRoomTeamMap = verification.roomTeamMap || {};

  for (const team of teams) {
    const roomTeamId = normalizeTeamId(getRealtimeTeamId(team));
    if (!roomTeamId) {
      skippedRows.push({ roomTeamId: "", reason: "Missing realtime room team id", team });
      continue;
    }

    const permanentTeamId =
      verifiedRoomTeamMap[roomTeamId];
    if (!permanentTeamId || permanentTeamId === "-1") {
      skippedRows.push({
        roomTeamId,
        reason: "Room team id is not mapped to a permanent team",
        team,
      });
      continue;
    }

    const teamResult = await pool.query(
      `
      SELECT team_name, short_tag, team_logo, country_logo
      FROM teams
      WHERE COALESCE(permanent_team_id, team_id) = $1 AND ($2::integer IS NULL OR tournament_id = $2)
      LIMIT 1
      `,
      [permanentTeamId, tournamentId],
    );
    const teamMeta = teamResult.rows[0] || {};
    const kills = getRealtimeKills(team);
    const placement = getRealtimePlacementPoints(team);
    const booyahCount = getRealtimeBooyahCount(team);
    const totalKills = getRealtimeTotalScore(team);
    const teamName = teamMeta.team_name || getRealtimeTeamName(team) || "";
    const teamTag = teamMeta.short_tag || getRealtimeTeamTag(team) || "";
    const teamLogo =
      teamMeta.team_logo || firstValue(team.team_logo, team.teamLogo, team.logo) || "";
    const countryLogo =
      teamMeta.country_logo || firstValue(team.country_logo, team.countryLogo, team.flag) || "";

    const result = await pool.query(
      `
      INSERT INTO match_results (
        tournament_id,
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
      VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())
      ON CONFLICT (tournament_id, match_id, team_id) DO UPDATE
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
        tournamentId,
        matchId,
        permanentTeamId,
        teamName,
        teamTag,
        teamLogo,
        countryLogo,
        kills,
        placement,
        booyahCount,
        totalKills,
        JSON.stringify({
          ...team,
          roomTeamId,
          permanentTeamId,
          source,
          teamIdentityMatches: verification.corrections,
        }),
      ],
    );

    const savedRow = result.rows[0];
    await saveMatchPlayers(
      pool,
      savedRow.id,
      matchId,
      permanentTeamId,
      getPlayersFromTeamPayload(team),
      tournamentId,
    );

    savedRows.push(savedRow);
  }

  return {
    matchId,
    savedRows,
    skippedRows,
    booyahDetected,
    finalDetected,
    teamIdentityMatches: verification.corrections,
  };
};

const getBooyahImageForCount = (booyahCount, booyahAssetImage) =>
  Number(booyahCount) > 0 ? booyahAssetImage : "";

const getTeamBanners = (bannerIndex, teamId) =>
  bannerIndex[normalizeTeamId(teamId)] || {};

const formatResultRow = (
  row,
  baseUrl,
  booyahAssetImage = "",
  bannerIndex = {},
) => {
  const teamBanners = getTeamBanners(bannerIndex, row.team_id);
  const fullTeamBanner = teamBanners.fullTeamBanner || "";
  const notificationTeamBanner = teamBanners.notificationTeamBanner || "";
  const booyahCount = getStoredBooyahCount(row);

  return {
  id: row.id,
  matchId: row.match_id,
  teamId: row.team_id,
  permanentTeamId: row.permanent_team_id || row.team_id,
  permanent_team_id: row.permanent_team_id || row.team_id,
  teamLogo: formatImageUrl(baseUrl, row.team_logo),
  countryLogo: formatImageUrl(baseUrl, row.country_logo),
  teamName: row.team_name || "",
  teamTag: row.team_tag || "",
  kills: row.kills,
  placement: row.placement,
  booyahCount,
  booyah_count: booyahCount,
  wins: booyahCount,
  booyah_banner: getBooyahImageForCount(booyahCount, booyahAssetImage),
  booyah_image: getBooyahImageForCount(booyahCount, booyahAssetImage),
  full_team_banner: fullTeamBanner,
  notification_team_banner: notificationTeamBanner,
  booyahBanner: getBooyahImageForCount(booyahCount, booyahAssetImage),
  booyahImage: getBooyahImageForCount(booyahCount, booyahAssetImage),
  fullTeamBanner,
  notificationTeamBanner,
  totalKills: row.total_kills,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  };
};

const formatResultRowWithPlayers = (
  row,
  baseUrl,
  playersByResult = {},
  booyahAssetImage = "",
  bannerIndex = {},
) => {
  const formattedRow = formatResultRow(
    row,
    baseUrl,
    booyahAssetImage,
    bannerIndex,
  );

  return {
    ...formattedRow,
    players: (playersByResult[row.id] || []).map((player) => ({
      ...player,
      teamTag: formattedRow.teamTag,
      full_team_banner: formattedRow.full_team_banner,
      notification_team_banner: formattedRow.notification_team_banner,
      fullTeamBanner: formattedRow.fullTeamBanner,
      notificationTeamBanner: formattedRow.notificationTeamBanner,
    })),
  };
};

const formatAggregateRow = (
  row,
  baseUrl,
  playersByTeam = {},
  booyahAssetImage = "",
  bannerIndex = {},
) => {
  const teamBanners = getTeamBanners(bannerIndex, row.team_id);
  const fullTeamBanner = teamBanners.fullTeamBanner || "";
  const notificationTeamBanner = teamBanners.notificationTeamBanner || "";
  const booyahCount = Number(row.booyah_count || 0);

  return {
  teamId: row.team_id,
  permanentTeamId: row.permanent_team_id || row.team_id,
  permanent_team_id: row.permanent_team_id || row.team_id,
  teamLogo: formatImageUrl(baseUrl, row.team_logo),
  countryLogo: formatImageUrl(baseUrl, row.country_logo),
  teamName: row.team_name || "",
  teamTag: row.team_tag || "",
  kills: Number(row.kills),
  placement: Number(row.placement),
  booyahCount,
  booyah_count: booyahCount,
  wins: booyahCount,
  booyah_banner: getBooyahImageForCount(booyahCount, booyahAssetImage),
  booyah_image: getBooyahImageForCount(booyahCount, booyahAssetImage),
  full_team_banner: fullTeamBanner,
  notification_team_banner: notificationTeamBanner,
  booyahBanner: getBooyahImageForCount(booyahCount, booyahAssetImage),
  booyahImage: getBooyahImageForCount(booyahCount, booyahAssetImage),
  fullTeamBanner,
  notificationTeamBanner,
  totalKills: Number(row.total_kills),
  totalPoints: Number(row.total_kills),
  totalScore: Number(row.total_kills),
  matchesPlayed: Number(row.matches_played),
  played: Number(row.matches_played),
  players: playersByTeam[row.team_id] || [],
  };
};

const buildOverallPlayersByTeam = (rows = []) => {
  const playersByTeam = {};

  for (const row of rows) {
    const teamId = row.teamId || row.team_id;
    if (!playersByTeam[teamId]) playersByTeam[teamId] = {};

    for (const player of row.players || []) {
      const playerKey = player.player_id || player.player_name;
      if (!playerKey) continue;

      if (!playersByTeam[teamId][playerKey]) {
        playersByTeam[teamId][playerKey] = {
          ...player,
          kills: 0,
          damage: 0,
          assists: 0,
          knockdowns: 0,
          survival_time: 0,
          matchesPlayed: 0,
          matchIds: [],
        };
      }

      const aggregate = playersByTeam[teamId][playerKey];
      aggregate.kills += Number(player.kills || 0);
      aggregate.damage += Number(player.damage || 0);
      aggregate.assists += Number(player.assists || 0);
      aggregate.knockdowns += Number(player.knockdowns || 0);
      aggregate.survival_time += Number(player.survival_time || 0);
      aggregate.matchesPlayed += 1;
      aggregate.matchIds.push(row.matchId || row.match_id);
    }
  }

  return Object.fromEntries(
    Object.entries(playersByTeam).map(([teamId, players]) => [
      teamId,
      Object.values(players).sort(
        (left, right) =>
          right.kills - left.kills ||
          right.damage - left.damage ||
          right.assists - left.assists ||
          right.knockdowns - left.knockdowns ||
          left.player_name.localeCompare(right.player_name),
      ),
    ]),
  );
};

const queryMatchResults = async (matchIds, tournamentId) => {
  const uniqueMatchIds = Array.from(
    new Set((matchIds || []).map((matchId) => String(matchId || "").trim()).filter(Boolean)),
  );
  const rowsResult = await pool.query(
    `
    SELECT *
    FROM match_results
    WHERE match_id = ANY($1::text[]) AND tournament_id = $2
    ORDER BY
      total_kills DESC,
      kills DESC,
      booyah_count DESC,
      placement DESC,
      team_name ASC
    `,
    [uniqueMatchIds, tournamentId],
  );

  const aggregateResult = await pool.query(
    `
    SELECT
      COALESCE(permanent_team_id, team_id) AS permanent_team_id,
      COALESCE(permanent_team_id, team_id) AS team_id,
      COALESCE(MAX(NULLIF(team_logo, '')), '') AS team_logo,
      COALESCE(MAX(NULLIF(country_logo, '')), '') AS country_logo,
      COALESCE(MAX(NULLIF(team_name, '')), '') AS team_name,
      COALESCE(MAX(NULLIF(team_tag, '')), '') AS team_tag,
      SUM(kills) AS kills,
      SUM(placement) AS placement,
      SUM(${BOOYAH_COUNT_SQL}) AS booyah_count,
      SUM(total_kills) AS total_kills,
      COUNT(DISTINCT match_id) AS matches_played
    FROM match_results
    WHERE match_id = ANY($1::text[]) AND tournament_id = $2
    GROUP BY COALESCE(permanent_team_id, team_id)
    ORDER BY
      SUM(total_kills) DESC,
      SUM(kills) DESC,
      SUM(${BOOYAH_COUNT_SQL}) DESC,
      SUM(placement) DESC,
      COALESCE(MAX(NULLIF(team_name, '')), '') ASC
    `,
    [uniqueMatchIds, tournamentId],
  );

  return {
    rows: rowsResult.rows,
    overall: aggregateResult.rows,
  };
};

router.post("/create", async (req, res) => {
    try {
    await ensureMatchResultsTable();
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    const records = normalizeResultsPayload(req.body).map(normalizeResult);
    if (!records.length) {
      return res.status(400).json({
        success: false,
        message: "Request body must contain at least one result object",
      });
    }

    const invalidRecord = records.find((record) => !record.matchId || !record.teamId);
    if (invalidRecord) {
      return res.status(400).json({
        success: false,
        message: "Each result must include matchId/matchIds and teamId",
      });
    }

    const savedRows = [];
    const recordsByMatch = records.reduce((acc, record) => {
      if (!acc[record.matchId]) acc[record.matchId] = [];
      acc[record.matchId].push(record);
      return acc;
    }, {});
    const verifiedRoomMapsByMatch = {};
    const teamIdentityMatches = [];

    for (const [recordMatchId, matchRecords] of Object.entries(recordsByMatch)) {
      const verification = await resolveTeamIdentities(pool, {
        matchId: recordMatchId,
        teams: matchRecords.map((record) => record.rawPayload),
        getRoomTeamId: getRealtimeTeamId,
        getPlayersFromTeam: (team) =>
          team?.player_stats !== undefined
            ? team.player_stats
            : normalizePlayersList(team?.players),
        normalizeTeamId,
        tournamentId,
      });

      verifiedRoomMapsByMatch[recordMatchId] = verification.roomTeamMap || {};
      teamIdentityMatches.push(
        ...(verification.corrections || []).map((correction) => ({
          ...correction,
          matchId: recordMatchId,
        })),
      );
    }

    await pool.query("BEGIN");

    for (const record of records) {
      const roomTeamId = normalizeTeamId(
        getRealtimeTeamId(record.rawPayload) || record.teamId,
      );
      record.teamId =
        verifiedRoomMapsByMatch[record.matchId]?.[roomTeamId] || "";

      if (!record.teamId || record.teamId === "-1") {
        continue;
      }

      const teamResult = await pool.query(
        `
        SELECT team_name, short_tag, team_logo, country_logo
        FROM teams
        WHERE COALESCE(permanent_team_id, team_id) = $1 AND tournament_id = $2
        LIMIT 1
        `,
        [record.teamId, tournamentId],
      );

      const team = teamResult.rows[0] || {};
      const teamName = team.team_name || record.teamName || "";
      const teamTag = team.short_tag || record.teamTag || "";
      const teamLogo = team.team_logo || record.teamLogo || "";
      const countryLogo = team.country_logo || record.countryLogo || "";

      const result = await pool.query(
        `
        INSERT INTO match_results (
          tournament_id,
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
        VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())
        ON CONFLICT (tournament_id, match_id, team_id) DO UPDATE
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
          tournamentId,
          record.matchId,
          record.teamId,
          teamName,
          teamTag,
          teamLogo,
          countryLogo,
          record.kills,
          record.placement,
          record.booyahCount,
          record.totalKills,
          JSON.stringify({
            ...record.rawPayload,
            roomTeamId,
            permanentTeamId: record.teamId,
            teamIdentityMatches,
          }),
        ],
      );

      const savedRow = result.rows[0];
      await saveMatchPlayers(
        pool,
        savedRow.id,
        record.matchId,
        record.teamId,
        getPlayersFromTeamPayload(record.rawPayload),
        tournamentId,
      );

      savedRows.push(savedRow);
    }

    await pool.query("COMMIT");

    const baseUrl = getBaseUrl(req);
    const playersByResult = await loadPlayersForMatchResults(
      pool,
      savedRows.map((row) => row.id),
      baseUrl,
    );
    const booyahAssetImage = await getBooyahAssetImage(baseUrl, tournamentId);
    const championBanner = await getChampionBannerImage(baseUrl, tournamentId);
    const bannerIndex = await buildTeamBannerIndex(baseUrl, tournamentId);

    return res.json({
      success: true,
      message: "Match results saved successfully",
      teamIdentityMatches,
      champion_banner: championBanner,
      data: savedRows.map((row) =>
        formatResultRowWithPlayers(
          row,
          baseUrl,
          playersByResult,
          booyahAssetImage,
          bannerIndex,
        ),
      ),
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("Match results create failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/from-realtime/:matchId", async (req, res) => {
  try {
    const matchId = toNullableString(req.params.matchId);
    if (!matchId) {
      return res.status(400).json({
        success: false,
        message: "matchId is required",
      });
    }

    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const result = await saveRealtimeResultsForMatch(matchId, tournamentId);

    const baseUrl = getBaseUrl(req);
    const playersByResult = await loadPlayersForMatchResults(
      pool,
      result.savedRows.map((row) => row.id),
      baseUrl,
    );
    const booyahAssetImage = await getBooyahAssetImage(baseUrl, tournamentId);
    const championBanner = await getChampionBannerImage(baseUrl, tournamentId);
    const bannerIndex = await buildTeamBannerIndex(baseUrl, tournamentId);

    return res.json({
      success: true,
      message: "Realtime match results saved successfully",
      matchId,
      booyahDetected: result.booyahDetected,
      finalDetected: result.finalDetected,
      teamIdentityMatches: result.teamIdentityMatches || [],
      skippedRows: result.skippedRows,
      champion_banner: championBanner,
      data: result.savedRows.map((row) =>
        formatResultRowWithPlayers(
          row,
          baseUrl,
          playersByResult,
          booyahAssetImage,
          bannerIndex,
        ),
      ),
    });
  } catch (err) {
    console.error("Realtime result save failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/from-realtime/by-match-ids", async (req, res) => {
  try {
    const matchIds = normalizeMatchIdsPayload(req.body);
    if (!matchIds.length) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one matchId",
      });
    }

    const savedRows = [];
    const skippedRows = [];
    const matchSummaries = [];
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    for (const matchId of matchIds) {
      const result = await saveRealtimeResultsForMatch(matchId, tournamentId);
      savedRows.push(...result.savedRows);
      skippedRows.push(
        ...result.skippedRows.map((row) => ({
          ...row,
          matchId,
        })),
      );
      matchSummaries.push({
        matchId,
        savedCount: result.savedRows.length,
        skippedCount: result.skippedRows.length,
        booyahDetected: result.booyahDetected,
        finalDetected: result.finalDetected,
        teamIdentityMatches: result.teamIdentityMatches || [],
      });
    }

    const baseUrl = getBaseUrl(req);
    const playersByResult = await loadPlayersForMatchResults(
      pool,
      savedRows.map((row) => row.id),
      baseUrl,
    );
    const booyahAssetImage = await getBooyahAssetImage(baseUrl, tournamentId);
    const championBanner = await getChampionBannerImage(baseUrl, tournamentId);
    const bannerIndex = await buildTeamBannerIndex(baseUrl, tournamentId);

    return res.json({
      success: true,
      message: "Realtime match results saved successfully",
      matchIds,
      matches: matchSummaries,
      teamIdentityMatches: matchSummaries.flatMap(
        (match) =>
          (match.teamIdentityMatches || []).map((correction) => ({
            ...correction,
            matchId: match.matchId,
          })),
      ),
      skippedRows,
      champion_banner: championBanner,
      data: savedRows.map((row) =>
        formatResultRowWithPlayers(
          row,
          baseUrl,
          playersByResult,
          booyahAssetImage,
          bannerIndex,
        ),
      ),
    });
  } catch (err) {
    console.error("Realtime results save failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

const sendMatchResults = async (req, res, matchIds) => {
  await ensureMatchResultsTable();
  const tournamentId = await getTournamentIdFromRequest(pool, req);

  if (!matchIds.length) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one matchId",
    });
  }

  const baseUrl = getBaseUrl(req);
  const booyahAssetImage = await getBooyahAssetImage(baseUrl, tournamentId);
  const championBanner = await getChampionBannerImage(baseUrl, tournamentId);
  const bannerIndex = await buildTeamBannerIndex(baseUrl, tournamentId);
  const result = await queryMatchResults(matchIds, tournamentId);
  const playersByResult = await loadPlayersForMatchResults(
    pool,
    result.rows.map((row) => row.id),
    baseUrl,
  );
  const dataRows = result.rows.map((row) =>
    formatResultRowWithPlayers(
      row,
      baseUrl,
      playersByResult,
      booyahAssetImage,
      bannerIndex,
    ),
  );
  const playersByTeam = buildOverallPlayersByTeam(dataRows);

  return res.json({
    success: true,
    matchIds,
    champion_banner: championBanner,
    data: dataRows,
    overall: result.overall.map((row) =>
      formatAggregateRow(
        row,
        baseUrl,
        playersByTeam,
        booyahAssetImage,
        bannerIndex,
      ),
    ),
  });
};

const getFullMatchRows = async (matchIds, baseUrl, tournamentId) => {
  const booyahAssetImage = await getBooyahAssetImage(baseUrl, tournamentId);
  const bannerIndex = await buildTeamBannerIndex(baseUrl, tournamentId);
  const result = await queryMatchResults(matchIds, tournamentId);
  const playersByResult = await loadPlayersForMatchResults(
    pool,
    result.rows.map((row) => row.id),
    baseUrl,
  );

  return result.rows.map((row) =>
    formatResultRowWithPlayers(
      row,
      baseUrl,
      playersByResult,
      booyahAssetImage,
      bannerIndex,
    ),
  );
};

const flattenPlayers = (teams = []) =>
  teams.flatMap((team) =>
    (team.players || []).map((player) => {
      const impactScore =
        player.kills * 100 +
        player.damage +
        player.assists * 25 +
        player.knockdowns * 50 +
        Math.floor((player.survival_time || 0) / 10);

      return {
        matchId: team.matchId,
        teamId: team.teamId,
        teamName: team.teamName,
        teamLogo: team.teamLogo,
        countryLogo: team.countryLogo,
        placement: team.placement,
        booyahCount: team.booyahCount,
        impactScore,
        ...player,
      };
    }),
  );

const isBooyahTeam = (team = {}) =>
  Number(team.booyahCount) > 0;

const sortByKillsDamageAssists = (a, b) =>
  b.kills - a.kills ||
  b.damage - a.damage ||
  b.assists - a.assists ||
  b.knockdowns - a.knockdowns ||
  a.player_name.localeCompare(b.player_name);

const sendPlayerRanking = async (req, res, sortFn, options = {}) => {
  await ensureMatchResultsTable();
  const tournamentId = await getTournamentIdFromRequest(pool, req);

  const baseUrl = getBaseUrl(req);
  const matchIds = normalizeMatchIdsPayload({
    matchId: req.params.matchId,
    ...req.query,
  });
  if (!matchIds.length) {
    return res.status(400).json({
      success: false,
      message: "matchId is required",
    });
  }

  const teams = await getFullMatchRows(matchIds, baseUrl, tournamentId);
  const sourceTeams = options.booyahOnly ? teams.filter(isBooyahTeam) : teams;
  const players = flattenPlayers(sourceTeams)
    .sort(sortFn)
    .slice(0, options.limit || undefined);

  return res.json({
    success: true,
    matchIds,
    source: options.booyahOnly ? "booyah_teams" : "all_teams",
    data: players.map((player, index) => ({
      rank: index + 1,
      ...player,
    })),
  });
};

router.get("/team-stats/:matchId", async (req, res) => {
  try {
    await ensureMatchResultsTable();

    const baseUrl = getBaseUrl(req);
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const teams = await getFullMatchRows(
      [toNullableString(req.params.matchId)],
      baseUrl,
      tournamentId,
    );
    const booyahTeams = teams.filter(isBooyahTeam);

    return res.json({
      success: true,
      matchId: req.params.matchId,
      source: "booyah_teams",
      data: booyahTeams.map((team) => ({
        teamId: team.teamId,
        teamName: team.teamName,
        teamTag: team.teamTag,
        teamLogo: team.teamLogo,
        countryLogo: team.countryLogo,
        booyahBanner: team.booyahBanner,
        booyahImage: team.booyahImage,
        kills: team.kills,
        placement: team.placement,
        booyahCount: team.booyahCount,
        totalKills: team.totalKills,
        players: team.players,
      })),
    });
  } catch (err) {
    console.error("Team stats fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/mvp/:matchId", async (req, res) => {
  try {
    return sendPlayerRanking(
      req,
      res,
      sortByKillsDamageAssists,
      { booyahOnly: true },
    );
  } catch (err) {
    console.error("MVP fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/top-fraggers/:matchId", async (req, res) => {
  try {
    return sendPlayerRanking(
      req,
      res,
      sortByKillsDamageAssists,
      { limit: 5 },
    );
  } catch (err) {
    console.error("Top fraggers fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/booyah/:matchId", async (req, res) => {
  try {
    await ensureMatchResultsTable();

    const baseUrl = getBaseUrl(req);
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const teams = await getFullMatchRows(
      [toNullableString(req.params.matchId)],
      baseUrl,
      tournamentId,
    );
    const booyahTeams = teams.filter((team) => team.booyahCount > 0);

    return res.json({
      success: true,
      matchId: req.params.matchId,
      data: booyahTeams.map((team) => ({
        team_id: team.teamId,
        team_name: team.teamName,
        team_logo: team.teamLogo,
        country_logo: team.countryLogo,
        booyah_banner: team.booyahBanner,
        booyah_image: team.booyahImage,
        placement: 1,
        players: team.players,
      })),
    });
  } catch (err) {
    console.error("Booyah teams fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/booyah-result/:id", async (req, res) => {
  try {
    await ensureMatchResultsTable();
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    const baseUrl = getBaseUrl(req);
    const sourceResult = await pool.query(
      "SELECT match_id FROM match_results WHERE id = $1 AND tournament_id = $2 LIMIT 1",
      [req.params.id, tournamentId],
    );

    if (!sourceResult.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Match result not found" });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM match_results
      WHERE match_id = $1 AND tournament_id = $2 AND (${BOOYAH_COUNT_SQL}) > 0
      ORDER BY (${BOOYAH_COUNT_SQL}) DESC, placement ASC, total_kills DESC
      LIMIT 1
      `,
      [sourceResult.rows[0].match_id, tournamentId],
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Booyah team not found" });
    }

    const playersByResult = await loadPlayersForMatchResults(
      pool,
      [result.rows[0].id],
      baseUrl,
    );
    const booyahAssetImage = await getBooyahAssetImage(baseUrl, tournamentId);
    const championBanner = await getChampionBannerImage(baseUrl, tournamentId);
    const bannerIndex = await buildTeamBannerIndex(baseUrl, tournamentId);
    const team = formatResultRowWithPlayers(
      result.rows[0],
      baseUrl,
      playersByResult,
      booyahAssetImage,
      bannerIndex,
    );

    return res.json({
      success: true,
      champion_banner: championBanner,
      data: {
        team_id: team.teamId,
        team_name: team.teamName,
        team_logo: team.teamLogo,
        country_logo: team.countryLogo,
        full_team_banner: team.fullTeamBanner,
        notification_team_banner: team.notificationTeamBanner,
        booyah_banner: team.booyahBanner,
        booyah_image: team.booyahImage,
        fullTeamBanner: team.fullTeamBanner,
        notificationTeamBanner: team.notificationTeamBanner,
        placement: 1,
        players: team.players,
      },
    });
  } catch (err) {
    console.error("Booyah result fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const matchIds = normalizeMatchIdsPayload(req.query);
    return sendMatchResults(req, res, matchIds);
  } catch (err) {
    console.error("Match results fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/:matchId", async (req, res) => {
  try {
    return sendMatchResults(req, res, [toNullableString(req.params.matchId)]);
  } catch (err) {
    console.error("Match result fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/by-match-ids", async (req, res) => {
  try {
    const matchIds = normalizeMatchIdsPayload(req.body);
    return sendMatchResults(req, res, matchIds);
  } catch (err) {
    console.error("Match results fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/:matchId", async (req, res) => {
  try {
    await ensureMatchResultsTable();
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    const matchId = toNullableString(req.params.matchId);
    if (!matchId) {
      return res.status(400).json({
        success: false,
        message: "matchId is required",
      });
    }

    const result = await pool.query(
      "DELETE FROM match_results WHERE match_id = $1 AND tournament_id = $2 RETURNING id, match_id, team_id",
      [matchId, tournamentId],
    );

    return res.json({
      success: true,
      message: "Match result deleted successfully",
      matchId,
      deletedCount: result.rowCount,
      deletedRows: result.rows,
    });
  } catch (err) {
    console.error("Match result delete failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
