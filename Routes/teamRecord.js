const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const pool = require("../Database/db");
const { dropConstraintWithDependents } = require("../Database/schemaMigrations");
const {
  ensureTournamentColumn,
  getTournamentIdFromRequest,
} = require("../Data/tournamentContext");

const router = express.Router({ mergeParams: true });

/* =========================================================
   UPLOAD FOLDER SETUP
========================================================= */
const uploadPath = path.join(__dirname, "../uploads");
const TEAM_LOGO_DIR = "teamLogo";
const COUNTRY_LOGO_DIR = "countryLogo";
const countryLogoMetaPath = path.join(
  uploadPath,
  COUNTRY_LOGO_DIR,
  "metadata.json",
);

fs.mkdirSync(path.join(uploadPath, TEAM_LOGO_DIR), { recursive: true });
fs.mkdirSync(path.join(uploadPath, COUNTRY_LOGO_DIR), { recursive: true });

/* =========================================================
   MULTER SETUP
========================================================= */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder =
      file.fieldname === "countryLogo" ? COUNTRY_LOGO_DIR : TEAM_LOGO_DIR;
    cb(null, path.join(uploadPath, folder));
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ["image/png", "image/jpg", "image/jpeg", "image/webp"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

/* =========================================================
   UTILITIES
========================================================= */
const getBaseUrl = (req) => `${req.protocol}://${req.get("host")}`;

const normalizeTeamId = (value) => {
  const clean = String(value ?? "").trim();
  if (!/^\d+$/.test(clean)) return clean;

  const numberValue = Number(clean);
  return Number.isSafeInteger(numberValue) ? String(numberValue) : clean;
};

const formatImageUrl = (baseUrl, logoPath) => {
  if (!logoPath) return null;

  if (logoPath.startsWith("http://") || logoPath.startsWith("https://")) {
    return logoPath;
  }

  return `${baseUrl}/uploads/${logoPath.replace(/^\/?uploads\//i, "")}`;
};

const toBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const clean = String(value).trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(clean);
};

const getUploadRelativePath = (file, folder) =>
  file ? path.posix.join(folder, file.filename) : null;

