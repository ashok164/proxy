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

  } catch (err) {
    console.error("❌ initDB error:", err.message);
  }
};

module.exports = initDB;
