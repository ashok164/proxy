const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const pool = require("../Database/db");

const router = express.Router();

const ASSET_MODULES = {
  weapons: {
    table: "weapons",
    singular: "Weapon",
    plural: "Weapons",
  },
  characters: {
    table: "characters",
    singular: "Character",
    plural: "Characters",
  },
  skills: {
    table: "skills",
    singular: "Skill",
    plural: "Skills",
  },
  pets: {
    table: "pets",
    singular: "Pet",
    plural: "Pets",
  },
  roles: {
    table: "roles",
    singular: "Role",
    plural: "Roles",
  },
  equipment: {
    table: "equipment",
    singular: "Equipment",
    plural: "Equipment",
  },
  tournamentLogo: {
    table: "tournament_logos",
    singular: "Tournament logo",
    plural: "Tournament logos",
  },
  fullTeamBanner: {
    table: "full_team_banners",
    singular: "Full team banner",
    plural: "Full team banners",
  },
  notificationTeamBanner: {
    table: "notification_team_banners",
    singular: "Notification team banner",
    plural: "Notification team banners",
  },
  tournamentAssets: {
    table: "tournament_assets",
    singular: "Tournament asset",
    plural: "Tournament assets",
  },
};

const uploadRoot = path.join(__dirname, "../uploads");
const legacyPublicUploadRoot = path.join(__dirname, "../public/uploads");

for (const moduleName of Object.keys(ASSET_MODULES)) {
  fs.mkdirSync(path.join(uploadRoot, moduleName), { recursive: true });
}

const safeFilename = (filename) => {
  const extension = path.extname(filename);
  const base = path
    .basename(filename, extension)
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return `${base || "asset"}${extension.toLowerCase()}`;
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const moduleName = req.params.moduleName;
    const config = ASSET_MODULES[moduleName];

    if (!config) {
      return cb(new Error("Unsupported asset module"));
    }

    return cb(null, path.join(uploadRoot, moduleName));
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}-${safeFilename(file.originalname)}`);
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
  limits: { fileSize: 10 * 1024 * 1024 },
});

const uploadAny = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (!err) return next();

    return res.status(400).json({
      success: false,
      message: err.message,
    });
  });
};

const firstValue = (...values) =>
  values.find((value) => value !== undefined && value !== null);

const toNullableString = (value) => {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean === "" ? null : clean;
};

const toBoolean = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  const clean = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(clean)) return true;
  if (["false", "0", "no", "off"].includes(clean)) return false;

  return undefined;
};

const toBooleanOrDefault = (value, defaultValue) => {
  const parsed = toBoolean(value);
  return parsed === undefined ? defaultValue : parsed;
};

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

const parseItemsPayload = (body = {}) => {
  const items = [];
  const rawItems = getBodyValue(body, "items");

  if (Array.isArray(rawItems)) {
    items.push(...rawItems);
  } else if (rawItems && typeof rawItems === "object") {
    for (const [index, item] of Object.entries(rawItems)) {
      items[Number(index)] = item;
    }
  } else if (typeof rawItems === "string") {
    try {
      const parsed = JSON.parse(rawItems);
      if (Array.isArray(parsed)) items.push(...parsed);
    } catch (err) {
      console.warn("Invalid asset items JSON payload ignored:", err.message);
    }
  }

  for (const [key, value] of Object.entries(body)) {
    const match = key.match(
      /^items\[(\d+)\]\[(team_id|teamId|name|code|asset_id|assetId|description|active|fileName|filename)\]$/i,
    );
    if (!match) continue;

    const index = Number(match[1]);
    const field = match[2];
    if (!items[index]) items[index] = {};
    items[index][field] = value;
  }

  return items;
};

const getFileIndex = (fieldname) => {
  const match = String(fieldname || "").match(/^items\[(\d+)\]\[image\]$/i);
  return match ? Number(match[1]) : null;
};

const getCreateFiles = (files = []) => {
  const itemFiles = files
    .map((file, originalIndex) => ({
      file,
      itemIndex: getFileIndex(file.fieldname),
      originalIndex,
    }))
    .filter((entry) => entry.itemIndex !== null)
    .sort(
      (left, right) =>
        left.itemIndex - right.itemIndex || left.originalIndex - right.originalIndex,
    )
    .map((entry) => entry.file);

  if (itemFiles.length) return itemFiles;

  const imageFiles = files.filter((file) => file.fieldname === "images");
  if (imageFiles.length) return imageFiles;

  const singleImageFiles = files.filter((file) => file.fieldname === "image");
  if (singleImageFiles.length) return singleImageFiles;

  return files;
};

const getItemForFile = (items, file, index) => {
  const fileIndex = getFileIndex(file.fieldname);
  if (fileIndex !== null && items[fileIndex]) return items[fileIndex];

  const matchingFileName = items.find(
    (item) =>
      item &&
      toNullableString(firstValue(item.fileName, item.filename)) ===
        file.originalname,
  );

  return matchingFileName || items[index] || {};
};

const getArrayValue = (body, names, index) => {
  for (const name of names) {
    const value = getBodyValue(body, name);
    if (Array.isArray(value) && value[index] !== undefined) return value[index];
    if (index === 0 && value !== undefined) return value;
  }

  return undefined;
};

const getItemInputAt = (body, items, file, index) => {
  const item = getItemForFile(items, file, index);

  return {
    teamId: firstValue(
      item.team_id,
      item.teamId,
      getBodyValue(item, "team_id", "teamId"),
      getArrayValue(body, ["team_id", "teamId"], index),
    ),
    assetId: firstValue(
      item.code,
      item.asset_id,
      item.assetId,
      getBodyValue(item, "code", "asset_id", "assetId"),
      getArrayValue(body, ["code", "asset_id", "assetId"], index),
    ),
    name: firstValue(
      item.name,
      getBodyValue(item, "name"),
      getArrayValue(body, ["name"], index),
    ),
    description: firstValue(
      item.description,
      getBodyValue(item, "description"),
      getArrayValue(body, ["description"], index),
    ),
    active: firstValue(
      item.active,
      getBodyValue(item, "active"),
      getArrayValue(body, ["active"], index),
    ),
  };
};

const getSingleItemInput = (body) => {
  const item = parseItemsPayload(body)[0] || {};

  return {
    teamId: firstValue(
      item.team_id,
      item.teamId,
      getBodyValue(item, "team_id", "teamId"),
      getBodyValue(body, "team_id", "teamId"),
    ),
    assetId: firstValue(
      item.code,
      item.asset_id,
      item.assetId,
      getBodyValue(item, "code", "asset_id", "assetId"),
      getBodyValue(body, "code", "asset_id", "assetId"),
    ),
    name: firstValue(
      item.name,
      getBodyValue(item, "name"),
      getBodyValue(body, "name"),
    ),
    description: firstValue(
      item.description,
      getBodyValue(item, "description"),
      getBodyValue(body, "description"),
    ),
    active: firstValue(
      item.active,
      getBodyValue(item, "active"),
      getBodyValue(body, "active"),
    ),
  };
};

const getBaseUrl = (req) => `${req.protocol}://${req.get("host")}`;

