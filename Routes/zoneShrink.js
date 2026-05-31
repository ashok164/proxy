const express = require("express");

const pool = require("../Database/db");

const router = express.Router();

let zoneShrinkTableReady = false;

const ensureZoneShrinkTable = async () => {
  if (zoneShrinkTableReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zone_shrink_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      active BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT zone_shrink_state_single_row CHECK (id = 1)
    );
  `);

  await pool.query(`
    INSERT INTO zone_shrink_state (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `);

  zoneShrinkTableReady = true;
};

const normalizeBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  const clean = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(clean)) return true;
  if (["false", "0", "no", "off"].includes(clean)) return false;

  return fallback;
};

const formatRow = (row = {}) => ({
  success: true,
  active: row.active ?? false,
  updated_at: row.updated_at,
});

router.get("/", async (req, res) => {
  try {
    await ensureZoneShrinkTable();

    const result = await pool.query(
      "SELECT active, updated_at FROM zone_shrink_state WHERE id = 1 LIMIT 1",
    );

    return res.json(formatRow(result.rows[0]));
  } catch (err) {
    console.error("Zone shrink status fetch failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

const updateZoneShrink = async (req, res) => {
  try {
    await ensureZoneShrinkTable();

    const active = normalizeBoolean(req.body.active, false);
    const result = await pool.query(
      `
      INSERT INTO zone_shrink_state (id, active, updated_at)
      VALUES (1, $1, NOW())
      ON CONFLICT (id) DO UPDATE
      SET
        active = EXCLUDED.active,
        updated_at = NOW()
      RETURNING active, updated_at
      `,
      [active],
    );

    return res.json(formatRow(result.rows[0]));
  } catch (err) {
    console.error("Zone shrink trigger update failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

router.post("/", updateZoneShrink);
router.put("/", updateZoneShrink);
router.patch("/", updateZoneShrink);

module.exports = router;
