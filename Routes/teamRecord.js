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

/* =========================================================
   CREATE TEAMS (ARRAY SUPPORT)
========================================================= */
router.post("/create", async (req, res) => {
  try {
    const teams = req.body;

    // validation
    if (!Array.isArray(teams)) {
      return res.status(400).json({
        success: false,
        message: "Request body must be an array of teams",
      });
    }

    const insertedTeams = [];

    for (const team of teams) {
      const result = await pool.query(
        `INSERT INTO teams 
          (team_id, team_name, short_tag, team_logo, country_logo)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          team.teamId,
          team.teamName,
          team.shortTag,
          team.teamLogo,
          team.countryLogo,
        ]
      );

      insertedTeams.push(result.rows[0]);
    }

    return res.json({
      success: true,
      message: "Teams created successfully",
      data: insertedTeams,
    });
  } catch (err) {
    console.error("CREATE ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Create failed",
      error: err.message,
    });
  }
});

/* =========================================================
   GET ALL TEAMS
========================================================= */
router.get("/all", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM teams ORDER BY id DESC"
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error("GET ALL ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Fetch failed",
    });
  }
});

/* =========================================================
   GET SINGLE TEAM
========================================================= */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "SELECT * FROM teams WHERE id = $1",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Team not found",
      });
    }

    return res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error("GET ONE ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Fetch failed",
    });
  }
});

/* =========================================================
   UPDATE TEAM (WITH FILE UPLOAD)
========================================================= */
router.put(
  "/update/:id",
  upload.fields([
    { name: "teamLogo", maxCount: 1 },
    { name: "countryLogo", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const id = req.params.id;
      const { teamId, teamName, shortTag } = req.body;

      const teamLogo = req.files?.teamLogo?.[0]?.filename || null;
      const countryLogo = req.files?.countryLogo?.[0]?.filename || null;

      const result = await pool.query(
        `UPDATE teams
         SET team_id = $1,
             team_name = $2,
             short_tag = $3,
             team_logo = COALESCE($4, team_logo),
             country_logo = COALESCE($5, country_logo),
             updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [
          teamId,
          teamName,
          shortTag || null,
          teamLogo,
          countryLogo,
          id,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Team not found",
        });
      }

      return res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (err) {
      console.error("UPDATE ERROR:", err);
      return res.status(500).json({
        success: false,
        message: "Update failed",
      });
    }
  }
);

/* =========================================================
   DELETE TEAM
========================================================= */
router.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "DELETE FROM teams WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Team not found",
      });
    }

    return res.json({
      success: true,
      message: "Deleted successfully",
    });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Delete failed",
    });
  }
});

module.exports = router;