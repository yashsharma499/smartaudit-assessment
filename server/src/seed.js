import { config } from './config.js';
import { SEED_ENTRIES } from './seedData.js';

/**
 * npm run seed
 *  - With MONGO_URI: resets the demo tenant's entries directly in the database (all PENDING;
 *    the worker enriches them as soon as the API is running).
 *  - Without MONGO_URI (in-memory mode): the database lives inside the API process, so this
 *    posts the samples to the running API instead (start it first with `npm run dev`).
 */
async function seedDatabase() {
  const { connectDatabase, disconnectDatabase } = await import('./db.js');
  const { AuditRepository } = await import('./repositories/AuditRepository.js');
  await connectDatabase(config.mongoUri);
  const repo = new AuditRepository();
  const { deletedCount } = await repo.deleteAllForTenant(config.defaultTenantId);
  await repo.insertMany(SEED_ENTRIES);
  console.log(`[seed] removed ${deletedCount}, inserted ${SEED_ENTRIES.length} entries (status PENDING) for tenant ${config.defaultTenantId}`);
  await disconnectDatabase();
}

async function seedViaApi() {
  const base = `http://localhost:${config.port}/api/audit-entries`;
  let created = 0;
  for (const entry of SEED_ENTRIES) {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Fresh evidence IDs so re-running the seed against the live API doesn't collide.
      body: JSON.stringify({ ...entry, evidenceId: `${entry.evidenceId}-${Date.now().toString().slice(-4)}` }),
    }).catch(() => null);
    if (!res) {
      console.error('[seed] API not reachable. In in-memory mode run `npm run dev` first (it also auto-seeds), or set MONGO_URI.');
      process.exit(1);
    }
    if (res.ok) created += 1;
    else console.error(`[seed] ${entry.evidenceId}: ${res.status} ${await res.text()}`);
  }
  console.log(`[seed] posted ${created} entries to ${base}`);
}

(config.mongoUri ? seedDatabase() : seedViaApi()).catch((err) => {
  console.error('[seed] failed:', err.message);
  process.exit(1);
});
