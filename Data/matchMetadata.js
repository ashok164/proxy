const path = require("path");

const ASSET_TABLES = {
  character: "characters",
  active_skill: "skills",
  passive_skill: "skills",
  weapon: "weapons",
  pet: "pets",
  equipment: "equipment",
};

const firstValue = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== "");

const toInteger = (value, fallback = 0) => {
  if (value === undefined || value === null || value === "") return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : fallback;
};

const toNullableString = (value) => {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean === "" ? null : clean;
};

const normalizeAssetId = (value) => {
  const clean = toNullableString(value);
  return clean || null;
};

const normalizeUploadPath = (value) => {
  if (!value) return "";
  const clean = String(value).trim().replace(/\\/g, "/");
  if (clean.startsWith("http://") || clean.startsWith("https://")) return clean;
  return clean.replace(/^\/?uploads\//i, "");
};

const formatImageUrl = (baseUrl, imagePath) => {
  if (!imagePath) return "";
  const clean = String(imagePath).trim();
  if (clean.startsWith("http://") || clean.startsWith("https://")) return clean;
  return `${baseUrl}/uploads/${clean.replace(/^\/?uploads\//i, "")}`;
};

const getBodyValue = (body = {}, ...names) => {
  for (const name of names) {
    if (body[name] !== undefined) return body[name];
  }

  const lowerNameMap = Object.keys(body || {}).reduce((acc, key) => {
    acc[key.toLowerCase()] = key;
    return acc;
  }, {});

  for (const name of names) {
    const actualKey = lowerNameMap[String(name).toLowerCase()];
    if (actualKey && body[actualKey] !== undefined) return body[actualKey];
  }

  return undefined;
};

const arrayValue = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return [];
};

const normalizeAsset = (value, fallbackType) => {
  if (!value) return null;

  if (typeof value === "string" || typeof value === "number") {
    const clean = String(value).trim();
    if (!clean) return null;
    return {
      id: clean,
      name: "",
      image: "",
      type: fallbackType,
    };
  }

  if (typeof value !== "object") return null;

  const id = normalizeAssetId(
    firstValue(
      value.asset_id,
      value.assetId,
      value.code,
      value.id,
      value.skill_id,
      value.skillId,
      value.weapon_id,
      value.weaponId,
      value.pet_id,
      value.petId,
      value.equipment_id,
      value.equipmentId,
      value.character_id,
      value.characterId,
      value.avatar_id,
      value.avatarId,
    ),
  );
  const name = toNullableString(firstValue(value.name, value.title, value.label)) || "";
  const assetName =
    toNullableString(
      firstValue(
        value.skill_name,
        value.skillName,
        value.weapon_name,
        value.weaponName,
        value.pet_skill_name,
        value.petSkillName,
        value.pet_name,
        value.petName,
        value.character_name,
        value.characterName,
      ),
    ) || name;
  const image = normalizeUploadPath(
    firstValue(
      value.image,
      value.image_url,
      value.imageUrl,
      value.icon,
      value.icon_url,
      value.iconUrl,
      value.logo,
      value.url,
    ),
  );

  if (!id && !assetName && !image) return null;

  return {
    id: id || assetName || path.basename(image || ""),
    name: assetName,
    image,
    type: fallbackType,
  };
};

const normalizeFreeFireSkill = (skill, fallbackType) =>
  normalizeAsset(
    {
      id: firstValue(skill?.skill_id, skill?.skillId, skill?.id),
      name: firstValue(skill?.skill_name, skill?.skillName, skill?.name),
      image: firstValue(skill?.image, skill?.image_url, skill?.imageUrl),
    },
    fallbackType,
  );

const normalizeFreeFireWeapon = (weapon) =>
  normalizeAsset(
    {
      id: firstValue(weapon?.weapon_id, weapon?.weaponId, weapon?.id),
      name: firstValue(weapon?.weapon_name, weapon?.weaponName, weapon?.name),
      image: firstValue(weapon?.image, weapon?.image_url, weapon?.imageUrl),
    },
    "weapon",
  );

