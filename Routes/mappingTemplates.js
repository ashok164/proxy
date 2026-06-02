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

const normalizeTemplateMappings = (body = {}) => {
  const records = Array.isArray(body)
    ? body
    : Array.isArray(body.mappings)
      ? body.mappings
      : Array.isArray(body.data)
        ? body.data
        : [];

  return records.map((record) => ({
    roomTeamId: toNullableString(
      normalizeTeamId(getBodyValue(record, "roomTeamId", "room_team_id", "roomTeamID")),
    ),
    permanentTeamId: toNullableString(
      normalizeTeamId(
        getBodyValue(
          record,
          "permanentTeamId",
          "permanent_team_id",
          "teamId",
          "team_id",
          "teamID",
        ),
      ),
    ),
    slotNumber: toInteger(getBodyValue(record, "slotNumber", "slot_number", "slot")),
  }));
};

const ensureMappingTemplatesTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mapping_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      mappings JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_mapping_templates_updated_at
    ON mapping_templates(updated_at);
  `);
};

const validateTemplatePayload = (body = {}) => {
  const name = toNullableString(getBodyValue(body, "name"));
  const mappings = normalizeTemplateMappings(body);

  if (!name) {
    return { error: "Template name is required" };
  }

  if (!mappings.length) {
    return { error: "Template must contain at least one mapping" };
  }

  const invalidMapping = mappings.find(
    (mapping) => !mapping.roomTeamId || !mapping.permanentTeamId,
  );

  if (invalidMapping) {
    return {
      error: "Each mapping must include roomTeamId and permanentTeamId",
    };
  }

  return { name, mappings };
};

const formatRow = (row) => ({
  id: String(row.id),
  name: row.name,
  mappings: row.mappings || [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const selectLatestTemplateByName = (name) =>
  pool.query(
    `
    SELECT *
    FROM mapping_templates
    WHERE LOWER(name) = LOWER($1)
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
    `,
    [name],
  );

router.get("/", async (req, res) => {
  try {
    await ensureMappingTemplatesTable();

    const result = await pool.query(`
      SELECT *
      FROM mapping_templates
      ORDER BY updated_at DESC, id DESC
    `);

    return res.json({
      success: true,
      data: result.rows.map(formatRow),
    });
  } catch (err) {
    console.error("Mapping templates fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    await ensureMappingTemplatesTable();

    const input = validateTemplatePayload(req.body);
    if (input.error) {
      return res.status(400).json({ success: false, message: input.error });
    }

    const result = await pool.query(
      `
      INSERT INTO mapping_templates (name, mappings, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      RETURNING *
      `,
      [input.name, JSON.stringify(input.mappings)],
    );

    return res.status(201).json({
      success: true,
      message: "Mapping template created successfully",
      data: formatRow(result.rows[0]),
    });
  } catch (err) {
    console.error("Mapping template create failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/save", async (req, res) => {
  try {
    await ensureMappingTemplatesTable();

    const input = validateTemplatePayload(req.body);
    if (input.error) {
      return res.status(400).json({ success: false, message: input.error });
    }

    const existing = await selectLatestTemplateByName(input.name);

    if (existing.rows.length) {
      const result = await pool.query(
        `
        UPDATE mapping_templates
        SET
          name = $1,
          mappings = $2::jsonb,
          updated_at = NOW()
        WHERE id = $3
        RETURNING *
        `,
        [input.name, JSON.stringify(input.mappings), existing.rows[0].id],
      );

      return res.json({
        success: true,
        message: "Mapping template saved successfully",
        data: formatRow(result.rows[0]),
      });
    }

    const result = await pool.query(
      `
      INSERT INTO mapping_templates (name, mappings, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      RETURNING *
      `,
      [input.name, JSON.stringify(input.mappings)],
    );

    return res.status(201).json({
      success: true,
      message: "Mapping template saved successfully",
      data: formatRow(result.rows[0]),
    });
  } catch (err) {
    console.error("Mapping template save failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/name/:name", async (req, res) => {
  try {
    await ensureMappingTemplatesTable();

    const name = toNullableString(req.params.name);
    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: "Template name is required" });
    }

    const result = await selectLatestTemplateByName(name);
    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Mapping template not found" });
    }

    return res.json({
      success: true,
      data: formatRow(result.rows[0]),
    });
  } catch (err) {
    console.error("Mapping template name fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    await ensureMappingTemplatesTable();

    const input = validateTemplatePayload(req.body);
    if (input.error) {
      return res.status(400).json({ success: false, message: input.error });
    }

    const result = await pool.query(
      `
      UPDATE mapping_templates
      SET
        name = $1,
        mappings = $2::jsonb,
        updated_at = NOW()
      WHERE id = $3
      RETURNING *
      `,
      [input.name, JSON.stringify(input.mappings), req.params.id],
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Mapping template not found" });
    }

    return res.json({
      success: true,
      message: "Mapping template updated successfully",
      data: formatRow(result.rows[0]),
    });
  } catch (err) {
    console.error("Mapping template update failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await ensureMappingTemplatesTable();

    await pool.query("BEGIN");

    await pool.query(
      `
      UPDATE game_details
      SET mapping_template_id = NULL, updated_at = NOW()
      WHERE mapping_template_id = $1
      `,
      [req.params.id],
    );

    const result = await pool.query(
      "DELETE FROM mapping_templates WHERE id = $1 RETURNING *",
      [req.params.id],
    );

    if (!result.rows.length) {
      await pool.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Mapping template not found" });
    }

    await pool.query("COMMIT");

    return res.json({
      success: true,
      message: "Mapping template deleted successfully",
      data: formatRow(result.rows[0]),
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("Mapping template delete failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
