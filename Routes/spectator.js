const express = require("express");
const axios = require("axios");

const pool = require("../Database/db");
const { getTournamentIdFromRequest } = require("../Data/tournamentContext");

const router = express.Router({ mergeParams: true });

const getPushIntervalMs = () =>
  Math.max(50, parseInt(process.env.WS_PUSH_INTERVAL_MS, 10) || 100);
const API_URL = process.env.API_URL;
const CLIENT_ID = process.env.CLIENT_ID;

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
    .filter(Boolean);

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

const listSpectatorGroups = async (tournamentId) => {
  const result = await pool.query(
    `
    SELECT
      sg.group_id,
      sg.tournament_id,
      sg.created_at,
      sg.updated_at,
      COALESCE(
        ARRAY_AGG(sge.spectator_id ORDER BY sge.position ASC, sge.id ASC)
          FILTER (WHERE sge.spectator_id IS NOT NULL),
        ARRAY[]::TEXT[]
      ) AS spect_ids
    FROM spectator_groups sg
    LEFT JOIN spectator_group_entries sge
      ON sge.spectator_group_id = sg.id
    WHERE sg.tournament_id = $1
    GROUP BY sg.id
    ORDER BY sg.created_at ASC, sg.id ASC
    `,
    [tournamentId],
  );

  return result.rows.map((row) => ({
    groupId: String(row.group_id || "").trim(),
    spectIds: normalizeSpectIds(row.spect_ids || []),
    tournamentId: row.tournament_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
};

const getSpectatorGroup = async (tournamentId, groupId) => {
  const groups = await listSpectatorGroups(tournamentId);
  return groups.find((group) => group.groupId === String(groupId || "").trim()) || null;
};

const upsertSpectatorGroup = async (tournamentId, currentGroupId, nextGroupId, spectIds) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existingResult = await client.query(
      `
      SELECT id, group_id, created_at
      FROM spectator_groups
      WHERE tournament_id = $1 AND group_id = $2
      LIMIT 1
      `,
      [tournamentId, String(currentGroupId || "").trim()],
    );

    const existing = existingResult.rows[0] || null;

    if (!existing) {
      const insertResult = await client.query(
        `
        INSERT INTO spectator_groups (tournament_id, group_id, updated_at)
        VALUES ($1, $2, NOW())
        RETURNING id, group_id, tournament_id, created_at, updated_at
        `,
        [tournamentId, nextGroupId],
      );

      const created = insertResult.rows[0];
      for (let index = 0; index < spectIds.length; index += 1) {
        await client.query(
          `
          INSERT INTO spectator_group_entries (spectator_group_id, spectator_id, position, updated_at)
          VALUES ($1, $2, $3, NOW())
          `,
          [created.id, spectIds[index], index],
        );
      }

      await client.query("COMMIT");
      return {
        groupId: String(created.group_id || "").trim(),
        spectIds,
        tournamentId: created.tournament_id,
        createdAt: created.created_at,
        updatedAt: created.updated_at,
      };
    }

    await client.query(
      `
      UPDATE spectator_groups
      SET group_id = $1, updated_at = NOW()
      WHERE id = $2
      `,
      [nextGroupId, existing.id],
    );

    await client.query(
      `DELETE FROM spectator_group_entries WHERE spectator_group_id = $1`,
      [existing.id],
    );

    for (let index = 0; index < spectIds.length; index += 1) {
      await client.query(
        `
        INSERT INTO spectator_group_entries (spectator_group_id, spectator_id, position, updated_at)
        VALUES ($1, $2, $3, NOW())
        `,
        [existing.id, spectIds[index], index],
      );
    }

    const updatedResult = await client.query(
      `
      SELECT id, group_id, tournament_id, created_at, updated_at
      FROM spectator_groups
      WHERE id = $1
      LIMIT 1
      `,
      [existing.id],
    );

    await client.query("COMMIT");

    const updated = updatedResult.rows[0];
    return {
      groupId: String(updated.group_id || "").trim(),
      spectIds,
      tournamentId: updated.tournament_id,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const deleteSpectatorGroup = async (tournamentId, groupId) => {
  const result = await pool.query(
    `
    DELETE FROM spectator_groups
    WHERE tournament_id = $1 AND group_id = $2
    RETURNING id
    `,
    [tournamentId, String(groupId || "").trim()],
  );

  return Boolean(result.rowCount);
};

const getPlayerLookup = async (tournamentId) => {
  const result = await pool.query(
    `
    SELECT
      tp.player_uid,
      tp.player_name,
      tp.camera_link,
      t.team_name
    FROM team_players tp
    LEFT JOIN teams t
      ON t.team_id = tp.team_id
     AND t.tournament_id = tp.tournament_id
    WHERE tp.tournament_id = $1
      AND tp.player_uid IS NOT NULL
      AND TRIM(tp.player_uid) <> ''
    `,
    [tournamentId],
  );

  const lookup = new Map();
  result.rows.forEach((row) => {
    lookup.set(String(row.player_uid), {
      playerId: String(row.player_uid),
      playerName: row.player_name || "",
      cameraLink: row.camera_link || "",
      teamName: row.team_name || "",
    });
  });
  return lookup;
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

const buildSpectatorFeedForMatch = async (tournamentId, matchId) => {
  const rawMatch = await fetchGarenaMatch(String(matchId));
  const spectorInfo = rawMatch?.match?.match_stats_extra?.spector_info;
  const playerLookup = await getPlayerLookup(tournamentId);
  if (!Array.isArray(spectorInfo)) {
    return {
      matchId: String(matchId),
      spectators: [],
    };
  }

  return {
    matchId: String(matchId),
    spectators: spectorInfo.map((entry) => {
      const observerId = String(entry?.observer_id || "").trim();
      const savedPlayer = playerLookup.get(observerId);

      return {
        spectatorId: String(entry?.spector_id || "").trim(),
        playerId: observerId,
        playerName: savedPlayer?.playerName || String(entry?.observer_name || "").trim(),
        cameraLink: savedPlayer?.cameraLink || "",
        teamName: savedPlayer?.teamName || String(entry?.observer_team_name || "").trim(),
      };
    }),
  };
};

const buildLegacySpectatorPayloadForMatch = async (tournamentId, spectId, matchId) => {
  const feed = await buildSpectatorFeedForMatch(tournamentId, matchId);
  const row = Array.isArray(feed?.spectators)
    ? feed.spectators.find(
        (entry) => String(entry?.spectatorId || "").trim() === String(spectId || "").trim(),
      )
    : null;

  if (!row) {
    const error = new Error("spectatorId was not found in Garena match data");
    error.statusCode = 404;
    throw error;
  }

  return {
    spectatorId: String(row.spectatorId || spectId),
    matchId: String(feed.matchId || matchId),
    observerId: String(row.playerId || ""),
    observerName: String(row.playerName || ""),
    observerTeamName: String(row.teamName || ""),
  };
};

const buildSpectatorPayload = async (tournamentId, spectId) => {
  const groups = await listSpectatorGroups(tournamentId);
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

  return buildLegacySpectatorPayloadForMatch(tournamentId, spectId, observation.matchId);
};

const ensureTournamentEngine = (req, tournamentId) => {
  const key = String(tournamentId);
  if (enginesByTournament.has(key)) {
    return;
  }

  const tick = async () => {
    const groups = await listSpectatorGroups(tournamentId);
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
            previous.observerId !== payload.observerId ||
            previous.observerName !== payload.observerName ||
            previous.observerTeamName !== payload.observerTeamName ||
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
  }, getPushIntervalMs());

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
    const groups = await listSpectatorGroups(tournamentId);
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

    const latest = getTournamentBucket(latestByTournament, tournamentId);
    const existing = await getSpectatorGroup(tournamentId, groupId);
    if (existing) {
      return res.status(409).json({ success: false, message: "Spectator group already exists" });
    }

    const group = await upsertSpectatorGroup(tournamentId, groupId, groupId, spectIds);
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
    const latest = getTournamentBucket(latestByTournament, tournamentId);
    const existing = await getSpectatorGroup(tournamentId, currentGroupId);

    if (!existing) {
      return res.status(404).json({ success: false, message: "Spectator group not found" });
    }

    if (!nextGroupId) {
      return res.status(400).json({ success: false, message: "groupId is required" });
    }

    if (!spectIds.length) {
      return res.status(400).json({ success: false, message: "At least one spectId is required" });
    }

    existing.spectIds.forEach((spectId) => {
      if (!spectIds.includes(spectId)) {
        latest.delete(spectId);
      }
    });

    const updatedGroup = await upsertSpectatorGroup(
      tournamentId,
      currentGroupId,
      nextGroupId,
      spectIds,
    );
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
    const latest = getTournamentBucket(latestByTournament, tournamentId);
    const existing = await getSpectatorGroup(tournamentId, groupId);

    if (!existing) {
      return res.status(404).json({ success: false, message: "Spectator group not found" });
    }

    await deleteSpectatorGroup(tournamentId, groupId);
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
