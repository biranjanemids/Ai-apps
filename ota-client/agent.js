'use strict';
const os = require('os');
const { loadConfig, saveConfig, ensureDirs } = require('./src/config');
const { getLogger } = require('./src/logger');
const { UpdatePoller } = require('./src/poller');

async function main() {
  const config = loadConfig();
  ensureDirs(config);

  const logger = getLogger(config.agent.logFile);
  logger.info(`OTA Agent starting on ${os.hostname()} (platform: ${process.platform})`);

  const poller = new UpdatePoller(config, logger, saveConfig);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutdown signal received');
    poller.stop();
    setTimeout(() => process.exit(0), 1000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await poller.start();
    logger.info(`Polling every ${config.agent.pollIntervalMs / 1000}s`);
  } catch (err) {
    logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
  }
}

main();
