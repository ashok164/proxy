const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const router = express.Router();
const LOGO_DIR = path.join(__dirname, "../uploads/logos");

if (!fs.existsSync(LOGO_DIR)) {
  fs.mkdirSync(LOGO_DIR, { recursive: true });
}

router.use("/logos", express.static(LOGO_DIR));

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

  const url = `${req.protocol}://${req.get("host")}/logos/${req.file.filename}`;

  res.json({
    success: true,
    url,
    filename: req.file.filename,
  });
});

/* delete */
router.delete("/logo", (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: "Filename is required" });

  // SECURITY FIX: Strips out relative directory navigation traits to block path traversal hacks
  const safeFilename = path.basename(filename);
  const targetPath = path.join(LOGO_DIR, safeFilename);

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: "File asset not found" });
  }

  fs.unlink(targetPath, (err) => {
    if (err) return res.status(500).json({ error: "Could not drop file asset" });
    res.json({ success: true });
  });
});

module.exports = router;