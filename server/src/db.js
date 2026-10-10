import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

let memoryServer = null;

// npm workspaces hoist dependencies to the repo root, where mongodb-memory-server's
// postinstall caches the mongod binary. Point at it explicitly so the API finds it no
// matter which directory it is started from (otherwise it re-downloads ~600 MB).
const ROOT_BINARY_CACHE = fileURLToPath(new URL('../../node_modules/.cache/mongodb-memory-server', import.meta.url));

/**
 * Connects to MONGO_URI, or starts an in-memory MongoDB when none is configured
 * so reviewers can run the project without installing a database.
 * Returns { uri, inMemory }.
 */
export async function connectDatabase(uri) {
  let target = uri;
  let inMemory = false;

  if (!target) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create(
      existsSync(ROOT_BINARY_CACHE) ? { binary: { downloadDir: ROOT_BINARY_CACHE } } : {},
    );
    target = memoryServer.getUri('smartaudit');
    inMemory = true;
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(target);
  return { uri: target, inMemory };
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
