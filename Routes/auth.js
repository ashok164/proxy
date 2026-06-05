const express = require("express");
const crypto = require("crypto");

const pool = require("../Database/db");

const router = express.Router();

const TOKEN_TTL_DAYS = 7;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_ITERATIONS = 120000;
const PASSWORD_DIGEST = "sha512";
const DEFAULT_TOURNAMENT_NAME = "SAGGU FAMILY";
const DEFAULT_TOURNAMENT_SLUG = "saggu-family";

const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();
const normalizeSlug = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const ensureAuthTables = async () => {
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      is_active BOOLEAN NOT NULL DEFAULT false,
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_users (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT tournament_users_unique UNIQUE (tournament_id, user_id)
    )
  `);

  await pool.query(`
    ALTER TABLE users
    ALTER COLUMN is_active SET DEFAULT false
  `);

  await pool.query("CREATE INDEX IF NOT EXISTS idx_tournaments_slug ON tournaments(slug)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_tournament_users_user_id ON tournament_users(user_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_tournament_users_tournament_id ON tournament_users(tournament_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_auth_tokens_hash
    ON user_auth_tokens(token_hash)
  `);

  await pool.query(
    `
    INSERT INTO tournaments (name, slug, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (slug) DO UPDATE
    SET name = EXCLUDED.name, updated_at = NOW()
    `,
    [DEFAULT_TOURNAMENT_NAME, DEFAULT_TOURNAMENT_SLUG],
  );
};

const formatTournament = (row = {}) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  domain: row.domain || "",
  role: row.access_role || row.role || "",
  isActive: row.is_active ?? true,
  pullTournamentAssets: Boolean(row.pull_tournament_assets),
});

const formatUser = (user = {}) => ({
  id: user.id,
  name: user.name || "",
  email: user.email,
  role: user.role || "user",
  isActive: user.is_active ?? true,
  createdAt: user.created_at,
  updatedAt: user.updated_at,
});

const getUserTournaments = async (user) => {
  if (!user?.id) return [];

  if (user.role === "super_admin" || user.role === "admin") {
    const result = await pool.query(`
      SELECT *, 'owner' AS access_role
      FROM tournaments
      WHERE is_active = true
      ORDER BY id ASC
    `);
    return result.rows.map(formatTournament);
  }

  const result = await pool.query(
    `
    SELECT t.*, tu.role AS access_role
    FROM tournament_users tu
    JOIN tournaments t ON t.id = tu.tournament_id
    WHERE tu.user_id = $1 AND t.is_active = true
    ORDER BY t.id ASC
    `,
    [user.id],
  );

  return result.rows.map(formatTournament);
};

const formatUserWithTournaments = async (user) => ({
  ...formatUser(user),
  tournaments: await getUserTournaments(user),
});

const promoteFirstUserToSuperAdmin = async (user) => {
  if (!user?.id) return user;

  const result = await pool.query(
    `
    UPDATE users
    SET role = 'super_admin',
        is_active = true,
        updated_at = NOW()
    WHERE id = $1
      AND id = (SELECT MIN(id) FROM users)
      AND role <> 'super_admin'
    RETURNING *
    `,
    [user.id],
  );

  return result.rows[0] || user;
};

