import { config } from './config.js';
import { connectDatabase, disconnectDatabase } from './db.js';
import { buildContainer } from './container.js';
import { SEED_ENTRIES } from './seedData.js';

async function main() {
  const { inMemory } = await connectDatabase(config.mongoUri);
  console.log(`[db] connected (${inMemory ? 'in-memory MongoDB, data resets on restart' : 'MONGO_URI'})`);

  const { app, worker, repository, aiService } = buildContainer(config);

  // In-memory mode has no persisted data, so seed it automatically for a ready-to-use demo.
  if (inMemory && (await repository.count()) === 0) {
    await repository.insertMany(SEED_ENTRIES);
    console.log(`[seed] inserted ${SEED_ENTRIES.length} sample entries (in-memory mode)`);
  }

  const server = app.listen(config.port, () => {
    console.log(`[api] http://localhost:${config.port}  (AI engine: ${aiService.mode})`);
  });
  worker.start();

  const shutdown = async (signal) => {
    console.log(`\n[api] ${signal} received, shutting down`);
    server.close();
    await worker.stop();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
