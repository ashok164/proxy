const DEFAULT_TOURNAMENT_NAME = "SAGGU FAMILY";
const DEFAULT_TOURNAMENT_SLUG = "saggu-family";

const normalizeTournamentSlug = (value) =>
  String(value || DEFAULT_TOURNAMENT_SLUG)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || DEFAULT_TOURNAMENT_SLUG;

const ensureDefaultTournament = async (pool) => {
  const result = await pool.query(
    `
    INSERT INTO tournaments (name, slug, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (slug) DO UPDATE
    SET name = EXCLUDED.name, updated_at = NOW()
    RETURNING *
    `,
    [DEFAULT_TOURNAMENT_NAME, DEFAULT_TOURNAMENT_SLUG],
  );

  return result.rows[0];
};

const ensureTournamentTables = async (pool) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      domain TEXT,
      pull_tournament_assets BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE tournaments
    ADD COLUMN IF NOT EXISTS pull_tournament_assets BOOLEAN NOT NULL DEFAULT false
  `);

  return ensureDefaultTournament(pool);
};

const getTournamentSlugFromRequest = (req = {}) =>
  normalizeTournamentSlug(
    req.params?.tournamentSlug ||
      req.params?.slug ||
      req.query?.tournamentSlug ||
      req.query?.tournament ||
      req.query?.slug ||
      req.headers?.["x-tournament-slug"],
  );

const hasExplicitTournamentSlug = (req = {}) =>
  Boolean(
    req.params?.tournamentSlug ||
      req.params?.slug ||
      req.query?.tournamentSlug ||
      req.query?.tournament ||
      req.query?.slug ||
      req.headers?.["x-tournament-slug"],
  );

const getTournamentFromRequest = async (pool, req = {}) => {
  await ensureTournamentTables(pool);

  const slug = getTournamentSlugFromRequest(req);
  const result = await pool.query(
    "SELECT * FROM tournaments WHERE slug = $1 AND is_active = true LIMIT 1",
    [slug],
  );

  if (result.rows.length) return result.rows[0];
  if (slug === DEFAULT_TOURNAMENT_SLUG) return ensureDefaultTournament(pool);

  const err = new Error("Tournament not found");
  err.statusCode = 404;
  throw err;
};

const getTournamentIdFromRequest = async (pool, req = {}) =>
  (await getTournamentFromRequest(pool, req)).id;

const getTournamentAssetScopeFromRequest = async (pool, req = {}) => {
  const tournament = await getTournamentFromRequest(pool, req);
  return {
    tournament,
    tournamentId: tournament.id,
    pullTournamentAssets: Boolean(tournament.pull_tournament_assets),
  };
};

const ensureTournamentColumn = async (pool, table) => {
  const defaultTournament = await ensureTournamentTables(pool);
  await pool.query(`
    ALTER TABLE ${table}
    ADD COLUMN IF NOT EXISTS tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE
  `);
  await pool.query(
    `UPDATE ${table} SET tournament_id = $1 WHERE tournament_id IS NULL`,
    [defaultTournament.id],
  );
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_${table}_tournament_id
    ON ${table}(tournament_id)
  `);

  return defaultTournament.id;
};

module.exports = {
  DEFAULT_TOURNAMENT_NAME,
  DEFAULT_TOURNAMENT_SLUG,
  normalizeTournamentSlug,
  ensureDefaultTournament,
  ensureTournamentTables,
  ensureTournamentColumn,
  hasExplicitTournamentSlug,
  getTournamentFromRequest,
  getTournamentIdFromRequest,
  getTournamentAssetScopeFromRequest,
};
