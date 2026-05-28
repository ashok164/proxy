const express = require("express");
const axios = require("axios");

const pool = require("../Database/db");

const router = express.Router();

const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;

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

const getHeaders = () => ({
  "Client-ID": CLIENT_ID,
});

const fetchRealtimeMatch = async (matchId) => {
  const response = await axios.get(`${API_URL}/${matchId}`, {
    headers: getHeaders(),
    timeout: 5000,
  });

  return response.data;
};

const getRealtimeTeams = (data) =>
  data?.match?.team_stats || data?.team_stats || data?.teams || [];

const getRealtimeTeamId = (team = {}) =>
  firstValue(
    team.team_id,
    team.id,
    team.teamId,
    team.team_uid,
    team.teamUid,
    team.teamCode,
  );

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
  const value = firstValue(
    team.booyah,
    team.is_booyah,
    team.isBooyah,
    team.has_booyah,
    team.hasBooyah,
    team.winner,
    team.isWinner,
    team.is_winner,
  );

  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const clean = String(value ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "y", "win", "winner", "booyah"].includes(clean);
};

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

const normalizeResultsPayload = (body) => {
  if (Array.isArray(body)) return body;
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
    kills: toInteger(getBodyValue(input, "kills")),
    placement: toInteger(getBodyValue(input, "placement")),
    booyahCount: toInteger(
      getBodyValue(input, "booyahCount", "booyah_count"),
    ),
    totalKills: toInteger(getBodyValue(input, "totalKills", "total_kills")),
    rawPayload: input,
  };
};

const resolvePermanentTeamId = async (matchId, teamId) => {
  const result = await pool.query(
    `
    SELECT permanent_team_id
    FROM match_team_mappings
    WHERE match_id = $1 AND room_team_id = $2
    LIMIT 1
    `,
    [matchId, teamId],
  );

  return result.rows[0]?.permanent_team_id || teamId;
};

const resolveMappedPermanentTeamId = async (matchId, teamId) => {
  const result = await pool.query(
    `
    SELECT permanent_team_id
    FROM match_team_mappings
    WHERE match_id = $1 AND room_team_id = $2
    LIMIT 1
    `,
    [matchId, teamId],
  );

  return result.rows[0]?.permanent_team_id || null;
};

