const defaultNormalizeTeamId = (value) => {
  const clean = String(value ?? "").trim();
  if (!/^\d+$/.test(clean)) return clean;

  const numberValue = Number(clean);
  return Number.isSafeInteger(numberValue) ? String(numberValue) : clean;
};

const firstValue = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== "");

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

const normalizePlayerUid = (value) => String(value ?? "").trim();

const normalizePlayersList = (players) => {
  if (Array.isArray(players)) return players;
  if (players && typeof players === "object") return Object.values(players);
  return [];
};

const getDefaultPlayersFromTeam = (team = {}) =>
  normalizePlayersList(firstValue(team.player_stats, team.playerStats, team.players));

const getTeamName = (team = {}) =>
  firstValue(team.team_name, team.teamName, team.name, team.team, team.title);

const getTeamTag = (team = {}) =>
  firstValue(
    team.short_tag,
    team.team_tag,
    team.teamTag,
    team.shortTag,
    team.tag,
    team.shortName,
  );

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

const buildRegisteredTeamIdentities = async (
  pool,
  normalizeTeamId,
  tournamentId,
  playingOnly = false,
) => {
  const params = [];
  const whereParts = [];
  if (tournamentId) {
    params.push(tournamentId);
    whereParts.push(`tournament_id = $${params.length}`);
  }
  if (playingOnly) {
    whereParts.push("is_playing = true");
  }
  const tournamentWhere = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  const result = await pool.query(`
    SELECT team_id, permanent_team_id, team_name, short_tag
    FROM teams
    ${tournamentWhere}
  `, params);

  return result.rows
    .map((row) => ({
      teamId: normalizeTeamId(row.permanent_team_id || row.team_id),
      displayTeamId: normalizeTeamId(row.team_id),
      permanentTeamId: normalizeTeamId(row.permanent_team_id || row.team_id),
      teamName: row.team_name || "",
      teamTag: row.short_tag || "",
      normalizedName: normalizeName(row.team_name),
      normalizedTag: normalizeName(row.short_tag),
    }))
    .filter((row) => row.teamId);
};

const buildRegisteredPlayerIndex = async (
  pool,
  normalizeTeamId,
  tournamentId,
  playingOnly = false,
) => {
  const params = [];
  const whereParts = [];
  if (tournamentId) {
    params.push(tournamentId);
    whereParts.push(`tp.tournament_id = $${params.length}`);
  }
  if (playingOnly) {
    whereParts.push("t.is_playing = true");
  }
  const tournamentWhere = whereParts.length ? `AND ${whereParts.join(" AND ")}` : "";

  const result = await pool.query(`
    SELECT tp.team_id, COALESCE(t.permanent_team_id, tp.team_id) AS permanent_team_id, tp.player_uid
    FROM team_players tp
    LEFT JOIN teams t
      ON t.team_id = tp.team_id
      AND t.tournament_id = tp.tournament_id
    WHERE player_uid IS NOT NULL AND TRIM(player_uid) <> ''
      ${tournamentWhere}
  `, params);

  const byUid = {};

  for (const row of result.rows) {
    const uid = normalizePlayerUid(row.player_uid);
    const teamId = normalizeTeamId(row.permanent_team_id || row.team_id);
    if (!uid || !teamId) continue;

    if (!byUid[uid]) byUid[uid] = {};
    byUid[uid][teamId] = (byUid[uid][teamId] || 0) + 1;
  }

  return byUid;
};

const matchByNameOrTag = (team, registeredTeams) => {
  const normalizedName = normalizeName(getTeamName(team));
  const normalizedTag = normalizeName(getTeamTag(team));
  const findUnique = (predicate) => {
    const matches = registeredTeams.filter(predicate);
    return matches.length === 1 ? matches[0] : null;
  };

  const nameMatch = normalizedName
    ? registeredTeams.find((entry) => entry.normalizedName === normalizedName)
    : null;
  if (nameMatch) {
    return {
      teamId: nameMatch.teamId,
      teamName: nameMatch.teamName,
      shortTag: nameMatch.teamTag,
      score: 100,
      secondScore: 0,
      playerUidCount: 0,
      matched: true,
      source: "registered-team-name",
    };
  }

  const tagMatch = normalizedTag
    ? registeredTeams.find((entry) => entry.normalizedTag === normalizedTag)
    : null;
  if (tagMatch) {
    return {
      teamId: tagMatch.teamId,
      teamName: tagMatch.teamName,
      shortTag: tagMatch.teamTag,
      score: 90,
      secondScore: 0,
      playerUidCount: 0,
      matched: true,
      source: "registered-team-tag",
    };
  }

  const nameToTagMatch = normalizedName
    ? registeredTeams.find((entry) => entry.normalizedTag === normalizedName)
    : null;
  if (nameToTagMatch) {
    return {
      teamId: nameToTagMatch.teamId,
      teamName: nameToTagMatch.teamName,
      shortTag: nameToTagMatch.teamTag,
      score: 95,
      secondScore: 0,
      playerUidCount: 0,
      matched: true,
      source: "registered-team-name-to-tag",
    };
  }

  const longNameMatch =
    normalizedName.length >= 8
      ? findUnique(
          (entry) =>
            entry.normalizedName.length >= 8 &&
            (entry.normalizedName.startsWith(normalizedName) ||
              normalizedName.startsWith(entry.normalizedName)),
        )
      : null;
  if (longNameMatch) {
    return {
      teamId: longNameMatch.teamId,
      teamName: longNameMatch.teamName,
      shortTag: longNameMatch.teamTag,
      score: 85,
      secondScore: 0,
      playerUidCount: 0,
      matched: true,
      source: "registered-team-name-prefix",
    };
  }

  return {
    teamId: "",
    score: 0,
    secondScore: 0,
    playerUidCount: 0,
    matched: false,
    source: "no-name-or-tag-match",
  };
};

