const express = require("express");

const pool = require("../Database/db");
const {
  ensureTournamentColumn,
  getTournamentIdFromRequest,
} = require("../Data/tournamentContext");

const router = express.Router({ mergeParams: true });

let zoneShrinkTableReady = false;

const ensureZoneShrinkTable = async () => {
  if (zoneShrinkTableReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zone_shrink_state (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER,
      active BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await ensureTournamentColumn(pool, "zone_shrink_state");
  await pool.query("ALTER TABLE zone_shrink_state DROP CONSTRAINT IF EXISTS zone_shrink_state_single_row");
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_shrink_state_tournament_unique
    ON zone_shrink_state(tournament_id)
  `);
  await pool.query(`
    INSERT INTO zone_shrink_state (id, tournament_id)
    SELECT id, id FROM tournaments WHERE slug = 'saggu-family'
    ON CONFLICT (tournament_id) DO NOTHING;
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
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    const result = await pool.query(
      "SELECT active, updated_at FROM zone_shrink_state WHERE tournament_id = $1 LIMIT 1",
      [tournamentId],
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
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    const active = normalizeBoolean(req.body.active, false);
    const result = await pool.query(
      `
      INSERT INTO zone_shrink_state (id, tournament_id, active, updated_at)
      VALUES ($1, $1, $2, NOW())
      ON CONFLICT (tournament_id) DO UPDATE
      SET
        active = EXCLUDED.active,
        updated_at = NOW()
      RETURNING active, updated_at
      `,
      [tournamentId, active],
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
