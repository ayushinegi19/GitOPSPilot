const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const deploymentService = require('./deploymentService');

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

function getDeployCommandTemplate() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const { stages } = JSON.parse(raw);
  const deployStage = stages.find((s) => s.name === 'deploy');
  if (!deployStage) throw new Error('No "deploy" stage found in pipeline.config.json');
  return deployStage.command;
}

function getContainerName(command) {
  const match = command.match(/--name\s+(\S+)/);
  return match ? match[1] : null;
}

// Swaps out the image:tag token in a docker command for a different one,
// leaving flags like "-p 4000:4000" untouched.
function swapImageTag(command, newImageTag) {
  const tokens = command.split(/\s+/);
  const swapped = tokens.map((token) => {
    const isImageToken =
      /^[a-zA-Z0-9_.\-/]+:[a-zA-Z0-9_.\-]+$/.test(token) && /[a-zA-Z]/.test(token.split(':')[0]);
    return isImageToken ? newImageTag : token;
  });
  return swapped.join(' ');
}

/**
 * Given a deployment that just failed its health checks, finds the last
 * known-good deployment and re-deploys that exact image, recording every
 * step so the decision can be explained after the fact.
 */
async function triggerRollback(deploymentId, reason) {
  console.log(`[rollback] Triggered for deployment ${deploymentId}`);
  console.log(`[rollback] Reason: ${reason}`);

  await deploymentService.markDeploymentStatus(deploymentId, 'failed', reason);

  const lastGood = await deploymentService.getLastGoodDeployment(deploymentId);

  if (!lastGood) {
    console.error('[rollback] No previous known-good deployment found — cannot auto-rollback');
    return null;
  }

  console.log(`[rollback] Rolling back to last known-good image: ${lastGood.image_tag}`);

  const deployTemplate = getDeployCommandTemplate();
  const containerName = getContainerName(deployTemplate);

  if (containerName) {
    await execCommand(`docker stop ${containerName}`);
    await execCommand(`docker rm ${containerName}`);
  }

  const rollbackCommand = swapImageTag(deployTemplate, lastGood.image_tag);
  console.log(`[rollback] Running: ${rollbackCommand}`);
  const { exitCode, stderr } = await execCommand(rollbackCommand);

  if (exitCode !== 0) {
    console.error(`[rollback] Rollback deploy command failed: ${stderr}`);
    await deploymentService.recordDeployment(lastGood.image_tag, 'failed');
    return null;
  }

  const restored = await deploymentService.recordDeployment(lastGood.image_tag, 'live');
  console.log(`[rollback] Successfully rolled back to ${lastGood.image_tag} (new deployment ${restored.id})`);

  // Resume monitoring the restored deployment. Required lazily to avoid a
  // require() cycle with healthCheckService.
  const healthCheckService = require('./healthCheckService');
  healthCheckService.startMonitoring(restored.id, lastGood.image_tag);

  return restored;
}

module.exports = { triggerRollback };
