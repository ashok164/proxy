const express = require("express");

const pool = require("../Database/db");

const router = express.Router();

const toNullableString = (value) => {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean === "" ? null : clean;
};

const normalizeTeamId = (value) => {
  const clean = String(value ?? "").trim();
  if (!/^\d+$/.test(clean)) return clean;

  const numberValue = Number(clean);
  return Number.isSafeInteger(numberValue) ? String(numberValue) : clean;
};

const toInteger = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : null;
};

const getBodyValue = (body, ...names) => {
  for (const name of names) {
    if (body?.[name] !== undefined) return body[name];
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

const normalizeMappingsPayload = (body = {}) => {
  const records = Array.isArray(body)
    ? body
    : Array.isArray(body.mappings)
      ? body.mappings
      : Array.isArray(body.data)
        ? body.data
        : [body];

  return records.map((record) => {
    const matchId = toNullableString(
      getBodyValue(record, "matchId", "match_id", "matchID") ||
        getBodyValue(body, "matchId", "match_id", "matchID"),
    );
    const roomTeamId = normalizeTeamId(
      getBodyValue(record, "roomTeamId", "room_team_id", "roomTeamID"),
    );
    const permanentTeamId = normalizeTeamId(
      getBodyValue(
        record,
        "permanentTeamId",
        "permanent_team_id",
        "teamId",
        "team_id",
        "teamID",
      ),
    );

    return {
      matchId,
      roomTeamId: toNullableString(roomTeamId),
      permanentTeamId: toNullableString(permanentTeamId),
      slotNumber: toInteger(
        getBodyValue(record, "slotNumber", "slot_number", "slot"),
      ),
    };
  });
};

const formatRow = (row) => ({
  id: row.id,
  matchId: row.match_id,
  roomTeamId: row.room_team_id,
  permanentTeamId: row.permanent_team_id,
  slotNumber: row.slot_number,
  teamName: row.team_name || "",
  teamTag: row.short_tag || "",
  teamLogo: row.team_logo || "",
  countryLogo: row.country_logo || "",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const selectMappings = async (matchId) =>
  pool.query(
    `
    SELECT
      mtm.*,
      t.team_name,
      t.short_tag,
      t.team_logo,
      t.country_logo
    FROM match_team_mappings mtm
    LEFT JOIN teams t
      ON t.team_id = mtm.permanent_team_id
    WHERE mtm.match_id = $1
    ORDER BY
      mtm.slot_number ASC NULLS LAST,
      CASE WHEN mtm.room_team_id ~ '^[0-9]+$' THEN mtm.room_team_id::BIGINT END ASC NULLS LAST,
      mtm.room_team_id ASC
    `,
    [matchId],
  );

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        mtm.match_id,
        COUNT(*) AS mapping_count,
        MIN(mtm.created_at) AS created_at,
        MAX(mtm.updated_at) AS updated_at,
        JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'id', mtm.id,
            'matchId', mtm.match_id,
            'roomTeamId', mtm.room_team_id,
            'permanentTeamId', mtm.permanent_team_id,
            'slotNumber', mtm.slot_number,
            'teamName', COALESCE(t.team_name, ''),
            'teamTag', COALESCE(t.short_tag, ''),
            'teamLogo', COALESCE(t.team_logo, ''),
            'countryLogo', COALESCE(t.country_logo, ''),
            'createdAt', mtm.created_at,
            'updatedAt', mtm.updated_at
          )
          ORDER BY
            mtm.slot_number ASC NULLS LAST,
            CASE WHEN mtm.room_team_id ~ '^[0-9]+$' THEN mtm.room_team_id::BIGINT END ASC NULLS LAST,
            mtm.room_team_id ASC
        ) AS mappings
      FROM match_team_mappings mtm
      LEFT JOIN teams t
        ON t.team_id = mtm.permanent_team_id
      GROUP BY mtm.match_id
      ORDER BY MAX(mtm.updated_at) DESC, mtm.match_id ASC
    `);

    return res.json({
      success: true,
      data: result.rows.map((row) => ({
        matchId: row.match_id,
        mappingCount: Number(row.mapping_count),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        mappings: row.mappings || [],
      })),
    });
  } catch (err) {
    console.error("Match team mappings list failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/create", async (req, res) => {
  try {
    const mappings = normalizeMappingsPayload(req.body);
    if (!mappings.length) {
      return res.status(400).json({
        success: false,
        message: "Request body must contain at least one mapping",
      });
    }

    const invalidMapping = mappings.find(
      (mapping) =>
        !mapping.matchId || !mapping.roomTeamId || !mapping.permanentTeamId,
    );
    if (invalidMapping) {
      return res.status(400).json({
        success: false,
        message: "Each mapping must include matchId, roomTeamId and permanentTeamId",
      });
    }

    await pool.query("BEGIN");

    for (const mapping of mappings) {
      await pool.query(
        `
        INSERT INTO match_team_mappings (
          match_id,
          room_team_id,
          permanent_team_id,
          slot_number,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (match_id, room_team_id) DO UPDATE
        SET
          permanent_team_id = EXCLUDED.permanent_team_id,
          slot_number = EXCLUDED.slot_number,
          updated_at = NOW()
        `,
        [
          mapping.matchId,
          mapping.roomTeamId,
          mapping.permanentTeamId,
          mapping.slotNumber,
        ],
      );
    }

    await pool.query("COMMIT");

    const result = await selectMappings(mappings[0].matchId);
    return res.json({
      success: true,
      message: "Match team mappings saved successfully",
      data: result.rows.map(formatRow),
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("Match team mappings create failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/:matchId", async (req, res) => {
  try {
    const matchId = toNullableString(req.params.matchId);
    const mappings = normalizeMappingsPayload({
      ...req.body,
      matchId,
    });

    if (!matchId) {
      return res.status(400).json({
        success: false,
        message: "matchId is required",
      });
    }

    const invalidMapping = mappings.find(
      (mapping) => !mapping.roomTeamId || !mapping.permanentTeamId,
    );
    if (!mappings.length || invalidMapping) {
      return res.status(400).json({
        success: false,
        message: "Each mapping must include roomTeamId and permanentTeamId",
      });
    }

    await pool.query("BEGIN");
    await pool.query("DELETE FROM match_team_mappings WHERE match_id = $1", [
      matchId,
    ]);

    for (const mapping of mappings) {
      await pool.query(
        `
        INSERT INTO match_team_mappings (
          match_id,
          room_team_id,
          permanent_team_id,
          slot_number,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW())
        `,
        [
          matchId,
          mapping.roomTeamId,
          mapping.permanentTeamId,
          mapping.slotNumber,
        ],
      );
    }

    await pool.query("COMMIT");

    const result = await selectMappings(matchId);
    return res.json({
      success: true,
      message: "Match team mappings replaced successfully",
      data: result.rows.map(formatRow),
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("Match team mappings replace failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/:matchId", async (req, res) => {
  try {
    const matchId = toNullableString(req.params.matchId);
    if (!matchId) {
      return res.status(400).json({
        success: false,
        message: "matchId is required",
      });
    }

    const result = await selectMappings(matchId);
    return res.json({
      success: true,
      matchId,
      data: result.rows.map(formatRow),
    });
  } catch (err) {
    console.error("Match team mappings fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/:matchId/:roomTeamId", async (req, res) => {
  try {
    const matchId = toNullableString(req.params.matchId);
    const roomTeamId = normalizeTeamId(req.params.roomTeamId);

    const result = await pool.query(
      `
      DELETE FROM match_team_mappings
      WHERE match_id = $1 AND room_team_id = $2
      RETURNING *
      `,
      [matchId, roomTeamId],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Mapping not found",
      });
    }

    return res.json({
      success: true,
      message: "Match team mapping deleted successfully",
      data: formatRow(result.rows[0]),
    });
  } catch (err) {
    console.error("Match team mapping delete failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/:matchId", async (req, res) => {
  try {
    const matchId = toNullableString(req.params.matchId);
    if (!matchId) {
      return res.status(400).json({
        success: false,
        message: "matchId is required",
      });
    }

    const result = await pool.query(
      `
      DELETE FROM match_team_mappings
      WHERE match_id = $1
      RETURNING *
      `,
      [matchId],
    );

    return res.json({
      success: true,
      message: "Match team mappings deleted successfully",
      matchId,
      deletedCount: result.rowCount,
    });
  } catch (err) {
    console.error("Match team mappings delete failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
