const crypto = require('crypto');

/**
 * Verifies the X-Hub-Signature-256 header GitHub sends with every webhook
 * delivery. Requires that the route this is mounted on parses the body with
 * express.raw() (NOT express.json()) so we can HMAC the exact bytes GitHub
 * signed — re-serializing a parsed JSON object would produce a different
 * signature and always fail verification.
 */
function verifyWebhook(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    console.error('[webhook] GITHUB_WEBHOOK_SECRET is not set on the server');
    return res.status(500).json({ error: 'Webhook secret not configured on server' });
  }

  if (!signature) {
    return res.status(401).json({ error: 'Missing X-Hub-Signature-256 header' });
  }

  const payload = req.body; // raw Buffer (see express.raw() on the route)
  const expectedSignature =
    'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  const isValid =
    sigBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(sigBuffer, expectedBuffer);

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  try {
    req.parsedBody = JSON.parse(payload.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  next();
}

module.exports = verifyWebhook;
