'use strict';

const { createApp } = require('./app');
const service = require('./targetsService');
const config = require('./config');
const logger = require('./logger');

async function main() {
  if (config.supabase.partial) {
    throw new Error('Set all of SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY, or none of them');
  }

  await service.init();
  const app = createApp();

  const server = app.listen(config.port, config.host, () => {
    logger.info(`URL pinger listening on http://${config.host}:${config.port}`);
    if (!config.supabase.enabled && !config.isLoopback) {
      logger.warn(`HOST=${config.host} exposes an unauthenticated request engine beyond this machine.`);
    }
    if (config.supabase.enabled && !config.cookieSecure) {
      logger.warn('COOKIE_SECURE=false: session cookies are sent over plain http.');
    }
    if (config.allowPrivateTargets) {
      logger.warn('ALLOW_PRIVATE_TARGETS=true — internal and metadata addresses are reachable (SSRF risk).');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${config.port} on ${config.host} is already in use. Stop the other process or set PORT.`);
    } else {
      logger.error('Server error', err);
    }
    service.shutdown();
    process.exit(1);
  });

  const shutdown = (signal) => {
    logger.info(`Received ${signal}, shutting down`);
    service.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Failed to start server', err);
  process.exit(1);
});