const normalizeUploadReference = (value, fallbackFolder) => {
  if (!value) return null;

  const clean = String(value)
    .trim()
    .replace(/^https?:\/\/[^/]+\/uploads\//i, "")
    .replace(/^\/?uploads\//i, "")
    .replace(/\\/g, "/");

  if (!clean) return null;
  return clean.includes("/")
    ? clean
    : path.posix.join(fallbackFolder, path.basename(clean));
};

const resolveUploadPath = (storedPath, fallbackFolder) => {
  if (!storedPath) return null;

  const clean = normalizeUploadReference(storedPath, fallbackFolder);

  const root = path.resolve(uploadPath);
  const relativePaths = clean.includes("/")
    ? [clean]
    : [path.posix.join(fallbackFolder, path.basename(clean)), path.basename(clean)];

  for (const relativePath of relativePaths) {
    const resolved = path.resolve(uploadPath, relativePath);
    if (resolved.startsWith(root + path.sep) && fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return null;
};

const formatCountryLogoLibraryRow = (baseUrl, row) => ({
  id: row.id,
  name: row.name || "",
  countryLogo: formatImageUrl(baseUrl, row.image_path),
  path: row.image_path,
  filename: row.file_name || path.basename(row.image_path),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const getCountryLogoNameInput = (body = {}) =>
  body.name ?? body.flagName ?? body.countryName;

const readCountryLogoMeta = () => {
  try {
    if (!fs.existsSync(countryLogoMetaPath)) return {};
    return JSON.parse(fs.readFileSync(countryLogoMetaPath, "utf8"));
  } catch (err) {
    console.error("Failed reading country logo metadata:", err.message);
    return {};
  }
};

const writeCountryLogoMeta = (metadata) => {
  fs.writeFileSync(countryLogoMetaPath, JSON.stringify(metadata, null, 2));
};

const setCountryLogoName = (logoPath, name) => {
  if (name === undefined) return;

  const metadata = readCountryLogoMeta();
  metadata[logoPath] = {
    ...(metadata[logoPath] || {}),
    name: String(name || "").trim(),
  };
  writeCountryLogoMeta(metadata);
};

const moveCountryLogoMeta = (oldLogoPath, newLogoPath, name) => {
  const metadata = readCountryLogoMeta();
  const current = metadata[oldLogoPath] || {};
  delete metadata[oldLogoPath];
  metadata[newLogoPath] = {
    ...current,
    name:
      name !== undefined
        ? String(name || "").trim()
        : current.name || "",
  };
  writeCountryLogoMeta(metadata);
};

const deleteCountryLogoMeta = (logoPath) => {
  const metadata = readCountryLogoMeta();
  delete metadata[logoPath];
  writeCountryLogoMeta(metadata);
};

const ensureCountryLogoTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS country_logos (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      tournament_id INTEGER,
      image_path TEXT NOT NULL,
      file_name TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await ensureTournamentColumn(pool, "country_logos");
  await pool.query("ALTER TABLE country_logos DROP CONSTRAINT IF EXISTS country_logos_image_path_key");
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_country_logos_tournament_image_path_unique
    ON country_logos(tournament_id, image_path)
  `);
};

const ensureTeamTableScope = async () => {
  await ensureTournamentColumn(pool, "teams");
  await pool.query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS is_playing BOOLEAN NOT NULL DEFAULT false
  `);
  await pool.query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS permanent_team_id TEXT
  `);
  await pool.query(`
    UPDATE teams
    SET permanent_team_id = team_id
    WHERE permanent_team_id IS NULL OR TRIM(permanent_team_id) = ''
  `);
  await dropConstraintWithDependents(pool, "teams", "teams_team_id_key");
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_tournament_team_id_unique
    ON teams(tournament_id, team_id)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_tournament_permanent_team_id_unique
    ON teams(tournament_id, permanent_team_id)
    WHERE permanent_team_id IS NOT NULL AND TRIM(permanent_team_id) <> ''
  `);
};

const upsertCountryLogo = async (logoPath, name, tournamentId) => {
  if (!logoPath) return null;

  const result = await pool.query(
    `
    INSERT INTO country_logos (tournament_id, name, image_path, file_name, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (tournament_id, image_path) DO UPDATE
    SET
      name = CASE
        WHEN country_logos.name IS NULL OR country_logos.name = ''
        THEN EXCLUDED.name
        ELSE country_logos.name
      END,
      file_name = EXCLUDED.file_name,
      updated_at = NOW()
    RETURNING *
    `,
    [tournamentId, String(name || "").trim(), logoPath, path.basename(logoPath)],
  );

  return result.rows[0];
};

const getCountryLogoPathFromInput = async (body = {}, tournamentId) => {
  const countryLogoId = body.countryLogoId || body.country_logo_id;
  if (countryLogoId) {
    await ensureCountryLogoTable();

    const result = await pool.query(
      "SELECT image_path FROM country_logos WHERE id = $1 AND tournament_id = $2",
      [countryLogoId, tournamentId],
    );

    if (result.rows.length) return result.rows[0].image_path;
  }

  return normalizeUploadReference(
    body.countryLogoPath ||
      body.country_logo_path ||
      body.countryLogo ||
      body.country_logo,
    COUNTRY_LOGO_DIR,
  );
};

const getCountryLogoPathAt = async (body = {}, index, tournamentId) => {
  const getArrayItem = (value) => {
    if (Array.isArray(value)) return value[index];
    return index === 0 ? value : undefined;
  };

  const countryLogoId = getArrayItem(body.countryLogoId || body.country_logo_id);
  if (countryLogoId) {
    await ensureCountryLogoTable();

    const result = await pool.query(
      "SELECT image_path FROM country_logos WHERE id = $1 AND tournament_id = $2",
      [countryLogoId, tournamentId],
    );

    if (result.rows.length) return result.rows[0].image_path;
  }

  return normalizeUploadReference(
    getArrayItem(body.countryLogoPath || body.country_logo_path) ||
      getArrayItem(body.countryLogo || body.country_logo),
    COUNTRY_LOGO_DIR,
  );
};

const syncCountryLogoCatalog = async (tournamentId) => {
  await ensureCountryLogoTable();

  const metadata = readCountryLogoMeta();
  const logoPaths = new Set();

  const teamResult = await pool.query(
    `
    SELECT DISTINCT country_logo
    FROM teams
    WHERE tournament_id = $1 AND country_logo IS NOT NULL AND country_logo <> ''
    `,
    [tournamentId],
  );
  teamResult.rows.forEach((row) => logoPaths.add(row.country_logo));

  const countryLogoPath = path.join(uploadPath, COUNTRY_LOGO_DIR);
  const allowedExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

  if (fs.existsSync(countryLogoPath)) {
    for (const file of fs.readdirSync(countryLogoPath, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      if (!allowedExtensions.has(path.extname(file.name).toLowerCase())) continue;
      logoPaths.add(path.posix.join(COUNTRY_LOGO_DIR, file.name));
    }
  }

  for (const logoPath of logoPaths) {
    await upsertCountryLogo(logoPath, metadata[logoPath]?.name || "", tournamentId);
  }
};

// Helper utility to clean up physical disk files on exception failure states
const safelyDeleteFiles = (filesArray) => {
  if (!filesArray) return;
  filesArray.forEach((file) => {
    const filepath = typeof file === "string" ? file : file?.path;
    if (filepath && fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch (err) {
        console.error("Failed cleaning up disk file:", filepath, err.message);
      }
    }
  });
};

/* =========================================================
   CREATE / BULK UPSERT TEAMS (Accepts Array Stack Data)
========================================================= */
router.post(
  "/create",
  upload.fields([
    { name: "teamLogo", maxCount: 20 }, // Dynamic batch allowance boundary scale
    { name: "countryLogo", maxCount: 20 },
  ]),
  async (req, res) => {
    const baseUrl = getBaseUrl(req);

    // Track references to roll back files if database transactions fail
    const rollbackCache = [];
    if (req.files?.teamLogo) rollbackCache.push(...req.files.teamLogo);
    if (req.files?.countryLogo) rollbackCache.push(...req.files.countryLogo);

    try {
      const tournamentId = await getTournamentIdFromRequest(pool, req);
      await ensureTeamTableScope();
      /*
        Frontend payloads must pass standard scalar arrays for metadata:
        e.g. formData.append("teamId", "12"); formData.append("teamId", "13");
        Express/Multer groups identical names as ordered primitive arrays: req.body.teamId = ["12", "13"]
      */
      const teamIdInput = req.body.teamId || req.body.team_id;
      const teamNameInput = req.body.teamName || req.body.team_name;
      const shortTagInput = req.body.shortTag || req.body.short_tag;
      const isPlayingInput = req.body.isPlaying || req.body.is_playing;

      if (!teamIdInput) {
        safelyDeleteFiles(rollbackCache);
        return res
          .status(400)
          .json({
            success: false,
            message: "No team records found or teamId missing",
          });
      }

      // Convert standalone single item strings to iterable arrays for uniformity
      const teamIds = Array.isArray(teamIdInput) ? teamIdInput : [teamIdInput];
      const teamNames = Array.isArray(teamNameInput)
        ? teamNameInput
        : [teamNameInput];
      const shortTags = Array.isArray(shortTagInput)
        ? shortTagInput
        : [shortTagInput];
      const isPlayingValues = Array.isArray(isPlayingInput)
        ? isPlayingInput
        : [isPlayingInput];

      // Safe indexed tracking pointers for binary attachments
      let teamLogoIndex = 0;
      let countryLogoIndex = 0;

      const processedRows = [];

      await ensureCountryLogoTable();

      // Open a robust atomic SQL Transaction
      await pool.query("BEGIN");

      for (let i = 0; i < teamIds.length; i++) {
        const teamId = normalizeTeamId(teamIds[i]);
        const teamName = teamNames[i] || null;
        const shortTag = shortTags[i] || null;
        const isPlaying = toBoolean(isPlayingValues[i], false);

        /*
           To link files to their respective team array records over multipart requests:
           If the frontend form appends a file field ONLY when it exists, we track indices contextually.
           Alternatively, frontend can append text fields indicating true/false file presence flag counters.
        */
        const teamLogo =
          getUploadRelativePath(
            req.files?.teamLogo?.[teamLogoIndex],
            TEAM_LOGO_DIR,
          ) || null;
        teamLogoIndex++;

        const countryLogo =
          getUploadRelativePath(
            req.files?.countryLogo?.[countryLogoIndex],
            COUNTRY_LOGO_DIR,
          ) ||
            (await getCountryLogoPathAt(req.body, i, tournamentId)) ||
          null;
        countryLogoIndex++;

        const result = await pool.query(
          `
          INSERT INTO teams (tournament_id, team_id, permanent_team_id, team_name, short_tag, team_logo, country_logo, is_playing)
          VALUES ($1, $2, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (tournament_id, team_id) DO UPDATE 
          SET 
            team_name = EXCLUDED.team_name,
            short_tag = EXCLUDED.short_tag,
            team_logo = COALESCE(EXCLUDED.team_logo, teams.team_logo),
            country_logo = COALESCE(EXCLUDED.country_logo, teams.country_logo),
            is_playing = EXCLUDED.is_playing,
            updated_at = NOW()
          RETURNING *
          `,
          [tournamentId, teamId, teamName, shortTag, teamLogo, countryLogo, isPlaying],
        );

        const row = result.rows[0];
        if (countryLogo) await upsertCountryLogo(countryLogo, "", tournamentId);
        row.team_logo = formatImageUrl(baseUrl, row.team_logo);
        row.country_logo = formatImageUrl(baseUrl, row.country_logo);
        processedRows.push(row);
      }

      // Commit the transaction to save changes
      await pool.query("COMMIT");

      res.json({ success: true, data: processedRows });
    } catch (err) {
      await pool.query("ROLLBACK");
      safelyDeleteFiles(rollbackCache);
      console.error("Bulk upload processing execution caught error:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

/* =========================================================
   GET ALL TEAMS
========================================================= */
router.get("/all", async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    await ensureTeamTableScope();
    const result = await pool.query(`
      SELECT *
      FROM teams
      WHERE tournament_id = $1
      ORDER BY
        CASE WHEN team_id ~ '^[0-9]+$' THEN team_id::BIGINT END ASC NULLS LAST,
        team_id ASC
    `, [tournamentId]);

    const data = result.rows.map((row) => ({
      ...row,
      team_logo: formatImageUrl(baseUrl, row.team_logo),
      country_logo: formatImageUrl(baseUrl, row.country_logo),
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   GET TODAYS PLAYING TEAMS FOR SHEETS / APP SCRIPT
========================================================= */
router.get("/todays-playing", async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    await ensureTeamTableScope();

    const sql = [
      "SELECT id, team_id, permanent_team_id, team_name, short_tag, team_logo",
      "FROM teams",
      "WHERE tournament_id = $1 AND is_playing = true",
      "ORDER BY",
      "CASE WHEN team_id ~ '^[0-9]+$' THEN team_id::BIGINT END ASC NULLS LAST,",
      "team_id ASC",
    ].join("\n");

    const result = await pool.query(sql, [tournamentId]);

    const data = result.rows.map((row) => {
      const logo = formatImageUrl(baseUrl, row.team_logo) || "";
      return {
        id: row.id,
        teamId: row.team_id,
        permanentTeamId: row.permanent_team_id || row.team_id,
        name: row.team_name || "",
        tag: row.short_tag || "",
        logo,
        teamLogo: logo,
      };
    });

    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
});

router.patch("/:id/playing", async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    await ensureTeamTableScope();
    const isPlaying = toBoolean(req.body.isPlaying ?? req.body.is_playing, false);

    const result = await pool.query(
      `
      UPDATE teams
      SET is_playing = $1, updated_at = NOW()
      WHERE id = $2 AND tournament_id = $3
      RETURNING *
      `,
      [isPlaying, req.params.id, tournamentId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const row = result.rows[0];
    row.team_logo = formatImageUrl(baseUrl, row.team_logo);
    row.country_logo = formatImageUrl(baseUrl, row.country_logo);

    res.json({ success: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   GET TEAM BY GARENA TEAM_ID
========================================================= */
router.get("/by-team-id/:teamId", async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const teamId = normalizeTeamId(req.params.teamId);
    const result = await pool.query(
      "SELECT * FROM teams WHERE team_id = $1 AND tournament_id = $2",
      [teamId, tournamentId],
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Team not found" });
    }

    const row = result.rows[0];
    row.team_logo = formatImageUrl(baseUrl, row.team_logo);
    row.country_logo = formatImageUrl(baseUrl, row.country_logo);

    res.json({ success: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   GET COUNTRY LOGO BY GARENA TEAM_ID
========================================================= */
router.get("/country-logo/by-team-id/:teamId", async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const teamId = normalizeTeamId(req.params.teamId);
    const result = await pool.query(
      "SELECT team_id, country_logo FROM teams WHERE team_id = $1 AND tournament_id = $2",
      [teamId, tournamentId],
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Team not found" });
    }

    const row = result.rows[0];

    res.json({
      success: true,
      data: {
        teamId: row.team_id,
        countryLogo: formatImageUrl(baseUrl, row.country_logo),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   GET ALL UNIQUE COUNTRY LOGOS
========================================================= */
router.get("/country-logos", async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    await syncCountryLogoCatalog(tournamentId);

    const result = await pool.query(`
      SELECT *
      FROM country_logos
      WHERE tournament_id = $1
      ORDER BY name ASC, id ASC
    `, [tournamentId]);

    res.json({
      success: true,
      data: result.rows.map((row) => formatCountryLogoLibraryRow(baseUrl, row)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   CREATE SHARED COUNTRY LOGO
========================================================= */
router.post(
  "/country-logos",
  upload.single("countryLogo"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "countryLogo image is required",
        });
      }

      const baseUrl = getBaseUrl(req);
      const tournamentId = await getTournamentIdFromRequest(pool, req);
      await ensureCountryLogoTable();

      const logoPath = getUploadRelativePath(req.file, COUNTRY_LOGO_DIR);
      const row = await upsertCountryLogo(
        logoPath,
        getCountryLogoNameInput(req.body),
        tournamentId,
      );

      res.json({
        success: true,
        message: "Country logo uploaded successfully",
        data: formatCountryLogoLibraryRow(baseUrl, row),
      });
    } catch (err) {
      safelyDeleteFiles([req.file]);
      console.error(err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

/* =========================================================
   UPDATE SHARED COUNTRY LOGO BY ID
========================================================= */
router.put(
  "/country-logos/:id",
  upload.single("countryLogo"),
  async (req, res) => {
    const newFile = req.file;

    try {
      const baseUrl = getBaseUrl(req);
      const tournamentId = await getTournamentIdFromRequest(pool, req);
      await ensureCountryLogoTable();

      const existingResult = await pool.query(
        "SELECT * FROM country_logos WHERE id = $1 AND tournament_id = $2",
        [req.params.id, tournamentId],
      );

      if (!existingResult.rows.length) {
        safelyDeleteFiles([newFile]);
        return res.status(404).json({
          success: false,
          message: "Country logo not found",
        });
      }

      const existing = existingResult.rows[0];
      const oldLogoPath = existing.image_path;
      const newLogoPath =
        getUploadRelativePath(newFile, COUNTRY_LOGO_DIR) || oldLogoPath;
      const name = getCountryLogoNameInput(req.body);
      const nextName = name !== undefined ? String(name || "").trim() : existing.name;

      const teamResult =
        newLogoPath !== oldLogoPath
          ? await pool.query(
              `
              UPDATE teams
              SET country_logo = $1, updated_at = NOW()
              WHERE country_logo = $2 AND tournament_id = $3
              RETURNING id
              `,
              [newLogoPath, oldLogoPath, tournamentId],
            )
          : { rowCount: 0 };

      const result = await pool.query(
        `
        UPDATE country_logos
        SET name = $1, image_path = $2, file_name = $3, updated_at = NOW()
        WHERE id = $4
        RETURNING *
        `,
        [nextName, newLogoPath, path.basename(newLogoPath), req.params.id],
      );

      if (newFile) {
        safelyDeleteFiles([resolveUploadPath(oldLogoPath, COUNTRY_LOGO_DIR)]);
        moveCountryLogoMeta(oldLogoPath, newLogoPath, nextName);
      } else {
        setCountryLogoName(oldLogoPath, nextName);
      }

      res.json({
        success: true,
        message: "Country logo updated successfully",
        updatedTeams: teamResult.rowCount,
        data: formatCountryLogoLibraryRow(baseUrl, result.rows[0]),
      });
    } catch (err) {
      safelyDeleteFiles([newFile]);
      console.error(err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

/* =========================================================
   UPDATE SHARED COUNTRY LOGO BY PATH (BACKWARD COMPATIBLE)
========================================================= */
router.put("/country-logos", upload.single("countryLogo"), async (req, res) => {
  const newFile = req.file;

  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    await syncCountryLogoCatalog(tournamentId);

    const logoPath = normalizeUploadReference(
      req.body.path || req.body.countryLogo || req.body.filename,
      COUNTRY_LOGO_DIR,
    );

    if (!logoPath) {
      safelyDeleteFiles([newFile]);
      return res.status(400).json({
        success: false,
        message: "Country logo path is required",
      });
    }

    const result = await pool.query(
      "SELECT id FROM country_logos WHERE image_path = $1 AND tournament_id = $2",
      [logoPath, tournamentId],
    );

    if (!result.rows.length) {
      safelyDeleteFiles([newFile]);
      return res
        .status(404)
        .json({ success: false, message: "Country logo not found" });
    }

    const existingResult = await pool.query(
      "SELECT * FROM country_logos WHERE id = $1 AND tournament_id = $2",
      [result.rows[0].id, tournamentId],
    );
    const existing = existingResult.rows[0];
    const oldLogoPath = existing.image_path;
    const newLogoPath =
      getUploadRelativePath(newFile, COUNTRY_LOGO_DIR) || oldLogoPath;
    const name = getCountryLogoNameInput(req.body);
    const nextName = name !== undefined ? String(name || "").trim() : existing.name;

    const teamResult =
      newLogoPath !== oldLogoPath
        ? await pool.query(
            `
            UPDATE teams
            SET country_logo = $1, updated_at = NOW()
            WHERE country_logo = $2 AND tournament_id = $3
            RETURNING id
            `,
            [newLogoPath, oldLogoPath, tournamentId],
          )
        : { rowCount: 0 };

    const updateResult = await pool.query(
      `
      UPDATE country_logos
      SET name = $1, image_path = $2, file_name = $3, updated_at = NOW()
      WHERE id = $4 AND tournament_id = $5
      RETURNING *
      `,
      [nextName, newLogoPath, path.basename(newLogoPath), existing.id, tournamentId],
    );

    if (newFile) {
      safelyDeleteFiles([resolveUploadPath(oldLogoPath, COUNTRY_LOGO_DIR)]);
      moveCountryLogoMeta(oldLogoPath, newLogoPath, nextName);
    } else {
      setCountryLogoName(oldLogoPath, nextName);
    }

    return res.json({
      success: true,
      message: "Country logo updated successfully",
      updatedTeams: teamResult.rowCount,
      data: formatCountryLogoLibraryRow(getBaseUrl(req), updateResult.rows[0]),
    });
  } catch (err) {
    safelyDeleteFiles([newFile]);
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   DELETE SHARED COUNTRY LOGO BY ID
========================================================= */
router.delete("/country-logos/:id", async (req, res) => {
  try {
    await ensureCountryLogoTable();
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    const logoResult = await pool.query(
      "DELETE FROM country_logos WHERE id = $1 AND tournament_id = $2 RETURNING *",
      [req.params.id, tournamentId],
    );

    if (!logoResult.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Country logo not found" });
    }

    const deletedRow = logoResult.rows[0];
    const teamResult = await pool.query(
      `
      UPDATE teams
      SET country_logo = NULL, updated_at = NOW()
      WHERE country_logo = $1 AND tournament_id = $2
      RETURNING id
      `,
      [deletedRow.image_path, tournamentId],
    );

    safelyDeleteFiles([
      resolveUploadPath(deletedRow.image_path, COUNTRY_LOGO_DIR),
    ]);
    deleteCountryLogoMeta(deletedRow.image_path);

    res.json({
      success: true,
      message: "Country logo deleted successfully",
      clearedTeams: teamResult.rowCount,
      data: formatCountryLogoLibraryRow(getBaseUrl(req), deletedRow),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   DELETE SHARED COUNTRY LOGO BY PATH (BACKWARD COMPATIBLE)
========================================================= */
router.delete("/country-logos", async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    await syncCountryLogoCatalog(tournamentId);

    const logoPath = normalizeUploadReference(
      req.body.path || req.body.countryLogo || req.body.filename,
      COUNTRY_LOGO_DIR,
    );

    if (!logoPath) {
      return res.status(400).json({
        success: false,
        message: "Country logo path is required",
      });
    }

    const logoResult = await pool.query(
      "SELECT id FROM country_logos WHERE image_path = $1 AND tournament_id = $2",
      [logoPath, tournamentId],
    );

    if (!logoResult.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Country logo not found" });
    }

    const deleteResult = await pool.query(
      "DELETE FROM country_logos WHERE id = $1 AND tournament_id = $2 RETURNING *",
      [logoResult.rows[0].id, tournamentId],
    );
    const deletedRow = deleteResult.rows[0];
    const teamResult = await pool.query(
      `
      UPDATE teams
      SET country_logo = NULL, updated_at = NOW()
      WHERE country_logo = $1 AND tournament_id = $2
      RETURNING id
      `,
      [deletedRow.image_path, tournamentId],
    );

    safelyDeleteFiles([
      resolveUploadPath(deletedRow.image_path, COUNTRY_LOGO_DIR),
    ]);
    deleteCountryLogoMeta(deletedRow.image_path);

    return res.json({
      success: true,
      message: "Country logo deleted successfully",
      clearedTeams: teamResult.rowCount,
      data: formatCountryLogoLibraryRow(getBaseUrl(req), deletedRow),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   GET SINGLE TEAM
========================================================= */
router.get("/:id", async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const result = await pool.query(
      "SELECT * FROM teams WHERE id = $1 AND tournament_id = $2",
      [req.params.id, tournamentId],
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Team not found" });
    }

    const row = result.rows[0];
    row.team_logo = formatImageUrl(baseUrl, row.team_logo);
    row.country_logo = formatImageUrl(baseUrl, row.country_logo);

    res.json({ success: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   UPDATE TEAM
========================================================= */
router.put(
  "/update-by-team-id/:teamId",
  upload.fields([
    { name: "teamLogo", maxCount: 1 },
    { name: "countryLogo", maxCount: 1 },
  ]),
  async (req, res) => {
    const uploadedFiles = Object.values(req.files || {}).flat();

    try {
      const baseUrl = getBaseUrl(req);
      const tournamentId = await getTournamentIdFromRequest(pool, req);
      const lookupTeamId = normalizeTeamId(req.params.teamId);
      const oldTeam = await pool.query(
        "SELECT * FROM teams WHERE team_id = $1 AND tournament_id = $2",
        [lookupTeamId, tournamentId],
      );

      if (!oldTeam.rows.length) {
        safelyDeleteFiles(uploadedFiles);
        return res
          .status(404)
          .json({ success: false, message: "Team not found" });
      }

      const existing = oldTeam.rows[0];

      const teamId = normalizeTeamId(
        req.body.teamId || req.body.team_id || existing.team_id,
      );
      const teamName =
        req.body.teamName || req.body.team_name || existing.team_name;
      const shortTag =
        req.body.shortTag || req.body.short_tag || existing.short_tag;
      const isPlaying = toBoolean(
        req.body.isPlaying ?? req.body.is_playing,
        Boolean(existing.is_playing),
      );

      const newTeamLogo = getUploadRelativePath(
        req.files?.teamLogo?.[0],
        TEAM_LOGO_DIR,
      );
      const newCountryLogo = getUploadRelativePath(
        req.files?.countryLogo?.[0],
        COUNTRY_LOGO_DIR,
      );
      const selectedCountryLogo = await getCountryLogoPathFromInput(req.body, tournamentId);

      const teamLogo = newTeamLogo || existing.team_logo;
      const countryLogo =
        newCountryLogo || selectedCountryLogo || existing.country_logo;

      const result = await pool.query(
        `
        UPDATE teams
        SET team_id = $1, team_name = $2, short_tag = $3, team_logo = $4, country_logo = $5, is_playing = $6, updated_at = NOW()
        WHERE team_id = $7 AND tournament_id = $8
        RETURNING *
        `,
        [teamId, teamName, shortTag, teamLogo, countryLogo, isPlaying, lookupTeamId, tournamentId],
      );

      if (newTeamLogo && existing.team_logo) {
        safelyDeleteFiles([
          resolveUploadPath(existing.team_logo, TEAM_LOGO_DIR),
        ]);
      }
      if (newCountryLogo && existing.country_logo) {
        safelyDeleteFiles([
          resolveUploadPath(existing.country_logo, COUNTRY_LOGO_DIR),
        ]);
      }
      if (newCountryLogo) await upsertCountryLogo(newCountryLogo, "", tournamentId);
      if (selectedCountryLogo) await upsertCountryLogo(selectedCountryLogo, "", tournamentId);

      const row = result.rows[0];
      row.team_logo = formatImageUrl(baseUrl, row.team_logo);
      row.country_logo = formatImageUrl(baseUrl, row.country_logo);

      res.json({ success: true, data: row });
    } catch (err) {
      safelyDeleteFiles(uploadedFiles);
      console.error(err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

router.put(
  "/update/:id",
  upload.fields([
    { name: "teamLogo", maxCount: 1 },
    { name: "countryLogo", maxCount: 1 },
  ]),
  async (req, res) => {
    const uploadedFiles = Object.values(req.files || {}).flat();

    try {
      const baseUrl = getBaseUrl(req);
      const tournamentId = await getTournamentIdFromRequest(pool, req);
      const oldTeam = await pool.query(
        "SELECT * FROM teams WHERE id = $1 AND tournament_id = $2",
        [req.params.id, tournamentId],
      );

      if (!oldTeam.rows.length) {
        safelyDeleteFiles(uploadedFiles);
        return res
          .status(404)
          .json({ success: false, message: "Team not found" });
      }

      const existing = oldTeam.rows[0];

      const teamId = normalizeTeamId(
        req.body.teamId || req.body.team_id || existing.team_id,
      );
      const teamName =
        req.body.teamName || req.body.team_name || existing.team_name;
      const shortTag =
        req.body.shortTag || req.body.short_tag || existing.short_tag;
      const isPlaying = toBoolean(
        req.body.isPlaying ?? req.body.is_playing,
        Boolean(existing.is_playing),
      );

      const newTeamLogo = getUploadRelativePath(
        req.files?.teamLogo?.[0],
        TEAM_LOGO_DIR,
      );
      const newCountryLogo = getUploadRelativePath(
        req.files?.countryLogo?.[0],
        COUNTRY_LOGO_DIR,
      );
      const selectedCountryLogo = await getCountryLogoPathFromInput(req.body, tournamentId);

      const teamLogo = newTeamLogo || existing.team_logo;
      const countryLogo =
        newCountryLogo || selectedCountryLogo || existing.country_logo;

      const result = await pool.query(
        `
        UPDATE teams
        SET team_id = $1, team_name = $2, short_tag = $3, team_logo = $4, country_logo = $5, is_playing = $6, updated_at = NOW()
        WHERE id = $7 AND tournament_id = $8
        RETURNING *
        `,
        [teamId, teamName, shortTag, teamLogo, countryLogo, isPlaying, req.params.id, tournamentId],
      );

      // Remove stale disk files if new ones were uploaded
      if (newTeamLogo && existing.team_logo) {
        safelyDeleteFiles([
          resolveUploadPath(existing.team_logo, TEAM_LOGO_DIR),
        ]);
      }
      if (newCountryLogo && existing.country_logo) {
        safelyDeleteFiles([
          resolveUploadPath(existing.country_logo, COUNTRY_LOGO_DIR),
        ]);
      }
      if (newCountryLogo) await upsertCountryLogo(newCountryLogo, "", tournamentId);
      if (selectedCountryLogo) await upsertCountryLogo(selectedCountryLogo, "", tournamentId);

      const row = result.rows[0];
      row.team_logo = formatImageUrl(baseUrl, row.team_logo);
      row.country_logo = formatImageUrl(baseUrl, row.country_logo);

      res.json({ success: true, data: row });
    } catch (err) {
      safelyDeleteFiles(uploadedFiles);
      console.error(err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

/* =========================================================
   DELETE TEAM
========================================================= */
const deleteTeam = async (req, res, lookupColumn, lookupValue) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    await pool.query("BEGIN");

    const teamResult = await pool.query(
      `DELETE FROM teams WHERE ${lookupColumn} = $1 AND tournament_id = $2 RETURNING *`,
      [lookupValue, tournamentId],
    );

    if (!teamResult.rows.length) {
      await pool.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Team not found" });
    }

    const deletedRow = teamResult.rows[0];
    const playerResult = await pool.query(
      "DELETE FROM team_players WHERE team_id = $1 AND tournament_id = $2 RETURNING *",
      [deletedRow.team_id, tournamentId],
    );

    await pool.query("COMMIT");

    const filesToDelete = [];
    if (deletedRow.team_logo)
      filesToDelete.push(resolveUploadPath(deletedRow.team_logo, TEAM_LOGO_DIR));
    if (deletedRow.country_logo)
      filesToDelete.push(
        resolveUploadPath(deletedRow.country_logo, COUNTRY_LOGO_DIR),
      );
    for (const player of playerResult.rows) {
      if (player.player_pic) {
        filesToDelete.push(resolveUploadPath(player.player_pic, "players"));
      }
    }
    safelyDeleteFiles(filesToDelete);

    res.json({
      success: true,
      message: "Team deleted successfully",
      data: deletedRow,
      deletedPlayers: playerResult.rowCount,
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

router.delete("/delete-by-team-id/:teamId", async (req, res) => {
  return deleteTeam(req, res, "team_id", normalizeTeamId(req.params.teamId));
});

router.delete("/delete/:id", async (req, res) => {
  return deleteTeam(req, res, "id", req.params.id);
});

module.exports = router;
