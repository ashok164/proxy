const express = require("express");

const pool = require("../Database/db");
const {
  ensureTournamentColumn,
  getTournamentIdFromRequest,
} = require("../Data/tournamentContext");

const router = express.Router({ mergeParams: true });

const COLOR_FIELDS = [
  "primary",
  "secondary",
  "accent",
  "background",
  "surface",
  "surfaceAlt",
  "textPrimary",
  "textSecondary",
  "textInverse",
  "border",
  "success",
  "warning",
  "danger",
];

const ensureThemeTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS theme_colors (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER,
      use_default_colors BOOLEAN NOT NULL DEFAULT false,
      primary_color TEXT,
      secondary_color TEXT,
      accent_color TEXT,
      background_color TEXT,
      surface_color TEXT,
      surface_alt_color TEXT,
      text_primary_color TEXT,
      text_secondary_color TEXT,
      text_inverse_color TEXT,
      border_color TEXT,
      success_color TEXT,
      warning_color TEXT,
      danger_color TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await ensureTournamentColumn(pool, "theme_colors");
  await pool.query(`
    ALTER TABLE theme_colors
    ADD COLUMN IF NOT EXISTS text_inverse_color TEXT
  `);
  await pool.query("ALTER TABLE theme_colors DROP CONSTRAINT IF EXISTS theme_colors_single_row");
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_theme_colors_tournament_unique
    ON theme_colors(tournament_id)
  `);

  for (const column of [
    "primary_color",
    "secondary_color",
    "accent_color",
    "background_color",
    "surface_color",
    "surface_alt_color",
    "text_primary_color",
    "text_secondary_color",
    "text_inverse_color",
    "border_color",
    "success_color",
    "warning_color",
    "danger_color",
  ]) {
    await pool.query(
      `ALTER TABLE theme_colors ALTER COLUMN ${column} DROP DEFAULT`,
    );
    await pool.query(
      `ALTER TABLE theme_colors ALTER COLUMN ${column} DROP NOT NULL`,
    );
  }

  await pool.query(`
    INSERT INTO theme_colors (id, tournament_id)
    SELECT id, id FROM tournaments WHERE slug = 'saggu-family'
    ON CONFLICT (tournament_id) DO NOTHING
  `);
};

const formatTheme = (row = {}) => ({
  useDefaultColors: row.use_default_colors ?? false,
  primary: row.primary_color || null,
  secondary: row.secondary_color || null,
  accent: row.accent_color || null,
  background: row.background_color || null,
  surface: row.surface_color || null,
  surfaceAlt: row.surface_alt_color || null,
  textPrimary: row.text_primary_color || null,
  textSecondary: row.text_secondary_color || null,
  textInverse: row.text_inverse_color || null,
  border: row.border_color || null,
  success: row.success_color || null,
  warning: row.warning_color || null,
  danger: row.danger_color || null,
});

const normalizeBoolean = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;

  const clean = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(clean)) return true;
  if (["false", "0", "no", "off"].includes(clean)) return false;

  return fallback;
};

const normalizeThemeInput = (body = {}) => {
  const theme = {
    useDefaultColors: normalizeBoolean(
      body.useDefaultColors,
      false,
    ),
  };

  for (const field of COLOR_FIELDS) {
    theme[field] =
      typeof body[field] === "string" && body[field].trim()
        ? body[field].trim()
        : null;
  }

  return theme;
};

router.get("/colors", async (req, res) => {
  try {
    await ensureThemeTable();
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    const result = await pool.query(
      "SELECT * FROM theme_colors WHERE tournament_id = $1 LIMIT 1",
      [tournamentId],
    );

    return res.json(formatTheme(result.rows[0]));
  } catch (err) {
    console.error("Theme colors fetch failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

const saveThemeColors = async (req, res) => {
  try {
    await ensureThemeTable();
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    const theme = normalizeThemeInput(req.body);

    const result = await pool.query(
      `
      INSERT INTO theme_colors (
        id,
        tournament_id,
        use_default_colors,
        primary_color,
        secondary_color,
        accent_color,
        background_color,
        surface_color,
        surface_alt_color,
        text_primary_color,
        text_secondary_color,
        text_inverse_color,
        border_color,
        success_color,
        warning_color,
        danger_color,
        updated_at
      )
      VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
      ON CONFLICT (tournament_id) DO UPDATE
      SET
        use_default_colors = EXCLUDED.use_default_colors,
        primary_color = EXCLUDED.primary_color,
        secondary_color = EXCLUDED.secondary_color,
        accent_color = EXCLUDED.accent_color,
        background_color = EXCLUDED.background_color,
        surface_color = EXCLUDED.surface_color,
        surface_alt_color = EXCLUDED.surface_alt_color,
        text_primary_color = EXCLUDED.text_primary_color,
        text_secondary_color = EXCLUDED.text_secondary_color,
        text_inverse_color = EXCLUDED.text_inverse_color,
        border_color = EXCLUDED.border_color,
        success_color = EXCLUDED.success_color,
        warning_color = EXCLUDED.warning_color,
        danger_color = EXCLUDED.danger_color,
        updated_at = NOW()
      RETURNING *
      `,
      [
        tournamentId,
        theme.useDefaultColors,
        theme.primary,
        theme.secondary,
        theme.accent,
        theme.background,
        theme.surface,
        theme.surfaceAlt,
        theme.textPrimary,
        theme.textSecondary,
        theme.textInverse,
        theme.border,
        theme.success,
        theme.warning,
        theme.danger,
      ],
    );

    return res.json(formatTheme(result.rows[0]));
  } catch (err) {
    console.error("Theme colors update failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

router.post("/colors", saveThemeColors);
router.patch("/colors", saveThemeColors);
router.put("/colors", saveThemeColors);

module.exports = router;
