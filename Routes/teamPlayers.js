const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const pool = require("../Database/db");

const router = express.Router();

const uploadPath = path.join(__dirname, "../uploads");

if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ["image/png", "image/jpg", "image/jpeg", "image/webp"];
  if (allowed.includes(file.mimetype)) return cb(null, true);
  return cb(new Error("Only image files are allowed"));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const getBaseUrl = (req) => `${req.protocol}://${req.get("host")}`;

const toArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const normalizeTeamId = (value) => {
  const clean = String(value ?? "").trim();
  if (!/^\d+$/.test(clean)) return clean;

  const numberValue = Number(clean);
  return Number.isSafeInteger(numberValue) ? String(numberValue) : clean;
};

const formatImageUrl = (baseUrl, imagePath) => {
  if (!imagePath) return null;
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    return imagePath;
  }
  return `${baseUrl}/uploads/${imagePath.replace(/^\/?uploads\//i, "")}`;
};

const safelyDeleteFiles = (filesArray) => {
  if (!filesArray) return;
  filesArray.forEach((file) => {
    const filepath = typeof file === "string" ? file : file?.path;
    if (filepath && fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch (err) {
        console.error("Failed cleaning up player image:", filepath, err.message);
      }
    }
  });
};

/* =========================================================
   CREATE / BULK CREATE PLAYER PICTURES
   Frontend endpoint: POST /api/team-players
========================================================= */
router.post("/team-players", upload.any(), async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const files = req.files || [];

  try {
    const teamIds = toArray(req.body.teamId || req.body.team_id);
    const playerNames = toArray(
      req.body.playerName || req.body.player_name || req.body.name,
    );

    if (!teamIds.length) {
      safelyDeleteFiles(files);
      return res.status(400).json({
        success: false,
        message: "team_id is required",
      });
    }

    if (!files.length) {
      return res.status(400).json({
        success: false,
        message: "At least one player image is required",
      });
    }

    await pool.query("BEGIN");

    const rows = [];

    for (let i = 0; i < files.length; i++) {
      const teamId = normalizeTeamId(teamIds[i] || teamIds[0]);
      const playerName = playerNames[i] || null;

      if (!teamId) continue;

      const result = await pool.query(
        `
        INSERT INTO team_players (team_id, player_name, player_pic, updated_at)
        VALUES ($1, $2, $3, NOW())
        RETURNING *
        `,
        [teamId, playerName, files[i].filename],
      );

      const row = result.rows[0];
      row.player_pic = formatImageUrl(baseUrl, row.player_pic);
      rows.push(row);
    }

    await pool.query("COMMIT");

    return res.json({ success: true, data: rows });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    safelyDeleteFiles(files);
    console.error("Player upload failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   GET PLAYER PICTURES
   Frontend endpoint: GET /api/view-team-player
========================================================= */
router.get("/view-team-player", async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const teamId = normalizeTeamId(req.query.team_id || req.query.teamId);

    const result = teamId
      ? await pool.query(
          "SELECT * FROM team_players WHERE team_id = $1 ORDER BY id DESC",
          [teamId],
        )
      : await pool.query("SELECT * FROM team_players ORDER BY id DESC");

    const data = result.rows.map((row) => ({
      ...row,
      player_pic: formatImageUrl(baseUrl, row.player_pic),
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error("Player fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
