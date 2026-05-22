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

    await pool.query(`
      INSERT INTO theme_colors (id)
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
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_auth_tokens_hash ON user_auth_tokens(token_hash);
    `);

  } catch (err) {
    console.error("❌ initDB error:", err.message);
  }
};

module.exports = initDB;