const requireAdmin = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return null;
  }

  if (!["admin", "super_admin"].includes(user.role)) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return null;
  }

  return user;
};

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

    const existingUsers = await pool.query("SELECT COUNT(*)::INT AS count FROM users");
    const isFirstUser = Number(existingUsers.rows[0]?.count || 0) === 0;
    const role = isFirstUser ? "super_admin" : "user";
    const isActive = isFirstUser;
    const { salt, hash } = hashPassword(credentials.password);
    const result = await pool.query(
      `
      INSERT INTO users (name, email, password_hash, password_salt, role, is_active, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id, name, email, role, is_active, created_at, updated_at
      `,
      [
        String(req.body.name ?? "").trim() || null,
        credentials.email,
        hash,
        salt,
        role,
        isActive,
      ],
    );

    const user = result.rows[0];
    if (isFirstUser) {
      await pool.query(
        `
        INSERT INTO tournament_users (tournament_id, user_id, role, updated_at)
        SELECT id, $1, 'owner', NOW()
        FROM tournaments
        WHERE slug = $2
        ON CONFLICT (tournament_id, user_id) DO UPDATE
        SET role = EXCLUDED.role, updated_at = NOW()
        `,
        [user.id, DEFAULT_TOURNAMENT_SLUG],
      );
    }

    if (!isActive) {
      return res.status(201).json({
        success: true,
        pendingApproval: true,
        message: "Registration submitted. An admin must approve your account before login.",
        user: formatUser(user),
      });
    }

    const auth = await createToken(user.id);

    return res.status(201).json({
      success: true,
      token: auth.token,
      expiresAt: auth.expiresAt,
      user: await formatUserWithTournaments(user),
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
      "SELECT * FROM users WHERE email = $1 LIMIT 1",
      [credentials.email],
    );
    const user = result.rows[0];

    if (!user || !verifyPassword(credentials.password, user)) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: "Your account is pending admin approval.",
      });
    }

    const auth = await createToken(user.id);

    return res.json({
      success: true,
      token: auth.token,
      expiresAt: auth.expiresAt,
      user: await formatUserWithTournaments(user),
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

    const promotedUser = await promoteFirstUserToSuperAdmin(user);

    return res.json({ success: true, user: await formatUserWithTournaments(promotedUser) });
  } catch (err) {
    console.error("User me failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/users", async (req, res) => {
  try {
    await ensureAuthTables();
    await requireAdmin(req, res);
    if (res.headersSent) return;

    const result = await pool.query(`
      SELECT id, name, email, role, is_active, created_at, updated_at
      FROM users
      ORDER BY is_active ASC, created_at DESC
    `);

    return res.json({ success: true, data: result.rows.map(formatUser) });
  } catch (err) {
    console.error("Users list failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/tournaments", async (req, res) => {
  try {
    await ensureAuthTables();
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    return res.json({
      success: true,
      data: await getUserTournaments(user),
    });
  } catch (err) {
    console.error("Tournament list failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/tournaments", async (req, res) => {
  try {
    await ensureAuthTables();
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const name = String(req.body.name || "").trim();
    const slug = normalizeSlug(req.body.slug || name);
    const domain = String(req.body.domain || "").trim() || null;
    const pullTournamentAssets = Boolean(req.body.pullTournamentAssets || req.body.pull_tournament_assets);

    if (!name || !slug) {
      return res.status(400).json({
        success: false,
        message: "Tournament name is required",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO tournaments (name, slug, domain, pull_tournament_assets, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
      `,
      [name, slug, domain, pullTournamentAssets],
    );

    await pool.query(
      `
      INSERT INTO tournament_users (tournament_id, user_id, role, updated_at)
      VALUES ($1, $2, 'owner', NOW())
      ON CONFLICT (tournament_id, user_id) DO UPDATE
      SET role = EXCLUDED.role, updated_at = NOW()
      `,
      [result.rows[0].id, admin.id],
    );

    return res.status(201).json({
      success: true,
      message: "Tournament created successfully",
      data: formatTournament({ ...result.rows[0], access_role: "owner" }),
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Tournament slug already exists",
      });
    }

    console.error("Tournament create failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/tournaments/:id", async (req, res) => {
  try {
    await ensureAuthTables();
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const tournamentId = Number(req.params.id);
    if (!Number.isInteger(tournamentId)) {
      return res.status(400).json({ success: false, message: "Invalid tournament id" });
    }

    const name = String(req.body.name || "").trim();
    const slugInput = req.body.slug === undefined ? undefined : normalizeSlug(req.body.slug);
    const domain =
      req.body.domain === undefined
        ? undefined
        : String(req.body.domain || "").trim() || null;
    const isActive =
      typeof req.body.isActive === "boolean"
        ? req.body.isActive
        : typeof req.body.is_active === "boolean"
          ? req.body.is_active
          : undefined;
    const pullTournamentAssets =
      typeof req.body.pullTournamentAssets === "boolean"
        ? req.body.pullTournamentAssets
        : typeof req.body.pull_tournament_assets === "boolean"
          ? req.body.pull_tournament_assets
          : undefined;

    if (req.body.name !== undefined && !name) {
      return res.status(400).json({ success: false, message: "Tournament name is required" });
    }

    if (req.body.slug !== undefined && !slugInput) {
      return res.status(400).json({ success: false, message: "Tournament slug is required" });
    }

    const result = await pool.query(
      `
      UPDATE tournaments
      SET
        name = CASE WHEN $1::boolean THEN $2 ELSE name END,
        slug = CASE WHEN $3::boolean THEN $4 ELSE slug END,
        domain = CASE WHEN $5::boolean THEN $6 ELSE domain END,
        is_active = CASE WHEN $7::boolean THEN $8 ELSE is_active END,
        pull_tournament_assets = CASE WHEN $9::boolean THEN $10 ELSE pull_tournament_assets END,
        updated_at = NOW()
      WHERE id = $11
      RETURNING *
      `,
      [
        req.body.name !== undefined,
        name,
        slugInput !== undefined,
        slugInput || "",
        domain !== undefined,
        domain,
        isActive !== undefined,
        isActive || false,
        pullTournamentAssets !== undefined,
        pullTournamentAssets || false,
        tournamentId,
      ],
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Tournament not found" });
    }

    return res.json({
      success: true,
      message: "Tournament updated successfully",
      data: formatTournament({ ...result.rows[0], access_role: "owner" }),
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Tournament slug already exists",
      });
    }

    console.error("Tournament update failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/tournaments/:id", async (req, res) => {
  try {
    await ensureAuthTables();
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const tournamentId = Number(req.params.id);
    if (!Number.isInteger(tournamentId)) {
      return res.status(400).json({ success: false, message: "Invalid tournament id" });
    }

    const result = await pool.query(
      `
      UPDATE tournaments
      SET is_active = false, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [tournamentId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Tournament not found" });
    }

    return res.json({
      success: true,
      message: "Tournament deleted successfully",
      data: formatTournament({ ...result.rows[0], access_role: "owner" }),
    });
  } catch (err) {
    console.error("Tournament delete failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/users/:id/tournaments", async (req, res) => {
  try {
    await ensureAuthTables();
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const targetUserId = Number(req.params.id);
    const tournamentSlug = String(req.body.tournamentSlug || req.body.slug || "").trim();
    const tournamentRole = ["owner", "editor", "viewer"].includes(req.body.role)
      ? req.body.role
      : "viewer";

    if (!Number.isInteger(targetUserId) || !tournamentSlug) {
      return res.status(400).json({
        success: false,
        message: "user id and tournamentSlug are required",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO tournament_users (tournament_id, user_id, role, updated_at)
      SELECT id, $1, $2, NOW()
      FROM tournaments
      WHERE slug = $3
      ON CONFLICT (tournament_id, user_id) DO UPDATE
      SET role = EXCLUDED.role, updated_at = NOW()
      RETURNING *
      `,
      [targetUserId, tournamentRole, tournamentSlug],
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Tournament not found" });
    }

    return res.json({
      success: true,
      message: "Tournament access saved",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("Tournament access save failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/users/:id", async (req, res) => {
  try {
    await ensureAuthTables();
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const targetUserId = Number(req.params.id);
    if (!Number.isInteger(targetUserId)) {
      return res.status(400).json({ success: false, message: "Invalid user id" });
    }

    const nextRole = ["user", "admin", "super_admin"].includes(req.body.role)
      ? req.body.role
      : undefined;
    const nextActive =
      typeof req.body.isActive === "boolean"
        ? req.body.isActive
        : typeof req.body.is_active === "boolean"
          ? req.body.is_active
          : undefined;

    const result = await pool.query(
      `
      UPDATE users
      SET
        role = COALESCE($1, role),
        is_active = COALESCE($2, is_active),
        updated_at = NOW()
      WHERE id = $3
      RETURNING id, name, email, role, is_active, created_at, updated_at
      `,
      [nextRole || null, nextActive, targetUserId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.json({ success: true, user: formatUser(result.rows[0]) });
  } catch (err) {
    console.error("User update failed:", err.message);
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
