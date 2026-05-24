const dotenv = require("dotenv");
const path = require("path");
const { Pool } = require("pg");

/* ================= ENV ================= */
const NODE_ENV = process.env.NODE_ENV || "development";
process.env.NODE_ENV = NODE_ENV;

const envFile = NODE_ENV === "production" ? "../.env.production" : "../.env.local";
const envPath = path.join(__dirname, envFile);

dotenv.config({ path: envPath, override: true });
/**========================================= */

console.log("DB CONFIG:", {
  envFile,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  database: process.env.DB_NAME,
  passwordSet: Boolean(process.env.DB_PASSWORD),
});

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: String(process.env.DB_PASSWORD),
  port: process.env.DB_PORT || 5432,
});

module.exports = pool;
