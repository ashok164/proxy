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
      ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS rank TEXT;
    `);


    // optional but recommended for esports realtime performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_team_id ON teams(team_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_team_rank ON teams(rank);
    `);

  } catch (err) {
    console.error("❌ initDB error:", err.message);
  }
};

module.exports = initDB;
