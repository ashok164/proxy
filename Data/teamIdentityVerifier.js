const defaultNormalizeTeamId = (value) => {
  const clean = String(value ?? "").trim();
  if (!/^\d+$/.test(clean)) return clean;

  const numberValue = Number(clean);
  return Number.isSafeInteger(numberValue) ? String(numberValue) : clean;
};

const firstValue = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== "");

const getPlayerUid = (player = {}) =>
  firstValue(
    player.account_id,
    player.accountId,
    player.accountID,
    player.player_uid,
    player.playerUid,
    player.playerUID,
    player.uid,
    player.player_id,
    player.playerId,
    player.id,
  );

const normalizePlayerUid = (value) => String(value ?? "").trim();

const normalizePlayersList = (players) => {
  if (Array.isArray(players)) return players;
  if (players && typeof players === "object") return Object.values(players);
  return [];
};

const getDefaultPlayersFromTeam = (team = {}) =>
  normalizePlayersList(firstValue(team.player_stats, team.playerStats, team.players));

const normalizeName = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/4/g, "a")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/5/g, "s")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const getTeamName = (team = {}) =>
  firstValue(team.team_name, team.teamName, team.name, team.team, team.title);

const buildRegisteredPlayerIndex = async (pool, normalizeTeamId) => {
  const result = await pool.query(`
    SELECT team_id, player_uid
    FROM team_players
    WHERE player_uid IS NOT NULL AND TRIM(player_uid) <> ''
  `);

  const byUid = {};

  for (const row of result.rows) {
    const uid = normalizePlayerUid(row.player_uid);
    const teamId = normalizeTeamId(row.team_id);
    if (!uid || !teamId) continue;

    if (!byUid[uid]) byUid[uid] = {};
    byUid[uid][teamId] = (byUid[uid][teamId] || 0) + 1;
  }

  return byUid;
};

const buildExistingRoomMap = async (pool, matchId, normalizeTeamId) => {
  const result = await pool.query(
    `
    SELECT room_team_id, permanent_team_id
    FROM match_team_mappings
    WHERE match_id = $1
    `,
    [matchId],
  );

  return Object.fromEntries(
    result.rows
      .map((row) => [
        normalizeTeamId(row.room_team_id),
        normalizeTeamId(row.permanent_team_id),
      ])
      .filter(([roomTeamId, permanentTeamId]) => roomTeamId && permanentTeamId),
  );
};

const buildMappedTeamIdentities = async (pool, matchId, normalizeTeamId) => {
  const result = await pool.query(
    `
    SELECT
      mtm.room_team_id,
      mtm.permanent_team_id,
      mtm.mapped_team_name,
      mtm.mapped_team_tag,
      t.team_name,
      t.short_tag
    FROM match_team_mappings mtm
    LEFT JOIN teams t
      ON t.team_id = mtm.permanent_team_id
    WHERE mtm.match_id = $1
    `,
    [matchId],
  );

  return result.rows
    .map((row) => ({
      roomTeamId: normalizeTeamId(row.room_team_id),
      teamId: normalizeTeamId(row.permanent_team_id),
      teamName: row.mapped_team_name || row.team_name || "",
      teamTag: row.mapped_team_tag || row.short_tag || "",
      normalizedName: normalizeName(row.mapped_team_name || row.team_name),
      normalizedTag: normalizeName(row.mapped_team_tag || row.short_tag),
    }))
    .filter((row) => row.teamId);
};

const scoreTeamIdentity = (players, registeredByUid) => {
  const uniqueUids = [
    ...new Set(
      normalizePlayersList(players)
        .map((player) => normalizePlayerUid(getPlayerUid(player)))
        .filter(Boolean),
    ),
  ];

  const scores = {};

  for (const uid of uniqueUids) {
    const teamsForUid = registeredByUid[uid] || {};
    for (const [teamId, count] of Object.entries(teamsForUid)) {
      scores[teamId] = (scores[teamId] || 0) + count;
    }
  }

  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const [bestTeamId, bestScore = 0] = ranked[0] || [];
  const [, secondScore = 0] = ranked[1] || [];
  const minMatches = Math.max(
    1,
    Number(process.env.TEAM_IDENTITY_MIN_PLAYER_MATCHES) || 2,
  );

  return {
    teamId: bestTeamId || "",
    score: bestScore,
    secondScore,
    playerUidCount: uniqueUids.length,
    matched: Boolean(bestTeamId && bestScore >= minMatches && bestScore > secondScore),
  };
};

const matchMappedIdentity = (teamName, mappedTeams) => {
  const normalized = normalizeName(teamName);
  if (!normalized) {
    return {
      teamId: "",
      score: 0,
      secondScore: 0,
      matched: false,
      reason: "missing-team-name",
    };
  }

  const nameMatch = mappedTeams.find(
    (team) => team.normalizedName && team.normalizedName === normalized,
  );
  const tagMatch = mappedTeams.find(
    (team) => team.normalizedTag && team.normalizedTag === normalized,
  );
  const best = nameMatch || tagMatch || {};

  return {
    teamId: best.teamId || "",
    teamName: best.teamName || "",
    shortTag: best.teamTag || "",
    score: nameMatch ? 100 : tagMatch ? 90 : 0,
    secondScore: 0,
    matched: Boolean(best.teamId),
    reason: nameMatch ? "mapped-team-name" : tagMatch ? "mapped-team-tag" : "no-mapped-identity-match",
  };
};

