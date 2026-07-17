require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const webhookRouter = require('./routes/webhook');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));

// Mounted BEFORE the global JSON parser below, because this router needs the
// raw request body (express.raw()) to verify GitHub's HMAC signature.
app.use('/webhook', webhookRouter);

app.use(express.json());

// Also doubles as the default HEALTH_CHECK_URL target for local testing.
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'gitopspilot', time: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`GitOpsPilot backend listening on port ${PORT}`);
});
