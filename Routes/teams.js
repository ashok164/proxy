const express = require("express");
const router = express.Router();

let teams = [];

/* get */
router.get("/teams", (req, res) => {
  res.json(teams);
});

/* add/update */
router.post("/team", (req, res) => {
  const { team_id, team_name, logo_url, tag, country } = req.body;
  if (!team_id) return res.status(400).json({ error: "team_id parameter is mandatory" });

  const normalizedId = String(team_id);
  const index = teams.findIndex(t => String(t.team_id) === normalizedId);

  const team = { team_id: normalizedId, team_name, logo_url, tag, country };

  if (index !== -1) {
    teams[index] = team;
  } else {
    teams.push(team);
  }

  res.json({ success: true, team });
});

/* edit */
router.put("/team/:team_id", (req, res) => {
  const targetId = String(req.params.team_id);
  const index = teams.findIndex(t => String(t.team_id) === targetId);

  if (index === -1) return res.status(404).json({ error: "Not found" });

  teams[index] = { ...teams[index], ...req.body };

  res.json({ success: true, team: teams[index] });
});

/* delete */
router.delete("/team/:team_id", (req, res) => {
  const targetId = String(req.params.team_id);
  
  teams = teams.filter(t => String(t.team_id) !== targetId);

  res.json({ success: true });
});

module.exports = router;