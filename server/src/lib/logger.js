import pino from 'pino';

// LOG_TO_STDERR is set by the MCP stdio process: stdout there is the protocol channel and must stay clean.
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    redact: { paths: ['req.headers.authorization', 'req.headers["x-admin-key"]', '*.apiKey', '*.plaintext'], censor: '[redacted]' },
  },
  process.env.LOG_TO_STDERR ? pino.destination(2) : undefined,
);
