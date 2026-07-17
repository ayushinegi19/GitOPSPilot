const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const pool = require('../config/db');
const deploymentService = require('./deploymentService');
const healthCheckService = require('./healthCheckService');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'pipeline.config.json');

function execCommand(command) {
  return new Promise((resolve) => {
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (error.code ?? 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

function loadStages() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.stages)) {
    throw new Error('pipeline.config.json must contain a "stages" array');
  }
  return parsed.stages;
}

// Pulls the image:tag token out of a docker build/run command, ignoring
// things like "-p 4000:4000" which also contain a colon but aren't images.
function extractImageTag(command) {
  const tokens = command.split(/\s+/);
  for (const token of tokens) {
    const match = token.match(/^([a-zA-Z0-9_.\-/]+):([a-zA-Z0-9_.\-]+)$/);
    if (match && /[a-zA-Z]/.test(match[1])) {
      return token;
    }
  }
  return 'unknown:latest';
}

async function runPipeline({ triggeredBy = 'manual' } = {}) {
  const stages = loadStages();

  const runResult = await pool.query(
    `insert into pipeline_runs (triggered_by, status, started_at)
     values ($1, 'running', now()) returning id`,
    [triggeredBy]
  );
  const runId = runResult.rows[0].id;

  console.log(`[pipeline] Started run ${runId} (triggered by ${triggeredBy})`);

  let overallStatus = 'success';
  let deployedImageTag = null;

  for (const stage of stages) {
    const { name, command } = stage;

    const stageInsert = await pool.query(
      `insert into pipeline_stages (pipeline_run_id, stage_name, status, started_at)
       values ($1, $2, 'running', now()) returning id`,
      [runId, name]
    );
    const stageId = stageInsert.rows[0].id;

    console.log(`[pipeline] Running stage "${name}": ${command}`);
    const { exitCode, stdout, stderr } = await execCommand(command);
    const stageStatus = exitCode === 0 ? 'success' : 'failed';
    const output = `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`.slice(0, 20000);

    await pool.query(
      `update pipeline_stages set status = $1, output = $2, finished_at = now() where id = $3`,
      [stageStatus, output, stageId]
    );

    console.log(`[pipeline] Stage "${name}" finished with status: ${stageStatus}`);

    if (stageStatus === 'failed') {
      overallStatus = 'failed';
      break;
    }

    if (name === 'deploy') {
      deployedImageTag = extractImageTag(command);
    }
  }

  await pool.query(`update pipeline_runs set status = $1, finished_at = now() where id = $2`, [
    overallStatus,
    runId,
  ]);

  console.log(`[pipeline] Run ${runId} finished with overall status: ${overallStatus}`);

  // Phase 2: a successful deploy stage starts deployment tracking + health monitoring
  if (overallStatus === 'success' && deployedImageTag) {
    const deployment = await deploymentService.recordDeployment(deployedImageTag, 'live');
    console.log(`[pipeline] Recorded deployment ${deployment.id} (${deployedImageTag}) as live`);
    healthCheckService.startMonitoring(deployment.id, deployedImageTag);
  }

  return { runId, status: overallStatus };
}

module.exports = { runPipeline, extractImageTag };
