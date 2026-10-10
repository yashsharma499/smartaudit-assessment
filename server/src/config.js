const bool = (v, fallback) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const int = (v, fallback) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : fallback);

export const config = Object.freeze({
  port: int(process.env.PORT, 4000),
  mongoUri: process.env.MONGO_URI || '',

  ai: {
    // MOCK_AI defaults to true when no key is configured, so the project always runs offline.
    mock: bool(process.env.MOCK_AI, !process.env.OPENAI_API_KEY),
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    maxRpm: int(process.env.AI_MAX_RPM, 60),
    mockDelayMs: int(process.env.MOCK_AI_DELAY_MS, 400),
    requestTimeoutMs: int(process.env.AI_TIMEOUT_MS, 20000),
  },

  worker: {
    pollMs: int(process.env.WORKER_POLL_MS, 1000),
    concurrency: int(process.env.WORKER_CONCURRENCY, 2),
    lockTtlMs: int(process.env.WORKER_LOCK_TTL_MS, 30000),
    maxAttempts: int(process.env.WORKER_MAX_ATTEMPTS, 3),
  },

  // Single demo tenant used by the seed data and the dashboard.
  defaultTenantId: process.env.DEFAULT_TENANT_ID || '66a0c0ffee0000000000a001',
});
