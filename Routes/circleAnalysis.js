const express = require("express");

const pool = require("../Database/db");

const router = express.Router();

const DEFAULT_CIRCLES = [1, 2, 3, 4, 5, 6, 7, 8];

let circleAnalysisTableReady = false;

const ensureCircleAnalysisTable = async () => {
  if (circleAnalysisTableReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS circle_analysis (
      id INTEGER PRIMARY KEY DEFAULT 1,
      circles JSONB NOT NULL DEFAULT '[1,2,3,4,5,6,7,8]'::jsonb,
      teams JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT circle_analysis_single_row CHECK (id = 1)
    );
  `);

  await pool.query(`
    INSERT INTO circle_analysis (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `);

  circleAnalysisTableReady = true;
};

const toArray = (value, fallback = []) => (Array.isArray(value) ? value : fallback);

const normalizeCircle = (value) => {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) ? numberValue : null;
};

const normalizeBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;

  const clean = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(clean)) return true;
  if (["false", "0", "no", "off"].includes(clean)) return false;

  return fallback;
};

const normalizeCircles = (value) => {
  const circles = toArray(value, DEFAULT_CIRCLES)
    .map(normalizeCircle)
    .filter((circle) => circle !== null);

  return circles.length ? circles : DEFAULT_CIRCLES;
};

const normalizeKillsPerCircle = (killsPerCircle = {}, circles = DEFAULT_CIRCLES) => {
  const normalized = {};

  for (const circle of circles) {
    const rawValue = killsPerCircle?.[circle] ?? killsPerCircle?.[String(circle)] ?? 0;
    const numberValue = Number(rawValue);
    normalized[String(circle)] = Number.isFinite(numberValue) ? numberValue : 0;
  }

  return normalized;
};

const normalizeTeam = (team = {}, circles = DEFAULT_CIRCLES) => ({
  teamId: String(team.teamId ?? team.team_id ?? team.id ?? ""),
  teamName: String(team.teamName ?? team.team_name ?? team.name ?? ""),
  shortLabel: String(team.shortLabel ?? team.short_label ?? team.shortTag ?? team.short_tag ?? ""),
  logoUrl: team.logoUrl ?? team.logo_url ?? team.teamLogo ?? team.team_logo ?? "",
  countryLogoUrl:
    team.countryLogoUrl ?? team.country_logo_url ?? team.countryLogo ?? team.country_logo ?? "",
  isDead: normalizeBoolean(team.isDead ?? team.is_dead, false),
  hasBooyah: normalizeBoolean(team.hasBooyah ?? team.has_booyah, false),
  lastCircle: normalizeCircle(team.lastCircle ?? team.last_circle) ?? 1,
  killsPerCircle: normalizeKillsPerCircle(
    team.killsPerCircle ?? team.kills_per_circle,
    circles,
  ),
});

const normalizePayload = (body = {}) => {
  const circles = normalizeCircles(body.circles);

  return {
    circles,
    teams: toArray(body.teams).map((team) => normalizeTeam(team, circles)),
  };
};

const formatRow = (row = {}) => ({
  circles: row.circles || DEFAULT_CIRCLES,
  teams: row.teams || [],
  updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
});

router.get("/", async (req, res) => {
  try {
    await ensureCircleAnalysisTable();

    const result = await pool.query(
      "SELECT circles, teams, updated_at FROM circle_analysis WHERE id = 1 LIMIT 1",
    );

    return res.json(formatRow(result.rows[0]));
  } catch (err) {
    console.error("Circle analysis fetch failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

const updateCircleAnalysis = async (req, res) => {
  try {
    await ensureCircleAnalysisTable();

    const payload = normalizePayload(req.body);
    const result = await pool.query(
      `
      INSERT INTO circle_analysis (id, circles, teams, updated_at)
      VALUES (1, $1::jsonb, $2::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE
      SET
        circles = EXCLUDED.circles,
        teams = EXCLUDED.teams,
        updated_at = NOW()
      RETURNING circles, teams, updated_at
      `,
      [JSON.stringify(payload.circles), JSON.stringify(payload.teams)],
    );

    return res.json(formatRow(result.rows[0]));
  } catch (err) {
    console.error("Circle analysis update failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

router.post("/", updateCircleAnalysis);
router.put("/", updateCircleAnalysis);
router.patch("/", updateCircleAnalysis);

module.exports = router;
