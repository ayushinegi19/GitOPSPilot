const pool = require('../config/db');

async function recordDeployment(imageTag, status = 'live') {
  const result = await pool.query(
    `insert into deployments (image_tag, status, deployed_at)
     values ($1, $2, now()) returning *`,
    [imageTag, status]
  );
  return result.rows[0];
}

// Returns the most recent deployment still marked "live", optionally
// excluding one deployment id (used during rollback so we don't pick the
// very deployment that just failed).
async function getLastGoodDeployment(excludeId = null) {
  const query = excludeId
    ? `select * from deployments where status = 'live' and id != $1 order by deployed_at desc limit 1`
    : `select * from deployments where status = 'live' order by deployed_at desc limit 1`;
  const params = excludeId ? [excludeId] : [];
  const result = await pool.query(query, params);
  return result.rows[0] || null;
}

async function markDeploymentStatus(id, status, reason = null) {
  const result = await pool.query(
    `update deployments set status = $1, rollback_reason = $2 where id = $3 returning *`,
    [status, reason, id]
  );
  return result.rows[0];
}

module.exports = { recordDeployment, getLastGoodDeployment, markDeploymentStatus };
