'use strict';

const { createApp } = require('./app');
const service = require('./targetsService');
const config = require('./config');
const logger = require('./logger');

async function main() {
  await service.init();
  const app = createApp();

  const server = app.listen(config.port, config.host, () => {
    logger.info(`URL pinger listening on http://${config.host}:${config.port}`);
    if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
      logger.warn(`HOST=${config.host} exposes an unauthenticated request engine beyond this machine.`);
    }
    if (config.allowPrivateTargets) {
      logger.warn('ALLOW_PRIVATE_TARGETS=true — internal and metadata addresses are reachable (SSRF risk).');
    }
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