const getBestWeaponUsage = (player = {}) => {
  const usages = arrayValue(
    firstValue(player.weapon_usages, player.weaponUsages, player.weapons),
  );
  if (!usages.length) return null;

  return [...usages].sort(
    (left, right) =>
      toInteger(right.kills) - toInteger(left.kills) ||
      toInteger(right.damage) - toInteger(left.damage) ||
      toInteger(right.hits) - toInteger(left.hits) ||
      toInteger(right.shoots) - toInteger(left.shoots),
  )[0];
};

const getFreeFireActiveSkill = (player = {}) => {
  const skills = arrayValue(firstValue(player.skill_info, player.skillInfo));
  const active = skills.find((skill) => skill.skill_active === true) || skills[0];
  return normalizeFreeFireSkill(active, "active_skill");
};

const getFreeFirePassiveSkills = (player = {}) => {
  const skills = arrayValue(firstValue(player.skill_info, player.skillInfo));
  const skillIds = arrayValue(firstValue(player.skill_ids, player.skillIds));
  const activeSkillId = String(getFreeFireActiveSkill(player)?.id || "");

  if (skillIds.length) {
    return skillIds
      .map((skillId) => String(skillId))
      .filter((skillId, index, ids) =>
        skillId &&
        skillId !== activeSkillId &&
        ids.findIndex((id) => String(id) === skillId) === index
      )
      .map((skillId) => normalizeAsset({ id: skillId }, "passive_skill"))
      .filter(Boolean)
      .slice(0, 3);
  }

  const passiveByInfo = skills
    .filter((skill) => skill.skill_active !== true)
    .map((skill) => normalizeFreeFireSkill(skill, "passive_skill"))
    .filter(Boolean);

  return passiveByInfo.slice(0, 3);
};

const getFreeFirePet = (player = {}) =>
  normalizeAsset(
    {
      id: firstValue(player.pet_skill_id, player.petSkillId, player.pet_id, player.petId),
      name: firstValue(player.pet_skill_name, player.petSkillName, player.pet_name, player.petName),
      image: firstValue(player.pet_image, player.petImage),
    },
    "pet",
  );

const getFreeFireLoadouts = (player = {}) =>
  arrayValue(firstValue(player.loadouts, player.equipment_loadouts, player.equipmentLoadouts))
    .map((loadout) =>
      normalizeAsset(
        typeof loadout === "object" ? loadout : { id: loadout },
        "equipment",
      ),
    )
    .filter(Boolean);

const getPlayerId = (player = {}) =>
  firstValue(
    player.player_id,
    player.playerId,
    player.player_uid,
    player.playerUid,
    player.account_id,
    player.accountId,
    player.uid,
    player.id,
  );

