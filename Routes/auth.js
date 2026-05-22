const express = require("express");
const crypto = require("crypto");

const pool = require("../Database/db");

const router = express.Router();

const TOKEN_TTL_DAYS = 7;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_ITERATIONS = 120000;
const PASSWORD_DIGEST = "sha512";

const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

const ensureAuthTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_auth_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_auth_tokens_hash
    ON user_auth_tokens(token_hash)
  `);
};

const formatUser = (user = {}) => ({
  id: user.id,
  name: user.name || "",
  email: user.email,
  role: user.role || "user",
  isActive: user.is_active ?? true,
  createdAt: user.created_at,
  updatedAt: user.updated_at,
});

const hashPassword = (password, salt = crypto.randomBytes(16).toString("hex")) => {
  const hash = crypto
    .pbkdf2Sync(
      String(password),
      salt,
      PASSWORD_ITERATIONS,
      PASSWORD_KEY_LENGTH,
      PASSWORD_DIGEST,
    )
    .toString("hex");

  return { salt, hash };
};

const timingSafeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left), "hex");
  const rightBuffer = Buffer.from(String(right), "hex");

  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const verifyPassword = (password, user) => {
  const { hash } = hashPassword(password, user.password_salt);
  return timingSafeEqual(hash, user.password_hash);
};

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const createToken = async (userId) => {
  await ensureAuthTables();

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);

  const result = await pool.query(
    `
    INSERT INTO user_auth_tokens (user_id, token_hash, expires_at)
    VALUES ($1, $2, NOW() + ($3::TEXT || ' days')::INTERVAL)
    RETURNING expires_at
    `,
    [userId, tokenHash, TOKEN_TTL_DAYS],
  );

  return {
    token,
    expiresAt: result.rows[0].expires_at,
  };
};

const getBearerToken = (req) => {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
};

const getUserFromRequest = async (req) => {
  const token = getBearerToken(req);
  if (!token) return null;

  const result = await pool.query(
    `
    SELECT users.*
    FROM user_auth_tokens
    JOIN users ON users.id = user_auth_tokens.user_id
    WHERE user_auth_tokens.token_hash = $1
      AND user_auth_tokens.expires_at > NOW()
      AND users.is_active = true
    LIMIT 1
    `,
    [hashToken(token)],
  );

  return result.rows[0] || null;
};

const requireEmailAndPassword = (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password ?? "");

  if (!email || !password) {
    res.status(400).json({
      success: false,
      message: "Email and password are required",
    });
    return null;
  }

  return { email, password };
};

router.post("/register", async (req, res) => {
  try {
    await ensureAuthTables();

    const credentials = requireEmailAndPassword(req, res);
    if (!credentials) return;

    if (credentials.password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    const { salt, hash } = hashPassword(credentials.password);
    const result = await pool.query(
      `
      INSERT INTO users (name, email, password_hash, password_salt, role, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id, name, email, role, is_active, created_at, updated_at
      `,
      [
        String(req.body.name ?? "").trim() || null,
        credentials.email,
        hash,
        salt,
        "user",
      ],
    );

    const user = result.rows[0];
    const auth = await createToken(user.id);

    return res.status(201).json({
      success: true,
      token: auth.token,
      expiresAt: auth.expiresAt,
      user: formatUser(user),
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Email already registered",
      });
    }

    console.error("User register failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    await ensureAuthTables();

    const credentials = requireEmailAndPassword(req, res);
    if (!credentials) return;

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1 AND is_active = true LIMIT 1",
      [credentials.email],
    );
    const user = result.rows[0];

    if (!user || !verifyPassword(credentials.password, user)) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const auth = await createToken(user.id);

    return res.json({
      success: true,
      token: auth.token,
      expiresAt: auth.expiresAt,
      user: formatUser(user),
    });
  } catch (err) {
    console.error("User login failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/me", async (req, res) => {
  try {
    await ensureAuthTables();

    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    return res.json({ success: true, user: formatUser(user) });
  } catch (err) {
    console.error("User me failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/logout", async (req, res) => {
  try {
    await ensureAuthTables();

    const token = getBearerToken(req);
    if (token) {
      await pool.query("DELETE FROM user_auth_tokens WHERE token_hash = $1", [
        hashToken(token),
      ]);
    }

    return res.json({ success: true, message: "Logged out" });
  } catch (err) {
    console.error("User logout failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
