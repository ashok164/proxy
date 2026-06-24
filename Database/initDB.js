const pool = require("./db");
const { dropConstraintWithDependents } = require("./schemaMigrations");
const {
  DEFAULT_TOURNAMENT_NAME,
  DEFAULT_TOURNAMENT_SLUG,
} = require("../Data/tournamentContext");

const initDB = async () => {
  try {
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
      );
    `);

    await pool.query(`
      ALTER TABLE tournaments
      ADD COLUMN IF NOT EXISTS pull_tournament_assets BOOLEAN NOT NULL DEFAULT false;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        rank TEXT,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        team_id TEXT NOT NULL,
        permanent_team_id TEXT,
        team_name TEXT,
        short_tag TEXT,
        team_logo TEXT,
        country_logo TEXT,
        is_playing BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_players (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        team_id TEXT NOT NULL,
        player_uid TEXT,
        player_name TEXT,
        camera_link TEXT,
        player_pic TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS country_logos (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        image_path TEXT NOT NULL,
        file_name TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    for (const table of [
      "weapons",
      "characters",
      "skills",
      "pets",
      "roles",
      "equipment",
      "tournament_logos",
      "full_team_banners",
      "notification_team_banners",
      "tournament_assets",
    ]) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id SERIAL PRIMARY KEY,
          tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
          team_id TEXT,
          asset_id TEXT,
          name TEXT,
          description TEXT,
          active BOOLEAN NOT NULL DEFAULT true,
          image_url TEXT,
          file_name TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS theme_colors (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
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
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS circle_analysis (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        circles JSONB NOT NULL DEFAULT '[1,2,3,4,5,6,7,8]'::jsonb,
        teams JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS zone_shrink_state (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        active BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_details (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        game_id TEXT,
        game_number TEXT,
        game_name TEXT,
        round_name TEXT,
        phase TEXT,
        match_id TEXT,
        map_name TEXT,
        status TEXT,
        start_time TEXT,
        enabled BOOLEAN NOT NULL DEFAULT false,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_results (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        match_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        permanent_team_id TEXT,
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
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_result_players (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        match_result_id INTEGER REFERENCES match_results(id) ON DELETE CASCADE,
        match_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        permanent_team_id TEXT,
        player_id TEXT,
        player_name TEXT,
        player_image TEXT,
        kills INTEGER NOT NULL DEFAULT 0,
        damage INTEGER NOT NULL DEFAULT 0,
        assists INTEGER NOT NULL DEFAULT 0,
        knockdowns INTEGER NOT NULL DEFAULT 0,
        survival_time INTEGER NOT NULL DEFAULT 0,
        character_asset_id TEXT,
        active_skill_asset_id TEXT,
        weapon_asset_id TEXT,
        pet_asset_id TEXT,
        raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_player_passive_skills (
        id SERIAL PRIMARY KEY,
        match_player_id INTEGER REFERENCES match_result_players(id) ON DELETE CASCADE,
        skill_asset_id TEXT,
        slot INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT match_player_passive_unique UNIQUE (match_player_id, slot)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_player_equipment_loadouts (
        id SERIAL PRIMARY KEY,
        match_player_id INTEGER REFERENCES match_result_players(id) ON DELETE CASCADE,
        equipment_asset_id TEXT,
        slot INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT match_player_equipment_unique UNIQUE (match_player_id, slot)
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
      ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT false;
    `);

   await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    is_active BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_auth_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS rank TEXT;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_settings (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        overall_ranking_enabled BOOLEAN NOT NULL DEFAULT false,
        team_elimination_player_enabled BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS spectator_groups (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS spectator_group_entries (
        id SERIAL PRIMARY KEY,
        spectator_group_id INTEGER NOT NULL REFERENCES spectator_groups(id) ON DELETE CASCADE,
        spectator_id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS is_playing BOOLEAN NOT NULL DEFAULT false;
    `);

    await pool.query(`
      ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS permanent_team_id TEXT;
    `);

    await pool.query(`
      UPDATE teams
      SET permanent_team_id = team_id
      WHERE permanent_team_id IS NULL OR TRIM(permanent_team_id) = '';
    `);

    await pool.query(`
      ALTER TABLE match_results
      ADD COLUMN IF NOT EXISTS permanent_team_id TEXT;
    `);

    await pool.query(`
      UPDATE match_results
      SET permanent_team_id = team_id
      WHERE permanent_team_id IS NULL OR TRIM(permanent_team_id) = '';
    `);

    await pool.query(`
      ALTER TABLE match_result_players
      ADD COLUMN IF NOT EXISTS permanent_team_id TEXT;
    `);

    await pool.query(`
      UPDATE match_result_players
      SET permanent_team_id = team_id
      WHERE permanent_team_id IS NULL OR TRIM(permanent_team_id) = '';
    `);

    await pool.query(`
      ALTER TABLE team_players
      ADD COLUMN IF NOT EXISTS player_uid TEXT;
    `);

    await pool.query(`
      ALTER TABLE team_players
      ADD COLUMN IF NOT EXISTS camera_link TEXT;
    `);

    for (const table of [
      "weapons",
      "characters",
      "skills",
      "pets",
      "roles",
      "equipment",
      "tournament_logos",
      "full_team_banners",
      "notification_team_banners",
      "tournament_assets",
    ]) {
      await pool.query(`
        ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
      `);

      await pool.query(`
        ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS team_id TEXT;
      `);
    }

    await pool.query(`
      ALTER TABLE theme_colors
      ADD COLUMN IF NOT EXISTS text_inverse_color TEXT;
    `);

    await pool.query(`
      INSERT INTO theme_colors (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO circle_analysis (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO zone_shrink_state (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING;
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

    await pool.query(
      `
      INSERT INTO tournaments (name, slug, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (slug) DO UPDATE
      SET name = EXCLUDED.name, updated_at = NOW();
      `,
      [DEFAULT_TOURNAMENT_NAME, DEFAULT_TOURNAMENT_SLUG],
    );

    const defaultTournamentResult = await pool.query(
      "SELECT id FROM tournaments WHERE slug = $1 LIMIT 1",
      [DEFAULT_TOURNAMENT_SLUG],
    );
    const defaultTournamentId = defaultTournamentResult.rows[0].id;

    for (const table of [
      "teams",
      "team_players",
      "country_logos",
      "weapons",
      "characters",
      "skills",
      "pets",
      "roles",
      "equipment",
      "tournament_logos",
      "full_team_banners",
      "notification_team_banners",
      "tournament_assets",
      "theme_colors",
      "circle_analysis",
      "zone_shrink_state",
      "tournament_settings",
      "game_details",
      "spectator_groups",
      "match_results",
      "match_result_players",
    ]) {
      await pool.query(`
        ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE;
      `);
      await pool.query(
        `UPDATE ${table} SET tournament_id = $1 WHERE tournament_id IS NULL`,
        [defaultTournamentId],
      );
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_${table}_tournament_id
        ON ${table}(tournament_id);
      `);
    }

    await dropConstraintWithDependents(pool, "teams", "teams_team_id_key");

    for (const statement of [
      "ALTER TABLE country_logos DROP CONSTRAINT IF EXISTS country_logos_image_path_key",
      "ALTER TABLE match_results DROP CONSTRAINT IF EXISTS match_results_match_team_unique",
      "ALTER TABLE match_result_players DROP CONSTRAINT IF EXISTS match_result_players_unique",
      "ALTER TABLE theme_colors DROP CONSTRAINT IF EXISTS theme_colors_single_row",
      "ALTER TABLE circle_analysis DROP CONSTRAINT IF EXISTS circle_analysis_single_row",
      "ALTER TABLE zone_shrink_state DROP CONSTRAINT IF EXISTS zone_shrink_state_single_row",
      "DROP INDEX IF EXISTS idx_match_results_match_team_unique",
    ]) {
      await pool.query(statement);
    }

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_tournament_team_id_unique
      ON teams(tournament_id, team_id);
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_tournament_permanent_team_id_unique
      ON teams(tournament_id, permanent_team_id)
      WHERE permanent_team_id IS NOT NULL AND TRIM(permanent_team_id) <> '';
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_country_logos_tournament_image_path_unique
      ON country_logos(tournament_id, image_path);
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_theme_colors_tournament_unique
      ON theme_colors(tournament_id);
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_circle_analysis_tournament_unique
      ON circle_analysis(tournament_id);
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_shrink_state_tournament_unique
      ON zone_shrink_state(tournament_id);
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_settings_tournament_unique
      ON tournament_settings(tournament_id);
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_spectator_groups_tournament_group_unique
      ON spectator_groups(tournament_id, group_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_spectator_group_entries_group_id
      ON spectator_group_entries(spectator_group_id);
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_spectator_group_entries_group_spectator_unique
      ON spectator_group_entries(spectator_group_id, spectator_id);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_users (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'viewer',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT tournament_users_unique UNIQUE (tournament_id, user_id)
      );
    `);

    await pool.query(`
      ALTER TABLE users
      ALTER COLUMN is_active SET DEFAULT false;
    `);

    // optional but recommended for esports realtime performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_team_id ON teams(team_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_team_rank ON teams(rank);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_team_players_team_id ON team_players(team_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_country_logos_image_path ON country_logos(image_path);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tournaments_slug ON tournaments(slug);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tournament_users_user_id ON tournament_users(user_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tournament_users_tournament_id ON tournament_users(tournament_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_auth_tokens_hash ON user_auth_tokens(token_hash);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_game_details_game_id ON game_details(game_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_game_details_match_id ON game_details(match_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_results_match_id ON match_results(match_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_results_team_id ON match_results(team_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_results_permanent_team_id
      ON match_results(permanent_team_id);
    `);

    await pool.query(`
      DELETE FROM match_results mr
      USING match_results duplicate
      WHERE
        mr.match_id = duplicate.match_id
        AND mr.team_id = duplicate.team_id
        AND mr.id < duplicate.id;
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_match_results_match_team_unique
      ON match_results(tournament_id, match_id, team_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_result_players_match_id ON match_result_players(match_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_result_players_team_id ON match_result_players(team_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_result_players_permanent_team_id
      ON match_result_players(permanent_team_id);
    `);

  } catch (err) {
    console.error("❌ initDB error:", err.message);
    throw err;
  }
};

module.exports = initDB;
