const crypto = require("crypto");
const express = require("express");
const https = require("https");

const router = express.Router();

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const SHEET_HEADERS = [
  "Rank",
  "Team ID",
  "Team Name",
  "Team Tag",
  "Team Logo",
  "Country Logo",
  "Kills",
  "Placement",
  "Booyah Count",
  "Total Kills",
  "Match IDs",
];

const toNullableString = (value) => {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean === "" ? null : clean;
};

const toNumber = (value, fallback = 0) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const base64Url = (input) =>
  Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const parseServiceAccount = () => {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    };
  }

  return {
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY,
  };
};

const requestJson = (url, options = {}, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestOptions = {
      method: options.method || "GET",
      headers: {
        ...(payload ? { "Content-Type": "application/json" } : {}),
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...(options.headers || {}),
      },
    };

    const req = https.request(url, requestOptions, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        const data = raw ? JSON.parse(raw) : {};
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = data.error_description || data.error?.message || raw;
          reject(new Error(message || `Request failed with ${res.statusCode}`));
          return;
        }
        resolve(data);
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const getAccessToken = async () => {
  const { clientEmail, privateKey } = parseServiceAccount();
  if (!clientEmail || !privateKey) {
    throw new Error(
      "Google Sheets credentials missing. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };

  const unsignedJwt = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claim),
  )}`;
  const normalizedKey = privateKey.replace(/\\n/g, "\n");
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsignedJwt)
    .sign(normalizedKey, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const token = await requestJson(GOOGLE_TOKEN_URL, { method: "POST" }, {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsignedJwt}.${signature}`,
  });

  return token.access_token;
};

const quoteSheetName = (sheetName) => `'${sheetName.replace(/'/g, "''")}'`;

const normalizeResults = (body) => {
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body)) return body;
  return [];
};

const resultToRow = (result, index) => [
  index + 1,
  toNullableString(result.teamId) || "",
  toNullableString(result.teamName) || "",
  toNullableString(result.teamTag) || "",
  toNullableString(result.teamLogo) || "",
  toNullableString(result.countryLogo) || "",
  toNumber(result.kills),
  toNumber(result.placement),
  toNumber(result.booyahCount),
  toNumber(result.totalKills),
  toNullableString(result.matchIds || result.matchId) || "",
];

router.post("/sync-sheet", async (req, res) => {
  try {
    const spreadsheetId = toNullableString(req.body.spreadsheetId);
    const sheetName = toNullableString(req.body.sheetName);
    const results = normalizeResults(req.body);

    if (!spreadsheetId || !sheetName) {
      return res.status(400).json({
        success: false,
        message: "spreadsheetId and sheetName are required",
      });
    }

    if (!results.length) {
      return res.status(400).json({
        success: false,
        message: "results must contain at least one row",
      });
    }

    const accessToken = await getAccessToken();
    const range = `${quoteSheetName(sheetName)}!A:K`;
    const encodedRange = encodeURIComponent(range);
    const authHeaders = { Authorization: `Bearer ${accessToken}` };
    const values = [SHEET_HEADERS, ...results.map(resultToRow)];

    await requestJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}:clear`,
      { method: "POST", headers: authHeaders },
      {},
    );

    await requestJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}?valueInputOption=USER_ENTERED`,
      { method: "PUT", headers: authHeaders },
      { values },
    );

    return res.json({
      success: true,
      message: `Synced ${results.length} rows to ${sheetName}`,
      spreadsheetId,
      sheetName,
      worksheetGid: req.body.worksheetGid || req.body.gid || req.body.sheetGid,
      rows: results.length,
    });
  } catch (err) {
    console.error("Google Sheets sync failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
