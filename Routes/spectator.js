const express = require("express");
const axios = require("axios");

const pool = require("../Database/db");
const { getTournamentIdFromRequest } = require("../Data/tournamentContext");

const router = express.Router({ mergeParams: true });

const MAX_SPECT_IDS = 4;
const POLL_INTERVAL_MS = Math.max(
  1500,
  parseInt(process.env.SPECTATOR_POLL_INTERVAL_MS || "3000", 10),
);
const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;

const groupsByTournament = new Map();
const latestByTournament = new Map();
const enginesByTournament = new Map();

const getTournamentBucket = (map, tournamentId) => {
  const key = String(tournamentId);
  if (!map.has(key)) {
    map.set(key, new Map());
  }
  return map.get(key);
};

const normalizeSpectIds = (spectIds = []) =>
  spectIds
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, MAX_SPECT_IDS);

const toRoomName = (tournamentId, spectId) =>
  `spect_${String(tournamentId)}_${String(spectId)}`;

const toCameraRoomName = (tournamentId, matchId) =>
  `camera_${String(tournamentId)}_${String(matchId)}`;

const getSpectatorNamespace = (req) => req.app.get("spectatorNamespace");

const fetchGarenaMatch = async (matchId) => {
  if (!API_URL || !CLIENT_ID) {
    throw new Error("API_URL or CLIENT_ID is not configured");
  }

  const response = await axios.get(`${API_URL}/${encodeURIComponent(matchId)}`, {
    timeout: 7000,
    headers: {
      "Client-ID": CLIENT_ID,
    },
  });

  return response.data;
};

const listPlayers = async (tournamentId) => {
  const result = await pool.query(
    `
    SELECT player_uid, player_name, camera_link
    FROM team_players
    WHERE tournament_id = $1
      AND player_uid IS NOT NULL
      AND TRIM(player_uid) <> ''
    ORDER BY player_name ASC NULLS LAST, player_uid ASC
    `,
    [tournamentId],
  );

  return result.rows.map((row) => ({
    uid: String(row.player_uid),
    name: row.player_name || "Unknown Player",
    camUrl: row.camera_link || "",
  }));
};

const getEnabledMatchIds = async (tournamentId) => {
  const result = await pool.query(
    `
    SELECT match_id
    FROM game_details
    WHERE tournament_id = $1
      AND enabled = true
      AND match_id IS NOT NULL
      AND TRIM(match_id) <> ''
    ORDER BY id DESC
    `,
    [tournamentId],
  );

  return result.rows.map((row) => String(row.match_id));
};

const findSpectatorObservation = async (spectatorId, matchIds) => {
  for (const matchId of matchIds) {
    try {
      const rawMatch = await fetchGarenaMatch(matchId);
      const spectorInfo = rawMatch?.match?.match_stats_extra?.spector_info;

      if (!Array.isArray(spectorInfo)) {
        continue;
      }

      const spectEntry = spectorInfo.find(
        (entry) => String(entry?.spector_id || "").trim() === String(spectatorId),
      );

      if (spectEntry) {
        return {
          matchId,
          spectatorId: String(spectEntry.spector_id || spectatorId),
          observingPlayerUid: String(spectEntry.observer_id || "").trim(),
          observingPlayerName: String(spectEntry.observer_name || "").trim(),
          observingTeamName: String(spectEntry.observer_team_name || "").trim(),
        };
      }
    } catch (error) {
      console.error(`Spectator fetch failed for match ${matchId}:`, error.message);
    }
  }

  return null;
};

const buildSpectatorFeedForMatch = async (_tournamentId, matchId) => {
  const rawMatch = await fetchGarenaMatch(String(matchId));
  const spectorInfo = rawMatch?.match?.match_stats_extra?.spector_info;
  if (!Array.isArray(spectorInfo)) {
    return {
      matchId: String(matchId),
      spectators: [],
    };
  }

  return {
    matchId: String(matchId),
    spectators: spectorInfo.map((entry) => ({
      spectatorId: String(entry?.spector_id || "").trim(),
      observerId: String(entry?.observer_id || "").trim(),
      observerName: String(entry?.observer_name || "").trim(),
      observerTeamName: String(entry?.observer_team_name || "").trim(),
    })),
  };
};

const buildSpectatorPayload = async (tournamentId, spectId) => {
  const groups = Array.from(getTournamentBucket(groupsByTournament, tournamentId).values());
  const group = groups.find((entry) => entry.spectIds.includes(String(spectId)));

  if (!group) {
    const error = new Error("spectatorId does not belong to any active spectator group");
    error.statusCode = 404;
    throw error;
  }

  const matchIds = await getEnabledMatchIds(tournamentId);
  if (!matchIds.length) {
    const error = new Error("No enabled match ids found for spectator lookup");
    error.statusCode = 404;
    throw error;
  }

  const observation = await findSpectatorObservation(spectId, matchIds);
  if (!observation) {
    const error = new Error("spectatorId was not found in enabled Garena match data");
    error.statusCode = 404;
    throw error;
  }

  return buildSpectatorPayloadForMatch(tournamentId, spectId, observation.matchId);
};

