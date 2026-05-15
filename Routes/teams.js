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

  const index = teams.findIndex(t => t.team_id === team_id);

  const team = { team_id, team_name, logo_url, tag, country };

  if (index !== -1) {
    teams[index] = team;
  } else {
    teams.push(team);
  }

  res.json({ success: true, team });
});

/* edit */
router.put("/team/:team_id", (req, res) => {
  const index = teams.findIndex(t => t.team_id === req.params.team_id);

  if (index === -1) return res.status(404).json({ error: "Not found" });

  teams[index] = { ...teams[index], ...req.body };

  res.json({ success: true, team: teams[index] });
});

/* delete */
router.delete("/team/:team_id", (req, res) => {
  teams = teams.filter(t => t.team_id !== req.params.team_id);

  res.json({ success: true });
});

module.exports = router;