const normalizePlayer = (player = {}) => {
  const activeSkill = normalizeAsset(
    firstValue(
      player.active_skill,
      player.activeSkill,
      player.activeSkillInfo,
      player.skill,
    ),
    "active_skill",
  ) || getFreeFireActiveSkill(player);
  const passiveSkills = arrayValue(
    firstValue(player.passive_skills, player.passiveSkills, player.passives),
  )
    .map((skill) => normalizeAsset(skill, "passive_skill"))
    .filter(Boolean)
    .concat(getFreeFirePassiveSkills(player))
    .filter(
      (skill, index, skills) =>
        skills.findIndex((item) => String(item.id) === String(skill.id)) === index,
    )
    .slice(0, 3);
  const weapon = normalizeAsset(
    firstValue(player.weapon_used, player.weaponUsed, player.weapon, player.gun),
    "weapon",
  ) || normalizeFreeFireWeapon(getBestWeaponUsage(player));
  const pet =
    normalizeAsset(firstValue(player.pet, player.pet_used, player.petUsed), "pet") ||
    getFreeFirePet(player);
  const character = normalizeAsset(
    firstValue(player.character, player.character_used, player.characterUsed) ||
      (player.avatar_id || player.avatarId
        ? { id: firstValue(player.avatar_id, player.avatarId) }
        : null),
    "character",
  );
  const equipmentLoadouts = arrayValue(
    firstValue(
      player.equipment_loadouts,
      player.equipmentLoadouts,
      player.loadouts,
      player.equipment,
    ),
  )
    .map((item) => normalizeAsset(item, "equipment"))
    .filter(Boolean)
    .concat(getFreeFireLoadouts(player))
    .filter(
      (item, index, items) =>
        items.findIndex((entry) => String(entry.id) === String(item.id)) === index,
    );

  return {
    playerId: toNullableString(getPlayerId(player)),
    playerName:
      toNullableString(
        firstValue(player.player_name, player.playerName, player.name, player.nickname),
      ) || "",
    playerImage: normalizeUploadPath(
      firstValue(
        player.player_image,
        player.playerImage,
        player.player_pic,
        player.playerPic,
        player.image,
        player.avatar,
      ),
    ),
    kills: toInteger(firstValue(player.kills, player.kill, player.kill_count, player.killCount)),
    damage: toInteger(firstValue(player.damage, player.damage_dealt, player.damageDealt)),
    assists: toInteger(firstValue(player.assists, player.assist, player.assist_count, player.assistCount)),
    knockdowns: toInteger(firstValue(player.knockdowns, player.knock_downs, player.knockDowns, player.knocks, player.knock_down)),
    survivalTime: toInteger(firstValue(player.survival_time, player.survivalTime, player.survival)),
    activeSkill,
    passiveSkills,
    weapon,
    pet,
    character,
    equipmentLoadouts,
    rawPayload: player,
  };
};

const getPlayersFromTeamPayload = (team = {}) => {
  const players = firstValue(
    team.players,
    team.player_stats,
    team.playerStats,
    team.members,
    team.roster,
  );
  return arrayValue(players);
};

