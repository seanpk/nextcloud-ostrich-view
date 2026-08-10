/**
 * Process entry point: load config, build the app, listen.
 * Everything interesting lives in server.js so tests can boot the app without
 * binding a well-known port.
 */
import { buildApp } from './server.js';
import { loadConfig, ConfigError } from './config.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\nConfiguration problem:\n\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const app = await buildApp({
    config,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Query strings can carry file names; keep them out of the logs.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
