const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const pool = require("../Database/db");
const {
  ensureTournamentColumn,
  getTournamentIdFromRequest,
} = require("../Data/tournamentContext");

const router = express.Router({ mergeParams: true });

const uploadPath = path.join(__dirname, "../uploads");
const PLAYER_UPLOAD_DIR = "players";

fs.mkdirSync(path.join(uploadPath, PLAYER_UPLOAD_DIR), { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) =>
    cb(null, path.join(uploadPath, PLAYER_UPLOAD_DIR)),
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

const firstValue = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== "");

const getBodyValue = (body, ...names) => {
  for (const name of names) {
    if (body[name] !== undefined) return body[name];
  }

  const lowerNameMap = Object.keys(body).reduce((acc, key) => {
    acc[key.toLowerCase()] = key;
    return acc;
  }, {});

  for (const name of names) {
    const actualKey = lowerNameMap[String(name).toLowerCase()];
    if (actualKey && body[actualKey] !== undefined) return body[actualKey];
  }

  return undefined;
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

const getUploadRelativePath = (file) =>
  file ? path.posix.join(PLAYER_UPLOAD_DIR, file.filename) : null;

const resolveUploadPath = (storedPath, fallbackFolder = PLAYER_UPLOAD_DIR) => {
  if (!storedPath) return null;

  const clean = String(storedPath)
    .replace(/^https?:\/\/[^/]+\/uploads\//i, "")
    .replace(/^\/?uploads\//i, "")
    .replace(/\\/g, "/");
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

const formatPlayerRow = (baseUrl, row) => ({
  id: row.id,
  teamId: row.team_id,
  playerUid: row.player_uid,
  playerName: row.player_name,
  cameraLink: row.camera_link,
  playerPic: formatImageUrl(baseUrl, row.player_pic),
  teamName: row.team_name,
  shortTag: row.short_tag,
  countryLogo: formatImageUrl(baseUrl, row.country_logo),
  teamLogo: formatImageUrl(baseUrl, row.team_logo),
  rank: row.rank,
});

const parsePlayersPayload = (body = {}) => {
  const players = [];
  const rawPlayers = getBodyValue(body, "players");

  if (Array.isArray(rawPlayers)) {
    players.push(...rawPlayers);
  } else if (rawPlayers && typeof rawPlayers === "object") {
    for (const [index, player] of Object.entries(rawPlayers)) {
      players[Number(index)] = player;
    }
  } else if (typeof rawPlayers === "string") {
    try {
      const parsed = JSON.parse(rawPlayers);
      if (Array.isArray(parsed)) players.push(...parsed);
    } catch (err) {
      console.warn("Invalid players JSON payload ignored:", err.message);
    }
  }

  for (const [key, value] of Object.entries(body)) {
    const match = key.match(
      /^players\[(\d+)\]\[(uid|playeruid|playerUid|player_uid|player_name|playerName|name|camera_link|cameraLink|cameralink)\]$/i,
    );
    if (!match) continue;

    const index = Number(match[1]);
    const field = match[2].toLowerCase();
    if (!players[index]) players[index] = {};
    players[index][field] = value;
  }

  return players;
};

const getPlayerInputAt = (body, players, index) => {
  const player = players[index] || {};

  return {
    playerUid: firstValue(
      player.uid,
      player.playerUid,
      player.player_uid,
      player.playeruid,
      getBodyValue(player, "uid", "playerUid", "player_uid", "playeruid"),
      toArray(
        getBodyValue(body, "playerUid", "player_uid", "playeruid", "uid"),
      )[index],
    ),
    playerName: firstValue(
      player.playerName,
      player.player_name,
      player.playername,
      player.name,
      getBodyValue(player, "playerName", "player_name", "playername", "name"),
      toArray(
        getBodyValue(body, "playerName", "player_name", "playername", "name"),
      )[index],
    ),
    cameraLink: firstValue(
      player.cameraLink,
      player.camera_link,
      player.cameralink,
      getBodyValue(player, "cameraLink", "camera_link", "cameralink"),
      toArray(getBodyValue(body, "cameraLink", "camera_link", "cameralink"))[
        index
      ],
    ),
  };
};

let playerColumnsReady = false;

const ensurePlayerColumns = async () => {
  if (playerColumnsReady) return;

  await ensureTournamentColumn(pool, "team_players");
  await ensureTournamentColumn(pool, "teams");

  await pool.query(`
    ALTER TABLE team_players
    ADD COLUMN IF NOT EXISTS player_uid TEXT
  `);
  await pool.query(`
    ALTER TABLE team_players
    ADD COLUMN IF NOT EXISTS camera_link TEXT
  `);

  playerColumnsReady = true;
};

const safelyDeleteFiles = (filesArray) => {
  if (!filesArray) return;
  filesArray.forEach((file) => {
    const filepath = typeof file === "string" ? file : file?.path;
    if (filepath && fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch (err) {
        console.error(
          "Failed cleaning up player image:",
          filepath,
          err.message,
        );
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
    await ensurePlayerColumns();
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    const teamIds = toArray(getBodyValue(req.body, "teamId", "team_id"));
    const players = parsePlayersPayload(req.body);

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
      const playerInput = getPlayerInputAt(req.body, players, i);
      const playerName = playerInput.playerName || null;
      const playerUid = playerInput.playerUid || null;
      const cameraLink = playerInput.cameraLink || null;

      if (!teamId) continue;

      const result = await pool.query(
        `
  WITH inserted_player AS (
    INSERT INTO team_players (
      tournament_id,
      team_id,
      player_uid,
      player_name,
      camera_link,
      player_pic,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    RETURNING *
  )

  SELECT
    ip.*,
    t.team_name,
    t.short_tag,
    t.team_logo,
    t.country_logo,
    t.rank
  FROM inserted_player ip
  LEFT JOIN teams t
    ON t.team_id = ip.team_id AND t.tournament_id = ip.tournament_id
  `,
        [
          tournamentId,
          teamId,
          playerUid,
          playerName,
          cameraLink,
          getUploadRelativePath(files[i]),
        ],
      );

      const row = result.rows[0];
      rows.push(formatPlayerRow(baseUrl, row));
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
    await ensurePlayerColumns();
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const teamId = normalizeTeamId(req.query.team_id || req.query.teamId);

    const result = teamId
      ? await pool.query(
          `
          SELECT
            tp.*,
            t.team_name,
            t.short_tag,
            t.team_logo,
            t.country_logo,
            t.rank
          FROM team_players tp
          LEFT JOIN teams t
            ON t.team_id = tp.team_id AND t.tournament_id = tp.tournament_id
          WHERE tp.team_id = $1 AND tp.tournament_id = $2
          ORDER BY tp.id DESC
          `,
          [teamId, tournamentId],
        )
      : await pool.query(
          `
          SELECT
            tp.*,
            t.team_name,
            t.short_tag,
            t.team_logo,
            t.country_logo,
            t.rank
          FROM team_players tp
          LEFT JOIN teams t
            ON t.team_id = tp.team_id AND t.tournament_id = tp.tournament_id
          WHERE tp.tournament_id = $1
          ORDER BY tp.id DESC
          `,
          [tournamentId],
        );

    const data = result.rows.map((row) => formatPlayerRow(baseUrl, row));

    return res.json({ success: true, data });
  } catch (err) {
    console.error("Player fetch failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   GET SINGLE PLAYER BY PLAYER UID
   Frontend endpoint: GET /api/team-players/by-player-uid/:playerUid
========================================================= */
router.get("/team-players/by-player-uid/:playerUid", async (req, res) => {
  try {
    await ensurePlayerColumns();
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    const baseUrl = getBaseUrl(req);
    const result = await pool.query(
      "SELECT * FROM team_players WHERE player_uid = $1 AND tournament_id = $2",
      [req.params.playerUid, tournamentId],
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Player not found" });
    }

    return res.json({
      success: true,
      data: formatPlayerRow(baseUrl, result.rows[0]),
    });
  } catch (err) {
    console.error("Player fetch by uid failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

const updatePlayer = async (req, res, lookupColumn, lookupValue) => {
  const baseUrl = getBaseUrl(req);
  const files = req.files || [];
  const newPlayerPic = getUploadRelativePath(files[0]);

  try {
    await ensurePlayerColumns();
    const tournamentId = await getTournamentIdFromRequest(pool, req);

    const oldPlayer = await pool.query(
      `SELECT * FROM team_players WHERE ${lookupColumn} = $1 AND tournament_id = $2`,
      [lookupValue, tournamentId],
    );

    if (!oldPlayer.rows.length) {
      safelyDeleteFiles(files);
      return res
        .status(404)
        .json({ success: false, message: "Player not found" });
    }

    const existing = oldPlayer.rows[0];
    const players = parsePlayersPayload(req.body);
    const playerInput = getPlayerInputAt(req.body, players, 0);
    const teamId = normalizeTeamId(
      getBodyValue(req.body, "teamId", "team_id") || existing.team_id,
    );
    const playerUid = playerInput.playerUid || existing.player_uid;
    const playerName = playerInput.playerName || existing.player_name;
    const cameraLink = playerInput.cameraLink || existing.camera_link;
    const playerPic = newPlayerPic || existing.player_pic;

    const result = await pool.query(
      `
      UPDATE team_players
      SET
        team_id = $1,
        player_uid = $2,
        player_name = $3,
        camera_link = $4,
        player_pic = $5,
        updated_at = NOW()
      WHERE ${lookupColumn} = $6 AND tournament_id = $7
      RETURNING *
      `,
      [teamId, playerUid, playerName, cameraLink, playerPic, lookupValue, tournamentId],
    );

    if (newPlayerPic && existing.player_pic) {
      safelyDeleteFiles([resolveUploadPath(existing.player_pic)]);
    }

    return res.json({
      success: true,
      data: formatPlayerRow(baseUrl, result.rows[0]),
    });
  } catch (err) {
    safelyDeleteFiles(files);
    console.error("Player update failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================================================
   UPDATE SINGLE PLAYER BY PLAYER UID
   Frontend endpoint: PUT /api/team-players/by-player-uid/:playerUid
========================================================= */
router.put(
  "/team-players/by-player-uid/:playerUid",
  upload.any(),
  async (req, res) => {
    return updatePlayer(req, res, "player_uid", req.params.playerUid);
  },
);

/* =========================================================
   UPDATE SINGLE PLAYER
   Frontend endpoint: PUT /api/team-players/:id
========================================================= */
router.put("/team-players/:id", upload.any(), async (req, res) => {
  return updatePlayer(req, res, "id", req.params.id);
});

const deletePlayer = async (req, res, lookupColumn, lookupValue) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const result = await pool.query(
      `DELETE FROM team_players WHERE ${lookupColumn} = $1 AND tournament_id = $2 RETURNING *`,
      [lookupValue, tournamentId],
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Player not found" });
    }

    const deletedRow = result.rows[0];
    if (deletedRow.player_pic) {
      safelyDeleteFiles([resolveUploadPath(deletedRow.player_pic)]);
    }

    return res.json({
      success: true,
      message: "Player deleted successfully",
      data: deletedRow,
    });
  } catch (err) {
    console.error("Player delete failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================================================
   DELETE SINGLE PLAYER BY PLAYER UID
   Frontend endpoint: DELETE /api/team-players/by-player-uid/:playerUid
========================================================= */
router.delete("/team-players/by-player-uid/:playerUid", async (req, res) => {
  return deletePlayer(req, res, "player_uid", req.params.playerUid);
});

/* =========================================================
   DELETE ALL PLAYERS IN TEAM
   Frontend endpoint: DELETE /api/team-players/by-team-id/:teamId
========================================================= */
router.delete("/team-players/by-team-id/:teamId", async (req, res) => {
  try {
    const teamId = normalizeTeamId(req.params.teamId);
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const result = await pool.query(
      "DELETE FROM team_players WHERE team_id = $1 AND tournament_id = $2 RETURNING *",
      [teamId, tournamentId],
    );

    const filesToDelete = [];
    for (const player of result.rows) {
      if (player.player_pic) {
        filesToDelete.push(resolveUploadPath(player.player_pic));
      }
    }
    safelyDeleteFiles(filesToDelete);

    return res.json({
      success: true,
      message: "Team players deleted successfully",
      deletedPlayers: result.rowCount,
      data: result.rows,
    });
  } catch (err) {
    console.error("Team players delete failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================================================
   DELETE SINGLE PLAYER
   Frontend endpoint: DELETE /api/team-players/:id
========================================================= */
router.delete("/team-players/:id", async (req, res) => {
  return deletePlayer(req, res, "id", req.params.id);
});

module.exports = router;
