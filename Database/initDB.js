const pool = require("./db");

const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        rank TEXT,
        team_id TEXT UNIQUE NOT NULL,
        team_name TEXT,
        short_tag TEXT,
        team_logo TEXT,
        country_logo TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_players (
        id SERIAL PRIMARY KEY,
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
        image_path TEXT UNIQUE NOT NULL,
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
        id INTEGER PRIMARY KEY DEFAULT 1,
        use_default_colors BOOLEAN NOT NULL DEFAULT false,
        primary_color TEXT,
        secondary_color TEXT,
        accent_color TEXT,
        background_color TEXT,
        surface_color TEXT,
        surface_alt_color TEXT,
        text_primary_color TEXT,
        text_secondary_color TEXT,
        border_color TEXT,
        success_color TEXT,
        warning_color TEXT,
        danger_color TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT theme_colors_single_row CHECK (id = 1)
      );
    `);

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
      CREATE TABLE IF NOT EXISTS zone_shrink_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        active BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT zone_shrink_state_single_row CHECK (id = 1)
      );
    `);

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
      CREATE TABLE IF NOT EXISTS match_result_players (
        id SERIAL PRIMARY KEY,
        match_result_id INTEGER REFERENCES match_results(id) ON DELETE CASCADE,
        match_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
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
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT match_result_players_unique UNIQUE (match_id, team_id, player_id)
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
      CREATE TABLE IF NOT EXISTS match_team_mappings (
        id SERIAL PRIMARY KEY,
        match_id TEXT NOT NULL,
        room_team_id TEXT NOT NULL,
        permanent_team_id TEXT NOT NULL REFERENCES teams(team_id) ON UPDATE CASCADE ON DELETE CASCADE,
        mapped_team_name TEXT,
        mapped_team_tag TEXT,
        slot_number INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT match_team_mappings_match_room_unique UNIQUE (match_id, room_team_id),
        CONSTRAINT match_team_mappings_match_team_unique UNIQUE (match_id, permanent_team_id)
      );
    `);

    await pool.query(`
      ALTER TABLE match_team_mappings
      ADD COLUMN IF NOT EXISTS mapped_team_name TEXT;
    `);

    await pool.query(`
      ALTER TABLE match_team_mappings
      ADD COLUMN IF NOT EXISTS mapped_team_tag TEXT;
    `);

    await pool.query(`
      ALTER TABLE match_team_mappings
      DROP CONSTRAINT IF EXISTS match_team_mappings_permanent_team_id_fkey;

      ALTER TABLE match_team_mappings
      ADD CONSTRAINT match_team_mappings_permanent_team_id_fkey
      FOREIGN KEY (permanent_team_id)
      REFERENCES teams(team_id)
      ON UPDATE CASCADE
      ON DELETE CASCADE;
    `);

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
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    is_active BOOLEAN NOT NULL DEFAULT true,
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
      CREATE INDEX IF NOT EXISTS idx_user_auth_tokens_hash ON user_auth_tokens(token_hash);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_game_details_game_id ON game_details(game_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_game_details_match_id ON game_details(match_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_game_details_mapping_template_id ON game_details(mapping_template_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_results_match_id ON match_results(match_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_results_team_id ON match_results(team_id);
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
      ON match_results(match_id, team_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_result_players_match_id ON match_result_players(match_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_result_players_team_id ON match_result_players(team_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_team_mappings_match_id ON match_team_mappings(match_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_match_team_mappings_permanent_team_id ON match_team_mappings(permanent_team_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_mapping_templates_updated_at ON mapping_templates(updated_at);
    `);

  } catch (err) {
    console.error("❌ initDB error:", err.message);
    throw err;
  }
};

module.exports = initDB;