const saveRealtimeResultsForMatch = async (matchId) => {
  await ensureMatchResultsTable();

  const payload = await fetchRealtimeMatch(matchId);
  const teams = getRealtimeTeams(payload);

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

  for (const team of teams) {
    const roomTeamId = normalizeTeamId(getRealtimeTeamId(team));
    if (!roomTeamId) {
      skippedRows.push({ roomTeamId: "", reason: "Missing realtime room team id", team });
      continue;
    }

    const permanentTeamId = await resolveMappedPermanentTeamId(matchId, roomTeamId);
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
      WHERE team_id = $1
      LIMIT 1
      `,
      [permanentTeamId],
    );
    const teamMeta = teamResult.rows[0] || {};
    const kills = getRealtimeKills(team);
    const placement = getRealtimePlacementPoints(team);
    const booyahCount = hasRealtimeBooyah(team) ? 1 : 0;
    const totalKills = getRealtimeTotalScore(team);

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
        getRealtimeTeamName(team) || teamMeta.team_name || "",
        getRealtimeTeamTag(team) || teamMeta.short_tag || "",
        teamMeta.team_logo || firstValue(team.team_logo, team.teamLogo, team.logo) || "",
        teamMeta.country_logo || firstValue(team.country_logo, team.countryLogo, team.flag) || "",
        kills,
        placement,
        booyahCount,
        totalKills,
        JSON.stringify({
          ...team,
          roomTeamId,
          permanentTeamId,
          source: "realtime",
        }),
      ],
    );

    savedRows.push(result.rows[0]);
  }

  return {
    matchId,
    savedRows,
    skippedRows,
    booyahDetected,
    finalDetected,
  };
};

const formatResultRow = (row, baseUrl) => ({
  id: row.id,
  matchId: row.match_id,
  teamId: row.team_id,
  teamLogo: formatImageUrl(baseUrl, row.team_logo),
  countryLogo: formatImageUrl(baseUrl, row.country_logo),
  teamName: row.team_name || "",
  teamTag: row.team_tag || "",
  kills: row.kills,
  placement: row.placement,
  booyahCount: row.booyah_count,
  totalKills: row.total_kills,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const formatAggregateRow = (row, baseUrl) => ({
  teamId: row.team_id,
  teamLogo: formatImageUrl(baseUrl, row.team_logo),
  countryLogo: formatImageUrl(baseUrl, row.country_logo),
  teamName: row.team_name || "",
  teamTag: row.team_tag || "",
  kills: Number(row.kills),
  placement: Number(row.placement),
  booyahCount: Number(row.booyah_count),
  totalKills: Number(row.total_kills),
  matchesPlayed: Number(row.matches_played),
});

const queryMatchResults = async (matchIds) => {
  const rowsResult = await pool.query(
    `
    SELECT *
    FROM match_results
    WHERE match_id = ANY($1::text[])
    ORDER BY
      total_kills DESC,
      kills DESC,
      booyah_count DESC,
      placement DESC,
      team_name ASC
    `,
    [matchIds],
  );

  const aggregateResult = await pool.query(
    `
    SELECT
      team_id,
      COALESCE(MAX(NULLIF(team_logo, '')), '') AS team_logo,
      COALESCE(MAX(NULLIF(country_logo, '')), '') AS country_logo,
      COALESCE(MAX(NULLIF(team_name, '')), '') AS team_name,
      COALESCE(MAX(NULLIF(team_tag, '')), '') AS team_tag,
      SUM(kills) AS kills,
      SUM(placement) AS placement,
      SUM(booyah_count) AS booyah_count,
      SUM(total_kills) AS total_kills,
      COUNT(DISTINCT match_id) AS matches_played
    FROM match_results
    WHERE match_id = ANY($1::text[])
    GROUP BY team_id
    ORDER BY
      SUM(total_kills) DESC,
      SUM(kills) DESC,
      SUM(booyah_count) DESC,
      SUM(placement) DESC,
      COALESCE(MAX(NULLIF(team_name, '')), '') ASC
    `,
    [matchIds],
  );

  return {
    rows: rowsResult.rows,
    overall: aggregateResult.rows,
  };
};

router.post("/create", async (req, res) => {
  try {
    await ensureMatchResultsTable();

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
    await pool.query("BEGIN");

    for (const record of records) {
      record.teamId = await resolvePermanentTeamId(record.matchId, record.teamId);

      const teamResult = await pool.query(
        `
        SELECT team_name, short_tag, team_logo, country_logo
        FROM teams
        WHERE team_id = $1
        LIMIT 1
        `,
        [record.teamId],
      );

      const team = teamResult.rows[0] || {};
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
          record.matchId,
          record.teamId,
          record.teamName || team.team_name || "",
          record.teamTag || team.short_tag || "",
          record.teamLogo || team.team_logo || "",
          record.countryLogo || team.country_logo || "",
          record.kills,
          record.placement,
          record.booyahCount,
          record.totalKills,
          JSON.stringify(record.rawPayload),
        ],
      );

      savedRows.push(result.rows[0]);
    }

    await pool.query("COMMIT");

    return res.json({
      success: true,
      message: "Match results saved successfully",
      data: savedRows.map((row) => formatResultRow(row, getBaseUrl(req))),
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

    const result = await saveRealtimeResultsForMatch(matchId);

    return res.json({
      success: true,
      message: "Realtime match results saved successfully",
      matchId,
      booyahDetected: result.booyahDetected,
      finalDetected: result.finalDetected,
      skippedRows: result.skippedRows,
      data: result.savedRows.map((row) => formatResultRow(row, getBaseUrl(req))),
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

    for (const matchId of matchIds) {
      const result = await saveRealtimeResultsForMatch(matchId);
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
      });
    }

    return res.json({
      success: true,
      message: "Realtime match results saved successfully",
      matchIds,
      matches: matchSummaries,
      skippedRows,
      data: savedRows.map((row) => formatResultRow(row, getBaseUrl(req))),
    });
  } catch (err) {
    console.error("Realtime results save failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

const sendMatchResults = async (req, res, matchIds) => {
  await ensureMatchResultsTable();

  if (!matchIds.length) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one matchId",
    });
  }

  const baseUrl = getBaseUrl(req);
  let result = await queryMatchResults(matchIds);
  const autoSaveAttempts = [];

  if (result.rows.length === 0) {
    for (const matchId of matchIds) {
      try {
        const saveResult = await saveRealtimeResultsForMatch(matchId);
        autoSaveAttempts.push({
          matchId,
          savedCount: saveResult.savedRows.length,
          skippedCount: saveResult.skippedRows.length,
          booyahDetected: saveResult.booyahDetected,
          finalDetected: saveResult.finalDetected,
        });
      } catch (err) {
        autoSaveAttempts.push({
          matchId,
          savedCount: 0,
          skippedCount: 0,
          booyahDetected: false,
          error: err.message,
        });
      }
    }

    result = await queryMatchResults(matchIds);
  }

  return res.json({
    success: true,
    matchIds,
    autoSaveAttempts,
    data: result.rows.map((row) => formatResultRow(row, baseUrl)),
    overall: result.overall.map((row) => formatAggregateRow(row, baseUrl)),
  });
};

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

module.exports = router;
