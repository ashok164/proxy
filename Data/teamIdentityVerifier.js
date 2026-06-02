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

const getNameTokens = (value) =>
  normalizeName(value)
    .split(" ")
    .filter((token) => token.length > 1 && !["esport", "esports", "team", "gaming"].includes(token));

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

const buildRegisteredTeamIndex = async (pool, normalizeTeamId) => {
  const result = await pool.query(`
    SELECT team_id, team_name, short_tag
    FROM teams
  `);

  return result.rows
    .map((row) => ({
      teamId: normalizeTeamId(row.team_id),
      teamName: row.team_name || "",
      shortTag: row.short_tag || "",
      normalizedName: normalizeName(row.team_name),
      normalizedTag: normalizeName(row.short_tag),
      nameTokens: getNameTokens(row.team_name),
    }))
    .filter((row) => row.teamId);
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

const scoreNameIdentity = (teamName, registeredTeams) => {
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

  const sourceTokens = getNameTokens(normalized);
  const ranked = registeredTeams
    .map((team) => {
      let score = 0;

      if (team.normalizedName === normalized) score += 100;
      if (team.normalizedTag && team.normalizedTag === normalized) score += 90;
      if (team.normalizedName && normalized.includes(team.normalizedName)) score += 70;
      if (team.normalizedName && team.normalizedName.includes(normalized)) score += 60;

      const tokenMatches = team.nameTokens.filter((token) =>
        sourceTokens.includes(token),
      ).length;
      score += tokenMatches * 18;

      if (
        team.normalizedTag &&
        sourceTokens.includes(team.normalizedTag) &&
        team.normalizedTag.length >= 2
      ) {
        score += 35;
      }

      return {
        teamId: team.teamId,
        teamName: team.teamName,
        shortTag: team.shortTag,
        score,
      };
    })
    .filter((team) => team.score > 0)
    .sort((left, right) => right.score - left.score);

  const best = ranked[0] || {};
  const second = ranked[1] || {};
  const minScore = Number(process.env.TEAM_IDENTITY_NAME_MIN_SCORE) || 70;
  const minGap = Number(process.env.TEAM_IDENTITY_NAME_MIN_GAP) || 20;

  return {
    teamId: best.teamId || "",
    teamName: best.teamName || "",
    shortTag: best.shortTag || "",
    score: best.score || 0,
    secondScore: second.score || 0,
    matched: Boolean(
      best.teamId &&
        best.score >= minScore &&
        best.score - (second.score || 0) >= minGap,
    ),
    reason: "team-name",
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
          slot_number,
          updated_at
        )
        VALUES ($1, $2, $3, NULL, NOW())
        ON CONFLICT (match_id, room_team_id) DO UPDATE
        SET
          permanent_team_id = EXCLUDED.permanent_team_id,
          updated_at = NOW()
        `,
        [matchId, correction.roomTeamId, correction.detectedPermanentTeamId],
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
  const registeredTeams = await buildRegisteredTeamIndex(pool, normalizeTeamId);
  const detections = {};

  for (const team of teams) {
    const roomTeamId = normalizeTeamId(getRoomTeamId(team));
    if (!roomTeamId) continue;

    const uidDetection = scoreTeamIdentity(getPlayersFromTeam(team), registeredByUid);
    const nameDetection = uidDetection.matched
      ? null
      : scoreNameIdentity(getTeamName(team), registeredTeams);
    const detection = uidDetection.matched
      ? { ...uidDetection, source: "player-uid" }
      : {
          teamId: nameDetection.teamId,
          score: nameDetection.score,
          secondScore: nameDetection.secondScore,
          playerUidCount: uidDetection.playerUidCount,
          matched: nameDetection.matched,
          source: "team-name",
          detectedTeamName: nameDetection.teamName,
          detectedTeamTag: nameDetection.shortTag,
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