const toPublicUploadUrl = (req, imageUrl) => {
  if (!imageUrl) return imageUrl;
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl;

  const cleanPath = String(imageUrl)
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");

  return `${getBaseUrl(req)}/${cleanPath}`;
};

const formatRow = (req, row) => ({
  id: row.id,
  team_id: row.team_id,
  asset_id: row.asset_id,
  name: row.name,
  description: row.description,
  active: row.active,
  image_url: toPublicUploadUrl(req, row.image_url),
  file_name: row.file_name,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const deleteUploadedFiles = (files = []) => {
  for (const file of files) {
    const filepath = typeof file === "string" ? file : file?.path;
    if (!filepath || !fs.existsSync(filepath)) continue;

    try {
      fs.unlinkSync(filepath);
    } catch (err) {
      console.error("Failed cleaning up asset image:", filepath, err.message);
    }
  }
};

const deleteImageByUrl = (imageUrl) => {
  if (!imageUrl) return;

  const relativePath = String(imageUrl)
    .replace(/^https?:\/\/[^/]+\/uploads\//i, "")
    .replace(/^\/?uploads\//i, "")
    .replace(/\\/g, "/");
  const candidates = [
    path.resolve(uploadRoot, relativePath),
    path.resolve(legacyPublicUploadRoot, relativePath),
  ];

  for (const filepath of candidates) {
    const root = filepath.startsWith(path.resolve(uploadRoot) + path.sep)
      ? path.resolve(uploadRoot)
      : path.resolve(legacyPublicUploadRoot);

    if (!filepath.startsWith(root + path.sep) || !fs.existsSync(filepath)) {
      continue;
    }

    deleteUploadedFiles([filepath]);
    return;
  }
};

router.param("moduleName", (req, res, next, moduleName) => {
  if (!ASSET_MODULES[moduleName]) {
    return res
      .status(404)
      .json({ success: false, message: "Asset module not found" });
  }

  return next();
});

router.post("/:moduleName/create", uploadAny, async (req, res) => {
  const { moduleName } = req.params;
  const config = ASSET_MODULES[moduleName];
  const files = req.files || [];
  const createFiles = getCreateFiles(files);

  if (!createFiles.length) {
    return res.status(400).json({
      success: false,
      message: "At least one image is required",
    });
  }

  try {
    const items = parseItemsPayload(req.body);
    const rows = [];

    await pool.query("BEGIN");

    for (let index = 0; index < createFiles.length; index++) {
      const file = createFiles[index];
      const input = getItemInputAt(req.body, items, file, index);
      const imageUrl = `uploads/${moduleName}/${file.filename}`;

      const result = await pool.query(
        `
        INSERT INTO ${config.table} (
          team_id,
          asset_id,
          name,
          description,
          active,
          image_url,
          file_name,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING *
        `,
        [
          toNullableString(input.teamId),
          toNullableString(input.assetId),
          toNullableString(input.name),
          toNullableString(input.description),
          toBooleanOrDefault(input.active, true),
          imageUrl,
          file.originalname,
        ],
      );

      rows.push(formatRow(req, result.rows[0]));
    }

    await pool.query("COMMIT");
    deleteUploadedFiles(files.filter((file) => !createFiles.includes(file)));

    return res.json({
      success: true,
      message: `${config.plural} uploaded successfully`,
      data: rows,
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    deleteUploadedFiles(files);
    console.error(`${config.plural} upload failed:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/:moduleName/all", async (req, res) => {
  const { moduleName } = req.params;
  const config = ASSET_MODULES[moduleName];

  try {
    const result = await pool.query(
      `SELECT * FROM ${config.table} ORDER BY id ASC`,
    );

    return res.json({
      success: true,
      data: result.rows.map((row) => formatRow(req, row)),
    });
  } catch (err) {
    console.error(`${config.plural} fetch failed:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/:moduleName/update/:id", uploadAny, async (req, res) => {
  const { moduleName, id } = req.params;
  const config = ASSET_MODULES[moduleName];
  const files = req.files || [];
  const newImage = files[0];

  try {
    const existingResult = await pool.query(
      `SELECT * FROM ${config.table} WHERE id = $1`,
      [id],
    );

    if (!existingResult.rows.length) {
      deleteUploadedFiles(files);
      return res
        .status(404)
        .json({ success: false, message: `${config.singular} not found` });
    }

    const existing = existingResult.rows[0];
    const input = getSingleItemInput(req.body);
    const imageUrl = newImage
      ? `uploads/${moduleName}/${newImage.filename}`
      : existing.image_url;

    const result = await pool.query(
      `
      UPDATE ${config.table}
      SET
        asset_id = $1,
        team_id = $2,
        name = $3,
        description = $4,
        active = $5,
        image_url = $6,
        file_name = $7,
        updated_at = NOW()
      WHERE id = $8
      RETURNING *
      `,
      [
        input.assetId !== undefined
          ? toNullableString(input.assetId)
          : existing.asset_id,
        input.teamId !== undefined
          ? toNullableString(input.teamId)
          : existing.team_id,
        input.name !== undefined ? toNullableString(input.name) : existing.name,
        input.description !== undefined
          ? toNullableString(input.description)
          : existing.description,
        toBooleanOrDefault(input.active, existing.active),
        imageUrl,
        newImage ? newImage.originalname : existing.file_name,
        id,
      ],
    );

    if (newImage && existing.image_url) {
      deleteImageByUrl(existing.image_url);
    }
    deleteUploadedFiles(files.slice(1));

    return res.json({
      success: true,
      message: `${config.singular} updated successfully`,
      data: formatRow(req, result.rows[0]),
    });
  } catch (err) {
    deleteUploadedFiles(files);
    console.error(`${config.singular} update failed:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/:moduleName/delete/:id", async (req, res) => {
  const { moduleName, id } = req.params;
  const config = ASSET_MODULES[moduleName];

  try {
    const result = await pool.query(
      `DELETE FROM ${config.table} WHERE id = $1 RETURNING *`,
      [id],
    );

    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: `${config.singular} not found` });
    }

    const deletedRow = result.rows[0];
    deleteImageByUrl(deletedRow.image_url);

    return res.json({
      success: true,
      message: `${config.singular} deleted successfully`,
      data: formatRow(req, deletedRow),
    });
  } catch (err) {
    console.error(`${config.singular} delete failed:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
