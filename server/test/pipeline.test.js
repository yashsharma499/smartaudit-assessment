import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../src/db.js';
import { buildContainer } from '../src/container.js';
import { AuditEntry } from '../src/models/AuditEntry.js';
import { AuditRepository } from '../src/repositories/AuditRepository.js';
import { SEED_ENTRIES } from '../src/seedData.js';

const testConfig = {
  defaultTenantId: '66a0c0ffee0000000000a001',
  ai: { mock: true, mockDelayMs: 50 },
  worker: { pollMs: 50, concurrency: 2, lockTtlMs: 30000, maxAttempts: 3 },
};
const silent = { info() {}, warn() {}, error() {} };

let ctx;
let api;

before(async () => {
  await connectDatabase(''); // in-memory MongoDB
  await AuditEntry.init(); // build indexes
});
after(async () => {
  await disconnectDatabase();
});
beforeEach(async () => {
  if (ctx?.worker) await ctx.worker.stop();
  await AuditEntry.deleteMany({});
  ctx = buildContainer(testConfig, { logger: silent });
  api = request(ctx.app);
});

const sample = (i = 0) => ({ ...SEED_ENTRIES[i] });
const waitFor = async (fn, timeoutMs = 5000) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const statusOf = async (id) => (await AuditEntry.findById(id).lean()).aiMetadata;

test('Scenario A: POST saves PENDING immediately, worker enriches to COMPLETED', async () => {
  const res = await api.post('/api/audit-entries').send(sample(0)).expect(202);
  assert.equal(res.body.aiMetadata.status, 'PENDING');
  assert.equal(res.body.aiMetadata.riskScore, null);

  ctx.worker.start();
  const ai = await waitFor(async () => {
    const m = await statusOf(res.body._id);
    return m.status === 'COMPLETED' && m;
  });
  assert.equal(ai.riskLevel, 'HIGH');
  assert.equal(ai.semanticVector.length, 8);
  assert.ok(ai.anomalyFlags.includes('MONETARY_THRESHOLD_EXCEEDED'));
  assert.ok(ai.aiSummary.length > 20);

  // Baseline evidence untouched by the AI write.
  const doc = await AuditEntry.findById(res.body._id).lean();
  assert.equal(doc.description, sample(0).description);
  assert.equal(doc.monetaryImpact, sample(0).monetaryImpact);
});

test('Scenario B: notes-only edit fast-tracks (no status/version change, no AI run)', async () => {
  const { body } = await api.post('/api/audit-entries').send(sample(0)).expect(202);
  ctx.worker.start();
  await waitFor(async () => (await statusOf(body._id)).status === 'COMPLETED');
  const before = await statusOf(body._id);

  let aiRuns = 0;
  ctx.worker.on('completed', () => { aiRuns += 1; });

  const res = await api.put(`/api/audit-entries/${body._id}`).send({ auditorNotes: 'Reviewed with AP lead' }).expect(200);
  assert.equal(res.body.path, 'FAST_TRACK');
  assert.equal(res.body.aiRecomputation, false);
  assert.equal(res.body.entry.aiMetadata.status, 'COMPLETED');
  assert.equal(res.body.entry.aiMetadata.version, before.version);
  assert.equal(res.body.entry.aiMetadata.processedAt.toString(), before.processedAt.toISOString());

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(aiRuns, 0);
});

test('Scenario B: core edit re-queues, bumps version and recomputes', async () => {
  const { body } = await api.post('/api/audit-entries').send(sample(4)).expect(202); // low-value journal
  ctx.worker.start();
  const first = await waitFor(async () => {
    const m = await statusOf(body._id);
    return m.status === 'COMPLETED' && m;
  });

  const res = await api.put(`/api/audit-entries/${body._id}`).send({ monetaryImpact: 400000, description: 'Manual override of accrual journal' }).expect(200);
  assert.equal(res.body.path, 'AI_REQUEUE');
  assert.equal(res.body.entry.aiMetadata.version, first.version + 1);

  const second = await waitFor(async () => {
    const m = await statusOf(body._id);
    return m.status === 'COMPLETED' && m.version === first.version + 1 && m;
  });
  assert.ok(second.riskScore > first.riskScore);
  assert.ok(second.anomalyFlags.includes('MANUAL_OVERRIDE'));
});

test('Concurrency: a stale AI result is discarded when a core edit lands mid-processing', async () => {
  const repo = new AuditRepository();
  const { body } = await api.post('/api/audit-entries').send(sample(0)).expect(202);

  const claimed = await repo.claimNextPending({ lockTtlMs: 30000 }); // worker picked it up (v0)
  assert.equal(claimed.aiMetadata.status, 'PROCESSING');

  await api.put(`/api/audit-entries/${body._id}`).send({ monetaryImpact: 1000 }).expect(200); // edit -> v1

  const applied = await repo.completeEnrichment(claimed._id, claimed.aiMetadata.version, {
    riskScore: 99, riskLevel: 'HIGH', aiSummary: 'stale', anomalyFlags: [], semanticVector: [1, 0, 0, 0, 0, 0, 0, 0], provider: 'mock', vectorModel: 'x',
  });
  assert.equal(applied, false);
  const m = await statusOf(body._id);
  assert.equal(m.status, 'PENDING');
  assert.equal(m.version, 1);
  assert.notEqual(m.aiSummary, 'stale');
});