const persistCorrections = async (pool, matchId, corrections) => {
  if (!corrections.length) return;

  await pool.query("BEGIN");

  try {
    for (const correction of corrections) {
      await pool.query(
        `
        DELETE FROM match_team_mappings
        WHERE match_id = $1
          AND permanent_team_id = $2
          AND room_team_id <> $3
        `,
        [matchId, correction.detectedPermanentTeamId, correction.roomTeamId],
      );

      await pool.query(
        `
        INSERT INTO match_team_mappings (
          match_id,
          room_team_id,
          permanent_team_id,
          mapped_team_name,
          mapped_team_tag,
          slot_number,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NULL, NOW())
        ON CONFLICT (match_id, room_team_id) DO UPDATE
        SET
          permanent_team_id = EXCLUDED.permanent_team_id,
          mapped_team_name = EXCLUDED.mapped_team_name,
          mapped_team_tag = EXCLUDED.mapped_team_tag,
          updated_at = NOW()
        `,
        [
          matchId,
          correction.roomTeamId,
          correction.detectedPermanentTeamId,
          correction.detectedTeamName || null,
          correction.detectedTeamTag || null,
        ],
      );
    }

    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    throw err;
  }
};

const verifyAndCorrectTeamMappings = async (
  pool,
  {
    matchId,
    teams = [],
    existingRoomMap,
    getRoomTeamId,
    getPlayersFromTeam = getDefaultPlayersFromTeam,
    normalizeTeamId = defaultNormalizeTeamId,
    persist = true,
  } = {},
) => {
  const cleanMatchId = String(matchId ?? "").trim();
  if (!cleanMatchId || !Array.isArray(teams) || !teams.length) {
    return {
      roomTeamMap: existingRoomMap || {},
      corrections: [],
      detections: {},
    };
  }

  const roomTeamMap =
    existingRoomMap || (await buildExistingRoomMap(pool, cleanMatchId, normalizeTeamId));
  const registeredByUid = await buildRegisteredPlayerIndex(pool, normalizeTeamId);
  const mappedTeams = await buildMappedTeamIdentities(pool, cleanMatchId, normalizeTeamId);
  const detections = {};

  for (const team of teams) {
    const roomTeamId = normalizeTeamId(getRoomTeamId(team));
    if (!roomTeamId) continue;

    const mappedIdentityDetection = matchMappedIdentity(getTeamName(team), mappedTeams);
    const uidDetection = mappedIdentityDetection.matched
      ? null
      : scoreTeamIdentity(getPlayersFromTeam(team), registeredByUid);
    const detection = mappedIdentityDetection.matched
      ? {
          ...mappedIdentityDetection,
          playerUidCount: 0,
          source: mappedIdentityDetection.reason,
          detectedTeamName: mappedIdentityDetection.teamName,
          detectedTeamTag: mappedIdentityDetection.shortTag,
        }
      : {
          ...uidDetection,
          source: "player-uid",
          detectedTeamName:
            mappedTeams.find((mappedTeam) => mappedTeam.teamId === uidDetection.teamId)
              ?.teamName || "",
          detectedTeamTag:
            mappedTeams.find((mappedTeam) => mappedTeam.teamId === uidDetection.teamId)
              ?.teamTag || "",
        };
    detections[roomTeamId] = detection;
  }

  const chosenByPermanentTeam = {};

  for (const [roomTeamId, detection] of Object.entries(detections)) {
    if (!detection.matched) continue;

    const previous = chosenByPermanentTeam[detection.teamId];
    if (
      !previous ||
      detection.score > previous.score ||
      (detection.score === previous.score &&
        detection.playerUidCount > previous.playerUidCount)
    ) {
      chosenByPermanentTeam[detection.teamId] = { roomTeamId, ...detection };
    }
  }

  const corrections = Object.values(chosenByPermanentTeam)
    .filter((detection) => roomTeamMap[detection.roomTeamId] !== detection.teamId)
    .map((detection) => ({
      roomTeamId: detection.roomTeamId,
      previousPermanentTeamId: roomTeamMap[detection.roomTeamId] || null,
      detectedPermanentTeamId: detection.teamId,
      matchedPlayers: detection.source === "player-uid" ? detection.score : 0,
      matchScore: detection.score,
      playerUidCount: detection.playerUidCount,
      source: detection.source,
      detectedTeamName: detection.detectedTeamName,
      detectedTeamTag: detection.detectedTeamTag,
    }));

  for (const correction of corrections) {
    for (const [mappedRoomTeamId, permanentTeamId] of Object.entries(roomTeamMap)) {
      if (
        mappedRoomTeamId !== correction.roomTeamId &&
        permanentTeamId === correction.detectedPermanentTeamId
      ) {
        delete roomTeamMap[mappedRoomTeamId];
      }
    }
    roomTeamMap[correction.roomTeamId] = correction.detectedPermanentTeamId;
  }

  if (persist && corrections.length) {
    await persistCorrections(pool, cleanMatchId, corrections);
  }

  return {
    roomTeamMap,
    corrections,
    detections,
  };
};

module.exports = {
  verifyAndCorrectTeamMappings,
};
