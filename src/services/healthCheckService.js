const fetch = require('node-fetch');

// deploymentId -> { intervalHandle, checks: [{ timestamp, success, responseTimeMs }] }
const activeMonitors = new Map();

function getEnvNumber(name, fallback) {
  const val = process.env[name];
  return val ? Number(val) : fallback;
}

function startMonitoring(deploymentId, imageTag) {
  const healthUrl = process.env.HEALTH_CHECK_URL;
  if (!healthUrl) {
    console.warn('[health-check] HEALTH_CHECK_URL not set — skipping monitoring for this deployment');
    return;
  }

  // Don't double-monitor the same deployment
  stopMonitoring(deploymentId);

  const intervalSeconds = getEnvNumber('HEALTH_CHECK_INTERVAL_SECONDS', 10);
  const windowSeconds = getEnvNumber('HEALTH_CHECK_WINDOW_SECONDS', 180);
  const failureThreshold = getEnvNumber('HEALTH_CHECK_FAILURE_THRESHOLD', 3);
  const policy = process.env.ROLLBACK_POLICY || 'consecutive_failures';
  const errorRateThreshold = getEnvNumber('ROLLBACK_ERROR_RATE_THRESHOLD', 50); // percent
  const latencyThresholdMs = getEnvNumber('ROLLBACK_LATENCY_THRESHOLD_MS', 2000);

  console.log(
    `[health-check] Monitoring deployment ${deploymentId} (${imageTag}) — policy: ${policy}, every ${intervalSeconds}s`
  );

  const state = { checks: [] };

  const intervalHandle = setInterval(async () => {
    const startedAt = Date.now();
    let success = false;
    let responseTimeMs = null;

    try {
      const response = await fetch(healthUrl, { timeout: 5000 });
      responseTimeMs = Date.now() - startedAt;
      success = response.ok;
    } catch (err) {
      responseTimeMs = Date.now() - startedAt;
      success = false;
    }

    state.checks.push({ timestamp: Date.now(), success, responseTimeMs });

    // Keep only checks inside the sliding window
    const cutoff = Date.now() - windowSeconds * 1000;
    state.checks = state.checks.filter((c) => c.timestamp >= cutoff);

    console.log(
      `[health-check] deployment ${deploymentId}: ${success ? 'OK' : 'FAIL'} (${responseTimeMs}ms)`
    );

    const trigger = evaluatePolicy(policy, state.checks, {
      failureThreshold,
      windowSeconds,
      errorRateThreshold,
      latencyThresholdMs,
    });

    if (trigger) {
      console.log(`[health-check] Rollback trigger fired for deployment ${deploymentId}: ${trigger}`);
      stopMonitoring(deploymentId);
      try {
        // Required lazily to avoid a require() cycle: rollbackService also
        // calls back into startMonitoring() once the rollback deploy succeeds.
        const rollbackService = require('./rollbackService');
        await rollbackService.triggerRollback(deploymentId, trigger);
      } catch (err) {
        console.error('[health-check] Rollback attempt failed:', err);
      }
    }
  }, intervalSeconds * 1000);

  activeMonitors.set(deploymentId, { intervalHandle, state });
}

function stopMonitoring(deploymentId) {
  const monitor = activeMonitors.get(deploymentId);
  if (monitor) {
    clearInterval(monitor.intervalHandle);
    activeMonitors.delete(deploymentId);
  }
}

/**
 * Returns a human-readable trigger reason string if the policy's condition
 * is met, or null if everything still looks healthy.
 */
function evaluatePolicy(policy, checks, opts) {
  if (checks.length === 0) return null;

  if (policy === 'consecutive_failures') {
    let consecutive = 0;
    for (let i = checks.length - 1; i >= 0; i--) {
      if (!checks[i].success) consecutive++;
      else break;
    }
    if (consecutive >= opts.failureThreshold) {
      return `${consecutive} consecutive checks failed — exceeds consecutive_failures threshold of ${opts.failureThreshold}`;
    }
    return null;
  }

  if (policy === 'error_rate') {
    const failedCount = checks.filter((c) => !c.success).length;
    const errorRate = (failedCount / checks.length) * 100;
    if (errorRate > opts.errorRateThreshold) {
      return `${failedCount} of ${checks.length} checks failed within ${opts.windowSeconds}s window (${errorRate.toFixed(
        1
      )}%) — exceeds error_rate threshold of ${opts.errorRateThreshold}%`;
    }
    return null;
  }

  if (policy === 'latency_spike') {
    const timed = checks.filter((c) => c.responseTimeMs !== null);
    if (timed.length === 0) return null;
    const avgLatency = timed.reduce((sum, c) => sum + c.responseTimeMs, 0) / timed.length;
    if (avgLatency > opts.latencyThresholdMs) {
      return `Average response time ${avgLatency.toFixed(0)}ms over ${timed.length} checks in the last ${
        opts.windowSeconds
      }s — exceeds latency_spike threshold of ${opts.latencyThresholdMs}ms`;
    }
    return null;
  }

  console.warn(`[health-check] Unknown ROLLBACK_POLICY "${policy}" — no rollback will ever trigger`);
  return null;
}

module.exports = { startMonitoring, stopMonitoring };
