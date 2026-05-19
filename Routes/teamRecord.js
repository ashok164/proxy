const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const pool = require("../Database/db");

const router = express.Router();

/* ================= MULTER CONFIG ================= */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, "../uploads");

    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }

    cb(null, uploadPath);
  },

  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

/* ================= BASE URL HELPER ================= */
const getBaseUrl = (req) => `${req.protocol}://${req.get("host")}`;

/* =========================================================
   CREATE TEAMS
========================================================= */
router.post(
  "/create",
  upload.fields([
    { name: "teamLogo", maxCount: 1 },
    { name: "countryLogo", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const baseUrl = getBaseUrl(req);

      const teamId = req.body.teamId;
      const teamName = req.body.teamName;
      const shortTag = req.body.shortTag;

      const teamLogoFile = req.files?.teamLogo?.[0]?.filename || null;
      const countryLogoFile = req.files?.countryLogo?.[0]?.filename || null;

      const result = await pool.query(
        `INSERT INTO teams (team_id, team_name, short_tag, team_logo, country_logo)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [teamId, teamName, shortTag, teamLogoFile, countryLogoFile],
      );

      const row = result.rows[0];

      // convert to full URL
      row.team_logo = row.team_logo
        ? `${baseUrl}/uploads/${row.team_logo}`
        : null;

      row.country_logo = row.country_logo
        ? `${baseUrl}/uploads/${row.country_logo}`
        : null;

      res.json({
        success: true,
        data: row,
      });
    } catch (err) {
      console.error("CREATE ERROR:", err);
      res.status(500).json({
        success: false,
        message: err.message,
      });
    }
  },
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
      country_logo: row.country_logo
        ? `${baseUrl}/uploads/${row.country_logo}`
        : null,
    }));

    res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
    });
  }
});

/* =========================================================
   GET SINGLE TEAM
========================================================= */
router.get("/:id", async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);

    const result = await pool.query("SELECT * FROM teams WHERE id = $1", [
      req.params.id,
    ]);

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Not found",
      });
    }

    const row = result.rows[0];

    row.team_logo = row.team_logo
      ? `${baseUrl}/uploads/${row.team_logo}`
      : null;

    row.country_logo = row.country_logo
      ? `${baseUrl}/uploads/${row.country_logo}`
      : null;

    res.json({
      success: true,
      data: row,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

/* =========================================================
   UPDATE TEAM (WITH IMAGE UPLOAD)
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

      const { teamId, teamName, shortTag } = req.body;

      const teamLogo = req.files?.teamLogo?.[0]?.filename || null;
      const countryLogo = req.files?.countryLogo?.[0]?.filename || null;

      const result = await pool.query(
        `UPDATE teams
         SET team_id=$1,
             team_name=$2,
             short_tag=$3,
             team_logo=COALESCE($4, team_logo),
             country_logo=COALESCE($5, country_logo),
             updated_at=NOW()
         WHERE id=$6
         RETURNING *`,
        [teamId, teamName, shortTag, teamLogo, countryLogo, req.params.id],
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Not found",
        });
      }

      const row = result.rows[0];

      row.team_logo = row.team_logo
        ? `${baseUrl}/uploads/${row.team_logo}`
        : null;

      row.country_logo = row.country_logo
        ? `${baseUrl}/uploads/${row.country_logo}`
        : null;

      res.json({
        success: true,
        data: row,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({
        success: false,
      });
    }
  },
);

/* =========================================================
   DELETE TEAM
========================================================= */
router.delete("/delete/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM teams WHERE id=$1 RETURNING *",
      [req.params.id],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Not found",
      });
    }

    res.json({
      success: true,
      message: "Deleted successfully",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
    });
  }
});

module.exports = router;