const matchByPlayerUid = (players, registeredByUid, registeredTeams) => {
  const uniqueUids = [
    ...new Set(
      normalizePlayersList(players)
        .map((player) => normalizePlayerUid(getPlayerUid(player)))
        .filter(Boolean),
    ),
  ];
  const scores = {};

  for (const uid of uniqueUids) {
    for (const [teamId, count] of Object.entries(registeredByUid[uid] || {})) {
      scores[teamId] = (scores[teamId] || 0) + count;
    }
  }

  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const [bestTeamId, bestScore = 0] = ranked[0] || [];
  const [, secondScore = 0] = ranked[1] || [];
  const minMatches = Math.max(
    1,
    Number(process.env.TEAM_IDENTITY_MIN_PLAYER_MATCHES) || 1,
  );
  const matched = Boolean(bestTeamId && bestScore >= minMatches && bestScore > secondScore);
  const knownTeam = registeredTeams.find((team) => team.teamId === bestTeamId) || {};

  return {
    teamId: matched ? bestTeamId : "",
    teamName: matched ? knownTeam.teamName || "" : "",
    shortTag: matched ? knownTeam.teamTag || "" : "",
    score: bestScore,
    secondScore,
    playerUidCount: uniqueUids.length,
    matched,
    source: matched ? "player-uid" : "no-player-uid-match",
  };
};

const resolveTeamIdentities = async (
  pool,
  {
    matchId,
    teams = [],
    getRoomTeamId,
    getPlayersFromTeam = getDefaultPlayersFromTeam,
    normalizeTeamId = defaultNormalizeTeamId,
    tournamentId,
    playingOnly = false,
  } = {},
) => {
  if (!Array.isArray(teams) || !teams.length) {
    return {
      roomTeamMap: {},
      corrections: [],
      detections: {},
      matchId: String(matchId ?? "").trim(),
    };
  }

  const registeredTeams = await buildRegisteredTeamIdentities(
    pool,
    normalizeTeamId,
    tournamentId,
    playingOnly,
  );
  const registeredByUid = await buildRegisteredPlayerIndex(
    pool,
    normalizeTeamId,
    tournamentId,
    playingOnly,
  );
  const detections = {};
  const roomTeamMap = {};
  const chosenByPermanentTeam = {};

  for (const team of teams) {
    const roomTeamId = normalizeTeamId(getRoomTeamId(team));
    if (!roomTeamId) continue;

    const nameOrTagDetection = matchByNameOrTag(team, registeredTeams);
    const detection = nameOrTagDetection.matched
      ? nameOrTagDetection
      : matchByPlayerUid(getPlayersFromTeam(team), registeredByUid, registeredTeams);

    detections[roomTeamId] = detection;

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

  const corrections = Object.values(chosenByPermanentTeam).map((detection) => {
    roomTeamMap[detection.roomTeamId] = detection.teamId;

    return {
      roomTeamId: detection.roomTeamId,
      previousPermanentTeamId: null,
      detectedPermanentTeamId: detection.teamId,
      permanentTeamId: detection.teamId,
      matchedPlayers: detection.source === "player-uid" ? detection.score : 0,
      matchScore: detection.score,
      playerUidCount: detection.playerUidCount,
      source: detection.source,
      detectedTeamName: detection.teamName,
      detectedTeamTag: detection.shortTag,
    };
  });

  return {
    roomTeamMap,
    corrections,
    detections,
    matchId: String(matchId ?? "").trim(),
  };
};

module.exports = {
  resolveTeamIdentities,
  verifyAndCorrectTeamMappings: resolveTeamIdentities,
};
