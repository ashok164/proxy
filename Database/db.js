const dotenv = require("dotenv");
const { Pool } = require("pg");

/* ================= ENV ================= */
const NODE_ENV = process.env.NODE_ENV || "development";
process.env.NODE_ENV = NODE_ENV;

const envFile = NODE_ENV === "production" ? "../.env.production" : "../.env.local";

dotenv.config({ path: envFile });
/**========================================= */

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: String(process.env.DB_PASSWORD),
  port: process.env.DB_PORT || 5432,
});

module.exports = pool;
