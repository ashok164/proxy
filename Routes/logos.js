const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const router = express.Router();
const uploadPath = path.join(__dirname, "../uploads");
const TEAM_LOGO_DIR = "teamLogo";
const LOGO_DIR = path.join(uploadPath, TEAM_LOGO_DIR);
const LEGACY_LOGO_DIR = path.join(uploadPath, "logos");

if (!fs.existsSync(LOGO_DIR)) {
  fs.mkdirSync(LOGO_DIR, { recursive: true });
}

router.use("/logos", express.static(LOGO_DIR));
router.use("/logos", express.static(LEGACY_LOGO_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGO_DIR),
  filename: (req, file, cb) => {
    cb(null, "team_" + Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

/* upload */
router.post("/upload-logo", upload.single("logo"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file was attached to the request" });
  }

  const relativePath = path.posix.join(TEAM_LOGO_DIR, req.file.filename);
  const url = `${req.protocol}://${req.get("host")}/uploads/${relativePath}`;

  res.json({
    success: true,
    url,
    filename: relativePath,
  });
});

/* delete */
router.delete("/logo", (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: "Filename is required" });

  const clean = String(filename)
    .replace(/^https?:\/\/[^/]+\/uploads\//i, "")
    .replace(/^\/?uploads\//i, "")
    .replace(/^\/?logos\//i, "")
    .replace(/\\/g, "/");
  const relativePath = clean.includes("/")
    ? clean
    : path.posix.join(TEAM_LOGO_DIR, path.basename(clean));
  const candidates = [
    path.resolve(uploadPath, relativePath),
    path.resolve(LEGACY_LOGO_DIR, path.basename(clean)),
  ];
  const root = path.resolve(uploadPath);

  if (candidates.some((candidate) => !candidate.startsWith(root + path.sep))) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  const targetPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!targetPath) {
    return res.status(404).json({ error: "File asset not found" });
  }

  fs.unlink(targetPath, (err) => {
    if (err) return res.status(500).json({ error: "Could not drop file asset" });
    res.json({ success: true });
  });
});

module.exports = router;