const ensureTournamentEngine = (req, tournamentId) => {
  const key = String(tournamentId);
  if (enginesByTournament.has(key)) {
    return;
  }

  const tick = async () => {
    const groups = Array.from(getTournamentBucket(groupsByTournament, tournamentId).values());
    const namespace = getSpectatorNamespace(req);
    const latestBucket = getTournamentBucket(latestByTournament, tournamentId);

    if (!groups.length || !namespace) {
      return;
    }

    for (const group of groups) {
      for (const spectId of group.spectIds) {
        try {
          const payload = await buildSpectatorPayload(tournamentId, spectId);
          const previous = latestBucket.get(spectId);
          const changed =
            !previous ||
            previous.playerId !== payload.playerId ||
            previous.camera !== payload.camera ||
            previous.matchId !== payload.matchId;

          latestBucket.set(spectId, payload);

          if (changed) {
            namespace.to(toRoomName(tournamentId, spectId)).emit("camera_update", payload);
          }
        } catch (error) {
          if (error.statusCode !== 404) {
            console.error(`Spectator engine error for ${spectId}:`, error.message);
          }
        }
      }
    }
  };

  const timerId = setInterval(() => {
    tick().catch((error) => {
      console.error("Spectator engine tick failed:", error.message);
    });
  }, POLL_INTERVAL_MS);

  enginesByTournament.set(key, timerId);
  tick().catch((error) => {
    console.error("Initial spectator engine tick failed:", error.message);
  });
};

router.get("/spectator/players", async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const players = await listPlayers(tournamentId);
    res.json({ success: true, players });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/spectator/groups", async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const groups = Array.from(getTournamentBucket(groupsByTournament, tournamentId).values());
    res.json({ success: true, groups });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/spectator/create", async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const groupId = String(req.body?.groupId || "").trim();
    const spectIds = normalizeSpectIds(req.body?.spectIds || []);

    if (!groupId) {
      return res.status(400).json({ success: false, message: "groupId is required" });
    }

    if (!spectIds.length) {
      return res.status(400).json({ success: false, message: "At least one spectId is required" });
    }

    const groups = getTournamentBucket(groupsByTournament, tournamentId);
    const latest = getTournamentBucket(latestByTournament, tournamentId);
    const group = {
      groupId,
      spectIds,
      tournamentId,
      createdAt: new Date().toISOString(),
    };

    groups.set(groupId, group);
    spectIds.forEach((spectId) => latest.set(spectId, latest.get(spectId) || null));
    ensureTournamentEngine(req, tournamentId);

    return res.status(201).json({
      success: true,
      message: `Spectator group created with ${spectIds.length} route${spectIds.length === 1 ? "" : "s"}.`,
      group,
      tournamentId,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put("/spectator/groups/:groupId", async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const currentGroupId = String(req.params.groupId || "").trim();
    const nextGroupId = String(req.body?.groupId || currentGroupId).trim();
    const spectIds = normalizeSpectIds(req.body?.spectIds || []);
    const groups = getTournamentBucket(groupsByTournament, tournamentId);
    const latest = getTournamentBucket(latestByTournament, tournamentId);
    const existing = groups.get(currentGroupId);

    if (!existing) {
      return res.status(404).json({ success: false, message: "Spectator group not found" });
    }

    if (!nextGroupId) {
      return res.status(400).json({ success: false, message: "groupId is required" });
    }

    if (!spectIds.length) {
      return res.status(400).json({ success: false, message: "At least one spectId is required" });
    }

    groups.delete(currentGroupId);
    existing.spectIds.forEach((spectId) => {
      if (!spectIds.includes(spectId)) {
        latest.delete(spectId);
      }
    });

    const updatedGroup = {
      groupId: nextGroupId,
      spectIds,
      tournamentId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    groups.set(nextGroupId, updatedGroup);
    spectIds.forEach((spectId) => latest.set(spectId, latest.get(spectId) || null));
    ensureTournamentEngine(req, tournamentId);

    return res.json({ success: true, message: "Spectator group updated.", group: updatedGroup });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.delete("/spectator/groups/:groupId", async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const groupId = String(req.params.groupId || "").trim();
    const groups = getTournamentBucket(groupsByTournament, tournamentId);
    const latest = getTournamentBucket(latestByTournament, tournamentId);
    const existing = groups.get(groupId);

    if (!existing) {
      return res.status(404).json({ success: false, message: "Spectator group not found" });
    }

    groups.delete(groupId);
    existing.spectIds.forEach((spectId) => latest.delete(spectId));

    return res.json({ success: true, message: "Spectator group deleted.", groupId });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/spectator/resolve/:spectId", async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const spectId = String(req.params.spectId || "").trim();
    const payload = await buildSpectatorPayload(tournamentId, spectId);

    getTournamentBucket(latestByTournament, tournamentId).set(spectId, payload);

    return res.json({
      success: true,
      ...payload,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
    });
  }
});

router.get("/spectator/:spectId", async (req, res) => {
  try {
    const tournamentId = await getTournamentIdFromRequest(pool, req);
    const spectId = String(req.params.spectId || "").trim();
    const latest = getTournamentBucket(latestByTournament, tournamentId).get(spectId) || null;

    return res.json({
      success: true,
      spectatorId: spectId,
      tournamentId,
      latest,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = {
  router,
  toRoomName,
  toCameraRoomName,
  buildSpectatorFeedForMatch,
};
