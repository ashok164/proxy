const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const pool = require("../Database/db");

const router = express.Router();

/* =========================================================
   UPLOAD FOLDER SETUP
========================================================= */
const uploadPath = path.join(__dirname, "../uploads");

if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

/* =========================================================
   MULTER SETUP
========================================================= */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadPath);
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
    { name: "teamLogo", maxCount: 20 },   // Dynamic batch allowance boundary scale
    { name: "countryLogo", maxCount: 20 },
  ]),
  async (req, res) => {
    const baseUrl = getBaseUrl(req);
    
    // Track references to roll back files if database transactions fail
    const rollbackCache = [];
    if (req.files?.teamLogo) rollbackCache.push(...req.files.teamLogo);
    if (req.files?.countryLogo) rollbackCache.push(...req.files.countryLogo);

    try {
      /*
        Frontend payloads must pass standard scalar arrays for metadata:
        e.g. formData.append("teamId", "12"); formData.append("teamId", "13");
        Express/Multer groups identical names as ordered primitive arrays: req.body.teamId = ["12", "13"]
      */
      const teamIdInput = req.body.teamId || req.body.team_id;
      const teamNameInput = req.body.teamName || req.body.team_name;
      const shortTagInput = req.body.shortTag || req.body.short_tag;

      if (!teamIdInput) {
        safelyDeleteFiles(rollbackCache);
        return res.status(400).json({ success: false, message: "No team records found or teamId missing" });
      }

      // Convert standalone single item strings to iterable arrays for uniformity
      const teamIds = Array.isArray(teamIdInput) ? teamIdInput : [teamIdInput];
      const teamNames = Array.isArray(teamNameInput) ? teamNameInput : [teamNameInput];
      const shortTags = Array.isArray(shortTagInput) ? shortTagInput : [shortTagInput];

      // Safe indexed tracking pointers for binary attachments
      let teamLogoIndex = 0;
      let countryLogoIndex = 0;

      const processedRows = [];

      // Open a robust atomic SQL Transaction
      await pool.query("BEGIN");

      for (let i = 0; i < teamIds.length; i++) {
        const teamId = teamIds[i];
        const teamName = teamNames[i] || null;
        const shortTag = shortTags[i] || null;

        /*
           To link files to their respective team array records over multipart requests:
           If the frontend form appends a file field ONLY when it exists, we track indices contextually.
           Alternatively, frontend can append text fields indicating true/false file presence flag counters.
        */
        const teamLogo = req.files?.teamLogo?.[teamLogoIndex]?.filename || null;
        teamLogoIndex++;

        const countryLogo = req.files?.countryLogo?.[countryLogoIndex]?.filename || null;
        countryLogoIndex++;

        const result = await pool.query(
          `
          INSERT INTO teams (team_id, team_name, short_tag, team_logo, country_logo)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (team_id) DO UPDATE 
          SET 
            team_name = EXCLUDED.team_name,
            short_tag = EXCLUDED.short_tag,
            team_logo = COALESCE(EXCLUDED.team_logo, teams.team_logo),
            country_logo = COALESCE(EXCLUDED.country_logo, teams.country_logo),
            updated_at = NOW()
          RETURNING *
          `,
          [teamId, teamName, shortTag, teamLogo, countryLogo]
        );

        const row = result.rows[0];
        row.team_logo = row.team_logo ? `${baseUrl}/uploads/${row.team_logo}` : null;
        row.country_logo = row.country_logo ? `${baseUrl}/uploads/${row.country_logo}` : null;
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
  }
);

/* =========================================================
   GET ALL TEAMS
========================================================= */
router.get("/all", async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const result = await pool.query("SELECT * FROM teams ORDER BY id DESC");

    const data = result.rows.map((row) => ({
      ...row,
      team_logo: row.team_logo ? `${baseUrl}/uploads/${row.team_logo}` : null,
      country_logo: row.country_logo ? `${baseUrl}/uploads/${row.country_logo}` : null,
    }));

    res.json({ success: true, data });
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
    const result = await pool.query("SELECT * FROM teams WHERE id = $1", [req.params.id]);

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const row = result.rows[0];
    row.team_logo = row.team_logo ? `${baseUrl}/uploads/${row.team_logo}` : null;
    row.country_logo = row.country_logo ? `${baseUrl}/uploads/${row.country_logo}` : null;

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
  "/update/:id",
  upload.fields([
    { name: "teamLogo", maxCount: 1 },
    { name: "countryLogo", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const baseUrl = getBaseUrl(req);
      const oldTeam = await pool.query("SELECT * FROM teams WHERE id = $1", [req.params.id]);

      if (!oldTeam.rows.length) {
        return res.status(404).json({ success: false, message: "Team not found" });
      }

      const existing = oldTeam.rows[0];

      const teamId = req.body.teamId || req.body.team_id || existing.team_id;
      const teamName = req.body.teamName || req.body.team_name || existing.team_name;
      const shortTag = req.body.shortTag || req.body.short_tag || existing.short_tag;

      const newTeamLogo = req.files?.teamLogo?.[0]?.filename;
      const newCountryLogo = req.files?.countryLogo?.[0]?.filename;

      const teamLogo = newTeamLogo || existing.team_logo;
      const countryLogo = newCountryLogo || existing.country_logo;

      const result = await pool.query(
        `
        UPDATE teams
        SET team_id = $1, team_name = $2, short_tag = $3, team_logo = $4, country_logo = $5, updated_at = NOW()
        WHERE id = $6
        RETURNING *
        `,
        [teamId, teamName, shortTag, teamLogo, countryLogo, req.params.id]
      );

      // Remove stale disk files if new ones were uploaded
      if (newTeamLogo && existing.team_logo) {
        safelyDeleteFiles([path.join(uploadPath, existing.team_logo)]);
      }
      if (newCountryLogo && existing.country_logo) {
        safelyDeleteFiles([path.join(uploadPath, existing.country_logo)]);
      }

      const row = result.rows[0];
      row.team_logo = row.team_logo ? `${baseUrl}/uploads/${row.team_logo}` : null;
      row.country_logo = row.country_logo ? `${baseUrl}/uploads/${row.country_logo}` : null;

      res.json({ success: true, data: row });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

/* =========================================================
   DELETE TEAM
========================================================= */
router.delete("/delete/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM teams WHERE id = $1 RETURNING *", [req.params.id]);

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const deletedRow = result.rows[0];

    // Wipe physical image assets off storage disk space clean
    const filesToDelete = [];
    if (deletedRow.team_logo) filesToDelete.push(path.join(uploadPath, deletedRow.team_logo));
    if (deletedRow.country_logo) filesToDelete.push(path.join(uploadPath, deletedRow.country_logo));
    safelyDeleteFiles(filesToDelete);

    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;