test('Concurrency: auditor notes written during AI processing are not overwritten', async () => {
  const repo = new AuditRepository();
  const { body } = await api.post('/api/audit-entries').send(sample(0)).expect(202);
  const claimed = await repo.claimNextPending({ lockTtlMs: 30000 });

  await api.put(`/api/audit-entries/${body._id}`).send({ auditorNotes: 'note during processing' }).expect(200);

  const applied = await repo.completeEnrichment(claimed._id, claimed.aiMetadata.version, {
    riskScore: 80, riskLevel: 'HIGH', aiSummary: 'ok', anomalyFlags: [], semanticVector: [1, 0, 0, 0, 0, 0, 0, 0], provider: 'mock', vectorModel: 'x',
  });
  assert.equal(applied, true); // notes don't bump the version, so the AI result is still valid
  const m = await statusOf(body._id);
  assert.equal(m.auditorNotes, 'note during processing');
  assert.equal(m.status, 'COMPLETED');
});

test('Concurrency: parallel claims never hand the same job to two workers', async () => {
  const repo = new AuditRepository();
  await repo.insertMany(SEED_ENTRIES);
  const claims = await Promise.all(Array.from({ length: 8 }, () => repo.claimNextPending({ lockTtlMs: 30000 })));
  const ids = claims.filter(Boolean).map((c) => String(c._id));
  assert.equal(ids.length, SEED_ENTRIES.length);
  assert.equal(new Set(ids).size, ids.length);
});

test('Crash recovery: an expired PROCESSING lock is reclaimed', async () => {
  const repo = new AuditRepository();
  await repo.insertMany([SEED_ENTRIES[0]]);
  const first = await repo.claimNextPending({ lockTtlMs: 30000 });
  assert.equal(await repo.claimNextPending({ lockTtlMs: 30000 }), null); // still locked
  const reclaimed = await repo.claimNextPending({ lockTtlMs: -1 }); // lock considered expired
  assert.equal(String(reclaimed._id), String(first._id));
  assert.equal(reclaimed.aiMetadata.attempts, 2);
});

test('Failures retry with backoff, then mark FAILED', async () => {
  const failingAI = { mode: 'failing', enrich: async () => { throw new Error('LLM down'); } };
  ctx = buildContainer({ ...testConfig, worker: { ...testConfig.worker, maxAttempts: 2 } }, { logger: silent, aiService: failingAI });
  api = request(ctx.app);
  const { body } = await api.post('/api/audit-entries').send(sample(0)).expect(202);

  ctx.worker.start();
  await once(ctx.worker, 'retry');
  const mid = await statusOf(body._id);
  assert.equal(mid.status, 'PENDING');
  assert.ok(mid.nextAttemptAt > new Date());

  await AuditEntry.updateOne({ _id: body._id }, { $set: { 'aiMetadata.nextAttemptAt': new Date(0) } }); // skip the wait
  ctx.worker.notify();
  await once(ctx.worker, 'failed');
  const end = await statusOf(body._id);
  assert.equal(end.status, 'FAILED');
  assert.match(end.lastError, /LLM down/);
});

test('Scenario C: /similar returns top 3 of the same tenant, most similar first', async () => {
  for (const e of SEED_ENTRIES) await api.post('/api/audit-entries').send(e).expect(202);
  await api.post('/api/audit-entries').set('x-tenant-id', '66a0c0ffee0000000000b002').send({ ...SEED_ENTRIES[1], evidenceId: 'OTHER-TENANT' }).expect(202);
  ctx.worker.start();
  await waitFor(async () => (await AuditEntry.countDocuments({ 'aiMetadata.status': 'COMPLETED' })) === SEED_ENTRIES.length + 1);

  const target = await AuditEntry.findOne({ evidenceId: 'EVID-902188' }).lean();
  const res = await api.post(`/api/audit-entries/${target._id}/similar`).expect(200);
  assert.equal(res.body.results.length, 3);
  assert.equal(res.body.results[0].evidenceId, 'EVID-902245'); // the other vendor-override record
  assert.ok(res.body.results.every((r) => r.evidenceId !== 'OTHER-TENANT'));
  assert.ok(res.body.results[0].similarity >= res.body.results[1].similarity);
});

test('Validation: bad ids, unknown fields and missing fields are rejected', async () => {
  await api.put('/api/audit-entries/not-an-id').send({ auditorNotes: 'x' }).expect(400);
  const { body } = await api.post('/api/audit-entries').send(sample(0)).expect(202);
  await api.put(`/api/audit-entries/${body._id}`).send({ evidenceId: 'HACK' }).expect(400);
  await api.post('/api/audit-entries').send({ entityName: 'x' }).expect(400);
  await api.post('/api/audit-entries').send(sample(0)).expect(409); // duplicate evidenceId
  await api.post(`/api/audit-entries/${body._id}/similar`).expect(409); // not enriched yet
});
