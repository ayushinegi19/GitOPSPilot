const express = require('express');
const router = express.Router();
const verifyWebhook = require('../middleware/verifyWebhook');
const { runPipeline } = require('../services/pipelineRunner');

// express.raw() here (instead of the global express.json() in server.js)
// so verifyWebhook can HMAC the exact raw bytes GitHub signed.
router.post(
  '/github',
  express.raw({ type: 'application/json', limit: '5mb' }),
  verifyWebhook,
  async (req, res) => {
    const event = req.headers['x-github-event'];
    const body = req.parsedBody;

    if (event !== 'push') {
      return res.status(200).json({ message: `Ignored event type: ${event}` });
    }

    const triggeredBy = body?.pusher?.name || body?.sender?.login || 'unknown';
    const ref = body?.ref || 'unknown-ref';

    console.log(`[webhook] Push event received from "${triggeredBy}" on ${ref}`);

    // Acknowledge immediately — GitHub times out webhook deliveries after ~10s,
    // and a full pipeline run can take much longer than that.
    res.status(202).json({ message: 'Push received, pipeline started', triggeredBy, ref });

    try {
      await runPipeline({ triggeredBy });
    } catch (err) {
      console.error('[webhook] Pipeline run failed unexpectedly:', err);
    }
  }
);

module.exports = router;
