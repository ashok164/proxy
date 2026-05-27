const express = require("express");

const pool = require("../Database/db");

const router = express.Router();

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

const sendMatchResults = async (req, res, matchIds) => {
  await ensureMatchResultsTable();

  if (!matchIds.length) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one matchId",
    });
  }

  const baseUrl = getBaseUrl(req);
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

  return res.json({
    success: true,
    matchIds,
    data: rowsResult.rows.map((row) => formatResultRow(row, baseUrl)),
    overall: aggregateResult.rows.map((row) => formatAggregateRow(row, baseUrl)),
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
