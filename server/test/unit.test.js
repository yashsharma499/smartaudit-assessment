import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashEmbedding, cosineSimilarity, topKSimilar } from '../src/lib/vector.js';
import { evaluateDelta, parseUpdatePayload, UPDATE_PATH } from '../src/lib/delta.js';
import { MockAIEngine, riskLevelFor } from '../src/services/MockAIEngine.js';
import { AIService } from '../src/services/AIService.js';

const current = {
  monetaryImpact: 85000,
  description: 'Manual approval override executed for vendor invoice payables',
  controlId: 'CTRL-FIN-302',
  aiMetadata: { auditorNotes: 'checked' },
};

test('hash embedding is 8-dimensional, unit length and deterministic', () => {
  const v = hashEmbedding('Manual approval override for vendor invoice');
  assert.equal(v.length, 8);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-3);
  assert.deepEqual(v, hashEmbedding('Manual approval override for vendor invoice'));
});

test('similar descriptions score higher than unrelated ones', () => {
  const a = hashEmbedding('Manual approval override executed for vendor invoice payables exceeding threshold');
  const b = hashEmbedding('Vendor invoice approval override by manual exception for payables');
  const c = hashEmbedding('Quarterly user access review completed for ERP finance module');
  assert.ok(cosineSimilarity(a, b) > cosineSimilarity(a, c));
});

test('topKSimilar returns k best in descending order', () => {
  const target = [1, 0, 0, 0, 0, 0, 0, 0];
  const items = [0.1, 0.9, 0.5, 0.7].map((x, i) => ({ id: i, vector: [x, 1 - x, 0, 0, 0, 0, 0, 0] }));
  const top = topKSimilar(target, items, 3);
  assert.deepEqual(top.map((t) => t.item.id), [1, 3, 2]);
});

test('delta: notes-only edit takes the fast track', () => {
  const d = evaluateDelta(current, parseUpdatePayload({ auditorNotes: 'escalated to CFO' }));
  assert.equal(d.path, UPDATE_PATH.FAST_TRACK);
  assert.deepEqual(d.changedFields, ['auditorNotes']);
});

test('delta: changed amount re-queues AI', () => {
  const d = evaluateDelta(current, parseUpdatePayload({ monetaryImpact: 90000 }));
  assert.equal(d.path, UPDATE_PATH.AI_REQUEUE);
  assert.deepEqual(d.coreChanges, { monetaryImpact: 90000 });
});

test('delta: re-sending identical core values (string number, extra spaces) is NOT a change', () => {
  const d = evaluateDelta(current, parseUpdatePayload({
    monetaryImpact: '85000',
    description: `  ${current.description}  `,
    controlId: 'CTRL-FIN-302',
    auditorNotes: 'new note',
  }));
  assert.equal(d.path, UPDATE_PATH.FAST_TRACK); // only the note really changed
});

test('delta: nothing changed means no write', () => {
  const d = evaluateDelta(current, parseUpdatePayload({ auditorNotes: 'checked' }));
  assert.equal(d.path, UPDATE_PATH.NO_CHANGE);
});

test('payload: AI output and baseline evidence are not editable', () => {
  assert.throws(() => parseUpdatePayload({ evidenceId: 'X' }), /not editable/);
  assert.throws(() => parseUpdatePayload({ aiMetadata: { riskScore: 1 } }), /system-managed/);
  assert.equal(parseUpdatePayload({ aiMetadata: { auditorNotes: 'n' } }).auditorNotes, 'n');
});

test('mock engine scores a manual override above threshold as HIGH with flags', async () => {
  const engine = new MockAIEngine({ delayMs: 0 });
  const out = await engine.assess({ ...current, eventType: 'Control Execution', entityName: 'Global Procurement' });
  assert.equal(out.riskLevel, 'HIGH');
  assert.ok(out.anomalyFlags.includes('MONETARY_THRESHOLD_EXCEEDED'));
  assert.ok(out.anomalyFlags.includes('MANUAL_OVERRIDE'));
  assert.match(out.aiSummary, /HIGH risk/);
});

test('mock engine: routine low-value entry is LOW', async () => {
  const out = await new MockAIEngine({ delayMs: 0 }).assess({
    monetaryImpact: 1200, description: 'Routine stationery purchase order', controlId: 'CTRL-OPS-001', eventType: 'Purchase', entityName: 'Office',
  });
  assert.equal(out.riskLevel, 'LOW');
});

test('LLM output validation clamps score, derives level, whitelists flags', () => {
  const v = AIService.validate({ riskScore: 140, aiSummary: '  Risky.  ', anomalyFlags: ['manual_override', 'MADE_UP_FLAG'] });
  assert.equal(v.riskScore, 100);
  assert.equal(v.riskLevel, riskLevelFor(100));
  assert.deepEqual(v.anomalyFlags, ['MANUAL_OVERRIDE']);
  assert.equal(v.aiSummary, 'Risky.');
  assert.throws(() => AIService.validate({ aiSummary: 'x' }), /riskScore/);
});