const ensureMatchMetadataTables = async (pool) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_result_players (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER,
      match_result_id INTEGER REFERENCES match_results(id) ON DELETE CASCADE,
      match_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      permanent_team_id TEXT,
      player_id TEXT,
      player_name TEXT,
      player_image TEXT,
      kills INTEGER NOT NULL DEFAULT 0,
      damage INTEGER NOT NULL DEFAULT 0,
      assists INTEGER NOT NULL DEFAULT 0,
      knockdowns INTEGER NOT NULL DEFAULT 0,
      survival_time INTEGER NOT NULL DEFAULT 0,
      character_asset_id TEXT,
      active_skill_asset_id TEXT,
      weapon_asset_id TEXT,
      pet_asset_id TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await ensureTournamentColumn(pool, "match_result_players");
  await pool.query(`
    ALTER TABLE match_result_players
    ADD COLUMN IF NOT EXISTS permanent_team_id TEXT
  `);
  await pool.query(`
    UPDATE match_result_players
    SET permanent_team_id = team_id
    WHERE permanent_team_id IS NULL OR TRIM(permanent_team_id) = ''
  `);
  await pool.query("ALTER TABLE match_result_players DROP CONSTRAINT IF EXISTS match_result_players_unique");
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_match_result_players_tournament_unique
    ON match_result_players(tournament_id, match_id, team_id, player_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_player_passive_skills (
      id SERIAL PRIMARY KEY,
      match_player_id INTEGER REFERENCES match_result_players(id) ON DELETE CASCADE,
      skill_asset_id TEXT,
      slot INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT match_player_passive_unique UNIQUE (match_player_id, slot)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_player_equipment_loadouts (
      id SERIAL PRIMARY KEY,
      match_player_id INTEGER REFERENCES match_result_players(id) ON DELETE CASCADE,
      equipment_asset_id TEXT,
      slot INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT match_player_equipment_unique UNIQUE (match_player_id, slot)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_match_result_players_match_id
    ON match_result_players(match_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_match_result_players_team_id
    ON match_result_players(team_id);
  `);
};

const saveMatchPlayers = async (
  pool,
  matchResultId,
  matchId,
  teamId,
  players = [],
  tournamentId = null,
) => {
  await ensureMatchMetadataTables(pool);

  for (const playerPayload of players) {
    const player = normalizePlayer(playerPayload);
    if (!player.playerId && !player.playerName) continue;

    const playerResult = await pool.query(
      `
      INSERT INTO match_result_players (
        tournament_id,
        match_result_id,
        match_id,
        team_id,
        permanent_team_id,
        player_id,
        player_name,
        player_image,
        kills,
        damage,
        assists,
        knockdowns,
        survival_time,
        character_asset_id,
        active_skill_asset_id,
        weapon_asset_id,
        pet_asset_id,
        raw_payload,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, NOW())
      ON CONFLICT (tournament_id, match_id, team_id, player_id) DO UPDATE
      SET
        match_result_id = EXCLUDED.match_result_id,
        permanent_team_id = EXCLUDED.permanent_team_id,
        player_name = EXCLUDED.player_name,
        player_image = EXCLUDED.player_image,
        kills = EXCLUDED.kills,
        damage = EXCLUDED.damage,
        assists = EXCLUDED.assists,
        knockdowns = EXCLUDED.knockdowns,
        survival_time = EXCLUDED.survival_time,
        character_asset_id = EXCLUDED.character_asset_id,
        active_skill_asset_id = EXCLUDED.active_skill_asset_id,
        weapon_asset_id = EXCLUDED.weapon_asset_id,
        pet_asset_id = EXCLUDED.pet_asset_id,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
      RETURNING *
      `,
      [
        tournamentId,
        matchResultId,
        matchId,
        teamId,
        player.playerId || player.playerName,
        player.playerName,
        player.playerImage,
        player.kills,
        player.damage,
        player.assists,
        player.knockdowns,
        player.survivalTime,
        player.character?.id || null,
        player.activeSkill?.id || null,
        player.weapon?.id || null,
        player.pet?.id || null,
        JSON.stringify(player.rawPayload || {}),
      ],
    );

    const matchPlayerId = playerResult.rows[0].id;
    await pool.query("DELETE FROM match_player_passive_skills WHERE match_player_id = $1", [
      matchPlayerId,
    ]);
    await pool.query(
      "DELETE FROM match_player_equipment_loadouts WHERE match_player_id = $1",
      [matchPlayerId],
    );

    for (let index = 0; index < player.passiveSkills.length; index++) {
      await pool.query(
        `
        INSERT INTO match_player_passive_skills (match_player_id, skill_asset_id, slot)
        VALUES ($1, $2, $3)
        ON CONFLICT (match_player_id, slot) DO UPDATE
        SET skill_asset_id = EXCLUDED.skill_asset_id
        `,
        [matchPlayerId, player.passiveSkills[index].id, index + 1],
      );
    }

    for (let index = 0; index < player.equipmentLoadouts.length; index++) {
      await pool.query(
        `
        INSERT INTO match_player_equipment_loadouts (match_player_id, equipment_asset_id, slot)
        VALUES ($1, $2, $3)
        ON CONFLICT (match_player_id, slot) DO UPDATE
        SET equipment_asset_id = EXCLUDED.equipment_asset_id
        `,
        [matchPlayerId, player.equipmentLoadouts[index].id, index + 1],
      );
    }
  }
};

const formatAsset = (baseUrl, row = {}) => ({
  id: row.asset_id || "",
  name: row.name || "",
  image: formatImageUrl(baseUrl, row.image_url || ""),
});

const loadAnyAssetLookup = async (pool, baseUrl) => {
  const lookup = {
    byId: {},
    byName: {},
  };

  for (const table of new Set(Object.values(ASSET_TABLES))) {
    const result = await pool.query(
      `SELECT asset_id, name, image_url FROM ${table}`,
    );

    for (const row of result.rows) {
      const formatted = formatAsset(baseUrl, row);
      if (formatted.id && !lookup.byId[String(formatted.id)]) {
        lookup.byId[String(formatted.id)] = formatted;
      }
      if (formatted.name && !lookup.byName[String(formatted.name).toLowerCase()]) {
        lookup.byName[String(formatted.name).toLowerCase()] = formatted;
      }
    }
  }

  return lookup;
};

const loadAssetLookupFromTable = async (pool, baseUrl, table) => {
  const lookup = {
    byId: {},
    byName: {},
  };

  const result = await pool.query(`SELECT id, asset_id, name, image_url FROM ${table}`);

  for (const row of result.rows) {
    const formatted = formatAsset(baseUrl, row);
    const ids = [row.asset_id, row.id].filter(
      (value) => value !== undefined && value !== null && value !== "",
    );

    for (const id of ids) {
      if (!lookup.byId[String(id)]) {
        lookup.byId[String(id)] = {
          ...formatted,
          id: formatted.id || String(id),
        };
      }
    }

    if (formatted.name && !lookup.byName[String(formatted.name).toLowerCase()]) {
      lookup.byName[String(formatted.name).toLowerCase()] = formatted;
    }
  }

  return lookup;
};

const resolveFromLookup = (lookup = {}, asset = {}) =>
  lookup.byId?.[String(asset?.id || "")] ||
  lookup.byName?.[String(asset?.name || "").toLowerCase()] ||
  {};

const normalizeRawPlayerAsset = (rawPayload, key) => {
  const normalized = normalizePlayer(rawPayload || {});
  if (key === "character") return normalized.character;
  if (key === "active_skill") return normalized.activeSkill;
  if (key === "weapon") return normalized.weapon;
  if (key === "pet") return normalized.pet;
  return null;
};

const mergeStoredAsset = (baseUrl, storedRow, fallbackAsset) => {
  const stored = formatAsset(baseUrl, storedRow);
  return {
    id: stored.id || fallbackAsset?.id || "",
    name: stored.name || fallbackAsset?.name || "",
    image: stored.image || formatImageUrl(baseUrl, fallbackAsset?.image || ""),
  };
};

const mergeAnyAsset = (baseUrl, storedRow, fallbackAsset, anyAssetLookup = {}) => {
  const stored = formatAsset(baseUrl, storedRow);
  const crossTable =
    anyAssetLookup.byId?.[String(stored.id || fallbackAsset?.id || "")] ||
    anyAssetLookup.byName?.[String(stored.name || fallbackAsset?.name || "").toLowerCase()] ||
    {};

  return {
    id: stored.id || fallbackAsset?.id || crossTable.id || "",
    name: stored.name || fallbackAsset?.name || crossTable.name || "",
    image:
      stored.image ||
      crossTable.image ||
      formatImageUrl(baseUrl, fallbackAsset?.image || ""),
  };
};

const mergeAssetFromLookup = (baseUrl, storedRow, fallbackAsset, lookup = {}) => {
  const stored = formatAsset(baseUrl, storedRow);
  const resolved =
    resolveFromLookup(lookup, stored) || resolveFromLookup(lookup, fallbackAsset);

  return {
    id: stored.id || fallbackAsset?.id || resolved.id || "",
    name: stored.name || fallbackAsset?.name || resolved.name || "",
    image:
      stored.image ||
      resolved.image ||
      formatImageUrl(baseUrl, fallbackAsset?.image || ""),
  };
};

const mergeStoredAssetList = (
  baseUrl,
  storedRows = [],
  fallbackAssets = [],
  anyAssetLookup = {},
  preferredLookup = {},
) => {
  const byId = {};
  const byName = {};
  for (const row of storedRows) {
    const formatted = formatAsset(baseUrl, row);
    if (formatted.id) byId[formatted.id] = formatted;
    if (formatted.name) byName[String(formatted.name).toLowerCase()] = formatted;
  }

  const merged = fallbackAssets.map((asset) => {
    const stored =
      byId[asset.id] ||
      byName[String(asset.name || "").toLowerCase()] ||
      {};
    const resolved =
      resolveFromLookup(preferredLookup, asset) ||
      anyAssetLookup.byId?.[String(asset.id || "")] ||
      anyAssetLookup.byName?.[String(asset.name || "").toLowerCase()] ||
      {};

    return {
      id: stored.id || asset.id || resolved.id || "",
      name: stored.name || asset.name || resolved.name || "",
      image:
        stored.image ||
        resolved.image ||
        formatImageUrl(baseUrl, asset.image || ""),
    };
  });

  for (const asset of Object.values(byId)) {
    if (!merged.some((item) => String(item.id) === String(asset.id))) {
      merged.push(asset);
    }
  }

  return merged;
};

const loadPlayersForMatchResults = async (pool, matchResultIds, baseUrl) => {
  await ensureMatchMetadataTables(pool);
  if (!matchResultIds.length) return {};

  const result = await pool.query(
    `
    SELECT
      p.*,
      c.asset_id AS character_id,
      c.name AS character_name,
      c.image_url AS character_image,
      COALESCE(a.asset_id, p.active_skill_asset_id) AS active_skill_id,
      a.name AS active_skill_name,
      a.image_url AS active_skill_image,
      w.asset_id AS weapon_id,
      w.name AS weapon_name,
      w.image_url AS weapon_image,
      pet.asset_id AS pet_id,
      pet.name AS pet_name,
      pet.image_url AS pet_image
    FROM match_result_players p
    LEFT JOIN characters c ON c.asset_id = p.character_asset_id
    LEFT JOIN characters a ON a.asset_id = p.active_skill_asset_id
    LEFT JOIN weapons w ON w.asset_id = p.weapon_asset_id
    LEFT JOIN skills pet ON pet.asset_id = p.pet_asset_id
    WHERE p.match_result_id = ANY($1::int[])
    ORDER BY p.match_result_id ASC, p.kills DESC, p.damage DESC, p.assists DESC, p.player_name ASC
    `,
    [matchResultIds],
  );

  const playerIds = result.rows.map((row) => row.id);
  const passiveResult = playerIds.length
    ? await pool.query(
        `
        SELECT
          ps.match_player_id,
          COALESCE(s.asset_id, ps.skill_asset_id) AS asset_id,
          s.name,
          s.image_url,
          ps.slot
        FROM match_player_passive_skills ps
        LEFT JOIN characters s ON s.asset_id = ps.skill_asset_id
        WHERE ps.match_player_id = ANY($1::int[])
        ORDER BY ps.match_player_id ASC, ps.slot ASC
        `,
        [playerIds],
      )
    : { rows: [] };
  const equipmentResult = playerIds.length
    ? await pool.query(
        `
        SELECT el.match_player_id, e.asset_id, e.name, e.image_url, el.slot
        FROM match_player_equipment_loadouts el
        LEFT JOIN equipment e ON e.asset_id = el.equipment_asset_id
        WHERE el.match_player_id = ANY($1::int[])
        ORDER BY el.match_player_id ASC, el.slot ASC
        `,
        [playerIds],
      )
    : { rows: [] };
  const anyAssetLookup = await loadAnyAssetLookup(pool, baseUrl);
  const characterLookup = await loadAssetLookupFromTable(pool, baseUrl, "characters");
  const skillLookup = await loadAssetLookupFromTable(pool, baseUrl, "skills");

  const passiveByPlayer = {};
  for (const row of passiveResult.rows) {
    if (!passiveByPlayer[row.match_player_id]) passiveByPlayer[row.match_player_id] = [];
    passiveByPlayer[row.match_player_id].push(formatAsset(baseUrl, row));
  }

  const equipmentByPlayer = {};
  for (const row of equipmentResult.rows) {
    if (!equipmentByPlayer[row.match_player_id]) equipmentByPlayer[row.match_player_id] = [];
    equipmentByPlayer[row.match_player_id].push(formatAsset(baseUrl, row));
  }

  return result.rows.reduce((acc, row) => {
    if (!acc[row.match_result_id]) acc[row.match_result_id] = [];
    const rawPayload = row.raw_payload || {};
    acc[row.match_result_id].push({
      player_id: row.player_id || "",
      player_name: row.player_name || "",
      player_image: formatImageUrl(baseUrl, row.player_image || ""),
      kills: row.kills,
      damage: row.damage,
      assists: row.assists,
      knockdowns: row.knockdowns,
      survival_time: row.survival_time,
      character: mergeAnyAsset(
        baseUrl,
        {
          asset_id: row.character_id,
          name: row.character_name,
          image_url: row.character_image,
        },
        normalizeRawPlayerAsset(rawPayload, "character"),
        anyAssetLookup,
      ),
      active_skill: mergeAssetFromLookup(
        baseUrl,
        {
          asset_id: row.active_skill_id,
          name: row.active_skill_name,
          image_url: row.active_skill_image,
        },
        normalizeRawPlayerAsset(rawPayload, "active_skill"),
        characterLookup,
      ),
      passive_skills: mergeStoredAssetList(
        baseUrl,
        passiveByPlayer[row.id] || [],
        normalizePlayer(rawPayload).passiveSkills,
        anyAssetLookup,
        characterLookup,
      ).slice(0, 3),
      weapon_used: mergeAnyAsset(
        baseUrl,
        {
          asset_id: row.weapon_id,
          name: row.weapon_name,
          image_url: row.weapon_image,
        },
        normalizeRawPlayerAsset(rawPayload, "weapon"),
        anyAssetLookup,
      ),
      pet: mergeAssetFromLookup(
        baseUrl,
        {
          asset_id: row.pet_id,
          name: row.pet_name,
          image_url: row.pet_image,
        },
        normalizeRawPlayerAsset(rawPayload, "pet"),
        skillLookup,
      ),
      equipment_loadouts: mergeStoredAssetList(
        baseUrl,
        equipmentByPlayer[row.id] || [],
        normalizePlayer(rawPayload).equipmentLoadouts,
        anyAssetLookup,
      ),
    });
    return acc;
  }, {});
};

const buildAssetLookup = async (pool, baseUrl) => {
  const lookup = {};

  for (const [type, defaultTable] of Object.entries(ASSET_TABLES)) {
    const key =
      type === "active_skill" || type === "passive_skill" ? "skill" : type;
    const table =
      type === "active_skill" || type === "passive_skill"
        ? "characters"
        : type === "pet"
          ? "skills"
          : defaultTable;
    if (!lookup[key]) lookup[key] = {};

    const result = await pool.query(
      `SELECT asset_id, name, image_url FROM ${table} WHERE asset_id IS NOT NULL`,
    );

    for (const row of result.rows) {
      lookup[key][row.asset_id] = formatAsset(baseUrl, row);
    }
  }

  return lookup;
};

const formatRealtimePlayer = (player = {}, baseUrl, assetLookup = {}) => {
  const normalized = normalizePlayer(player);
  const assetOrEmpty = (asset, lookupType) => {
    if (!asset) return { id: "", name: "", image: "" };

    const stored = assetLookup[lookupType]?.[asset.id] || {};
    return {
      id: asset.id || stored.id || "",
      name: stored.name || asset.name || "",
      image: stored.image || (asset.image ? formatImageUrl(baseUrl, asset.image) : ""),
    };
  };

  return {
    ...player,
    player_id: normalized.playerId || "",
    player_name: normalized.playerName || "",
    player_image: formatImageUrl(baseUrl, normalized.playerImage || ""),
    kills: normalized.kills,
    damage: normalized.damage,
    assists: normalized.assists,
    knockdowns: normalized.knockdowns,
    survival_time: normalized.survivalTime,
    character: assetOrEmpty(normalized.character, "character"),
    active_skill: assetOrEmpty(normalized.activeSkill, "skill"),
    passive_skills: normalized.passiveSkills.map((skill) =>
      assetOrEmpty(skill, "skill"),
    ),
    weapon_used: assetOrEmpty(normalized.weapon, "weapon"),
    pet: assetOrEmpty(normalized.pet, "pet"),
    equipment_loadouts: normalized.equipmentLoadouts.map((item) =>
      assetOrEmpty(item, "equipment"),
    ),
  };
};

module.exports = {
  buildAssetLookup,
  ensureMatchMetadataTables,
  firstValue,
  formatImageUrl,
  formatRealtimePlayer,
  getPlayersFromTeamPayload,
  loadPlayersForMatchResults,
  normalizePlayer,
  saveMatchPlayers,
  toInteger,
};
const { ensureTournamentColumn } = require("./tournamentContext");
