const express = require("express");

const pool = require("../Database/db");

const router = express.Router();

const firstValue = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== "");

const toNullableString = (value) => {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean === "" ? null : clean;
};

const toNullableBoolean = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;

  const clean = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(clean)) return true;
  if (["false", "0", "no", "off"].includes(clean)) return false;

  return null;
};

const getBodyValue = (body, ...names) => {
  for (const name of names) {
    if (body[name] !== undefined) return body[name];
  }

  const lowerNameMap = Object.keys(body).reduce((acc, key) => {
    acc[key.toLowerCase()] = key;
    return acc;
  }, {});

  for (const name of names) {
    const actualKey = lowerNameMap[String(name).toLowerCase()];
    if (actualKey && body[actualKey] !== undefined) return body[actualKey];
  }

  return undefined;
};

let gameDetailsTableReady = false;

const ensureGameDetailsTable = async () => {
  if (gameDetailsTableReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_details (
      id SERIAL PRIMARY KEY,
      game_id TEXT,
      game_number TEXT,
      game_name TEXT,
      round_name TEXT,
      phase TEXT,
      match_id TEXT,
      map_name TEXT,
      status TEXT,
      start_time TEXT,
      mapping_template_id TEXT,
      enabled BOOLEAN NOT NULL DEFAULT false,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE game_details
    ADD COLUMN IF NOT EXISTS game_number TEXT;
  `);

  await pool.query(`
    ALTER TABLE game_details
    ADD COLUMN IF NOT EXISTS round_name TEXT;
  `);

  await pool.query(`
    ALTER TABLE game_details
    ADD COLUMN IF NOT EXISTS phase TEXT;
  `);

  await pool.query(`
    ALTER TABLE game_details
    ADD COLUMN IF NOT EXISTS mapping_template_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE game_details
    ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT false;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_game_details_game_id
    ON game_details(game_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_game_details_match_id
    ON game_details(match_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_game_details_mapping_template_id
    ON game_details(mapping_template_id);
  `);

  gameDetailsTableReady = true;
};

const normalizePayload = (body = {}) => {
  const details =
    body.details && typeof body.details === "object" && !Array.isArray(body.details)
      ? { ...body.details }
      : { ...body };

  return {
    gameNumber: firstValue(
      getBodyValue(body, "gameNumber", "game_number"),
      getBodyValue(details, "gameNumber", "game_number"),
    ),
    gameId: firstValue(
      getBodyValue(body, "gameId", "game_id", "gameID"),
      getBodyValue(details, "gameId", "game_id", "gameID"),
    ),
    gameName: firstValue(
      getBodyValue(body, "gameName", "game_name", "name", "title"),
      getBodyValue(details, "gameName", "game_name", "name", "title"),
    ),
    roundName: firstValue(
      getBodyValue(body, "roundName", "round_name"),
      getBodyValue(details, "roundName", "round_name"),
    ),
    phase: firstValue(
      getBodyValue(body, "phase"),
      getBodyValue(details, "phase"),
    ),
    matchId: firstValue(
      getBodyValue(body, "matchId", "match_id", "matchID"),
      getBodyValue(details, "matchId", "match_id", "matchID"),
    ),
    mapName: firstValue(
      getBodyValue(body, "mapName", "map_name", "map"),
      getBodyValue(details, "mapName", "map_name", "map"),
    ),
    status: firstValue(
      getBodyValue(body, "status", "gameStatus", "game_status"),
      getBodyValue(details, "status", "gameStatus", "game_status"),
    ),
    startTime: firstValue(
      getBodyValue(body, "startTime", "start_time", "startedAt", "started_at"),
      getBodyValue(details, "startTime", "start_time", "startedAt", "started_at"),
    ),
    mappingTemplateId: firstValue(
      getBodyValue(body, "mappingTemplateId", "mapping_template_id"),
      getBodyValue(details, "mappingTemplateId", "mapping_template_id"),
    ),
    enabled: firstValue(
      getBodyValue(body, "enabled", "isEnabled", "is_enabled"),
      getBodyValue(details, "enabled", "isEnabled", "is_enabled"),
    ),
    details,
  };
};

const formatRow = (row) => ({
  id: row.id,
  gameNumber: row.game_number,
  roundName: row.round_name,
  phase: row.phase,
  matchId: row.match_id,
  mappingTemplateId: row.mapping_template_id,
  enabled: row.enabled,
});

const formatMatchNumberRow = (row) => ({
  id: row.id,
  matchNumber: row.game_number,
  gameNumber: row.game_number,
  matchId: row.match_id,
});

router.post("/create", async (req, res) => {
  try {
    await ensureGameDetailsTable();

    const input = normalizePayload(req.body);
    const result = await pool.query(
      `
      INSERT INTO game_details (
        game_id,
        game_number,
        game_name,
        round_name,
        phase,
        match_id,
        map_name,
        status,
        start_time,
        mapping_template_id,
        enabled,
        details,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())
      RETURNING *
      `,
      [
        toNullableString(input.gameId),
        toNullableString(input.gameNumber),
        toNullableString(input.gameName),
        toNullableString(input.roundName),
        toNullableString(input.phase),
        toNullableString(input.matchId),
        toNullableString(input.mapName),
        toNullableString(input.status),
        toNullableString(input.startTime),
        toNullableString(input.mappingTemplateId),
        toNullableBoolean(input.enabled) ?? false,
        JSON.stringify(input.details),
      ],
    );

    return res.json({
      success: true,
      message: "Game detail created successfully",
      data: formatRow(result.rows[0]),
    });
  } catch (err) {
    console.error("Game detail create failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/all", async (req, res) => {
  try {
    await ensureGameDetailsTable();

    const result = await pool.query(`
      SELECT *
      FROM game_details
      ORDER BY id ASC
    `);

    return res.json({
      success: true,
      data: result.rows.map(formatRow),
    });
  } catch (err) {
    console.error("Game details fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/match-numbers", async (req, res) => {
  try {
    await ensureGameDetailsTable();

    const result = await pool.query(`
      SELECT id, game_number, match_id
      FROM game_details
      WHERE game_number IS NOT NULL
        AND TRIM(game_number) <> ''
      ORDER BY id ASC
    `);

    return res.json({
      success: true,
      data: result.rows.map(formatMatchNumberRow),
    });
  } catch (err) {
    console.error("Game detail match numbers fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/update/:id", async (req, res) => {
  try {
    await ensureGameDetailsTable();

    const existingResult = await pool.query(
      "SELECT * FROM game_details WHERE id = $1",
      [req.params.id],
    );

    if (!existingResult.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Game detail not found" });
    }

    const existing = existingResult.rows[0];
    const input = normalizePayload(req.body);
    const mergedDetails = {
      ...(existing.details || {}),
      ...(input.details || {}),
    };

    const result = await pool.query(
      `
      UPDATE game_details
      SET
        game_id = $1,
        game_number = $2,
        game_name = $3,
        round_name = $4,
        phase = $5,
        match_id = $6,
        map_name = $7,
        status = $8,
        start_time = $9,
        mapping_template_id = $10,
        enabled = $11,
        details = $12::jsonb,
        updated_at = NOW()
      WHERE id = $13
      RETURNING *
      `,
      [
        input.gameId !== undefined
          ? toNullableString(input.gameId)
          : existing.game_id,
        input.gameNumber !== undefined
          ? toNullableString(input.gameNumber)
          : existing.game_number,
        input.gameName !== undefined
          ? toNullableString(input.gameName)
          : existing.game_name,
        input.roundName !== undefined
          ? toNullableString(input.roundName)
          : existing.round_name,
        input.phase !== undefined
          ? toNullableString(input.phase)
          : existing.phase,
        input.matchId !== undefined
          ? toNullableString(input.matchId)
          : existing.match_id,
        input.mapName !== undefined
          ? toNullableString(input.mapName)
          : existing.map_name,
        input.status !== undefined
          ? toNullableString(input.status)
          : existing.status,
        input.startTime !== undefined
          ? toNullableString(input.startTime)
          : existing.start_time,
        input.mappingTemplateId !== undefined
          ? toNullableString(input.mappingTemplateId)
          : existing.mapping_template_id,
        input.enabled !== undefined
          ? toNullableBoolean(input.enabled) ?? false
          : existing.enabled,
        JSON.stringify(mergedDetails),
        req.params.id,
      ],
    );

    return res.json({
      success: true,
      message: "Game detail updated successfully",
      data: formatRow(result.rows[0]),
    });
  } catch (err) {
    console.error("Game detail update failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/delete/:id", async (req, res) => {
  try {
    await ensureGameDetailsTable();

    const result = await pool.query(
      "DELETE FROM game_details WHERE id = $1 RETURNING *",
      [req.params.id],
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Game detail not found" });
    }

    return res.json({
      success: true,
      message: "Game detail deleted successfully",
      data: formatRow(result.rows[0]),
    });
  } catch (err) {
    console.error("Game detail delete failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
