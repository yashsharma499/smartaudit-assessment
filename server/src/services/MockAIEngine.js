import { hashEmbedding, HASH_VECTOR_MODEL } from '../lib/vector.js';

export const ANOMALY_FLAGS = Object.freeze({
  MONETARY_THRESHOLD_EXCEEDED: 'MONETARY_THRESHOLD_EXCEEDED',
  HIGH_VALUE_TRANSACTION: 'HIGH_VALUE_TRANSACTION',
  MANUAL_OVERRIDE: 'MANUAL_OVERRIDE',
  UNUSUAL_DESCRIPTION_PATTERN: 'UNUSUAL_DESCRIPTION_PATTERN',
  SEGREGATION_OF_DUTIES_RISK: 'SEGREGATION_OF_DUTIES_RISK',
  ROUND_AMOUNT: 'ROUND_AMOUNT',
  FINANCIAL_CONTROL: 'FINANCIAL_CONTROL',
});

export const ALLOWED_FLAGS = new Set(Object.values(ANOMALY_FLAGS));

export const APPROVAL_THRESHOLD = 50000;
const HIGH_VALUE_THRESHOLD = 250000;

const RULES = [
  {
    flag: ANOMALY_FLAGS.MONETARY_THRESHOLD_EXCEEDED,
    weight: 30,
    test: (e) => e.monetaryImpact > APPROVAL_THRESHOLD,
    reason: (e) => `$${e.monetaryImpact.toLocaleString('en-US')} exceeds the $50k approval threshold`,
  },
  {
    flag: ANOMALY_FLAGS.HIGH_VALUE_TRANSACTION,
    weight: 15,
    test: (e) => e.monetaryImpact >= HIGH_VALUE_THRESHOLD,
    reason: () => 'the amount is in the high-value band',
  },
  {
    flag: ANOMALY_FLAGS.MANUAL_OVERRIDE,
    weight: 25,
    test: (e) => /\b(override|overrid(den|e)|manual(ly)?|bypass(ed)?|force[d]?)\b/i.test(e.description),
    reason: () => 'a standard control was manually overridden or bypassed',
  },
  {
    flag: ANOMALY_FLAGS.UNUSUAL_DESCRIPTION_PATTERN,
    weight: 15,
    test: (e) => /\b(urgent|exception|backdat(ed|ing)|split|duplicate|after[- ]hours|weekend|unapproved|off[- ]cycle)\b/i.test(e.description),
    reason: () => 'the description contains wording typical of control exceptions',
  },
  {
    flag: ANOMALY_FLAGS.SEGREGATION_OF_DUTIES_RISK,
    weight: 20,
    test: (e) => /\b(self[- ]approv(ed|al)|same user|own (request|invoice)|sole approver)\b/i.test(e.description),
    reason: () => 'the same person appears to have requested and approved',
  },
  {
    flag: ANOMALY_FLAGS.ROUND_AMOUNT,
    weight: 5,
    test: (e) => e.monetaryImpact >= 10000 && e.monetaryImpact % 5000 === 0,
    reason: () => 'the amount is a suspiciously round figure',
  },
  {
    flag: ANOMALY_FLAGS.FINANCIAL_CONTROL,
    weight: 10,
    test: (e) => /^CTRL-FIN/i.test(e.controlId),
    reason: () => 'it falls under a financial control',
  },
];

export function riskLevelFor(score) {
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Local, deterministic "AI" evaluator. Same input, same output, which makes the demo
 * and tests reproducible and lets the project run with no API key.
 * Rule weights are additive (base 5), capped at 100.
 */
export class MockAIEngine {
  constructor({ delayMs = 400 } = {}) {
    this.delayMs = delayMs;
    this.name = 'mock';
  }

  async assess(entry) {
    if (this.delayMs > 0) await sleep(this.delayMs); // simulated model latency, per the brief

    const hits = RULES.filter((r) => r.test(entry));
    const riskScore = Math.min(100, 5 + hits.reduce((s, r) => s + r.weight, 0));
    const riskLevel = riskLevelFor(riskScore);
    const anomalyFlags = hits.map((r) => r.flag);

    return {
      riskScore,
      riskLevel,
      anomalyFlags,
      aiSummary: MockAIEngine.summarize(entry, riskLevel, hits),
    };
  }

  embed(text) {
    return { vector: hashEmbedding(text), model: HASH_VECTOR_MODEL };
  }

  static summarize(entry, riskLevel, hits) {
    const amount = `$${Number(entry.monetaryImpact).toLocaleString('en-US')}`;
    if (hits.length === 0) {
      return `${entry.eventType} for ${entry.entityName} (${amount}) shows no anomaly signals; routine control execution with low audit risk.`;
    }
    const reasons = hits.slice(0, 3).map((h) => h.reason(entry));
    const joined = reasons.length > 1 ? `${reasons.slice(0, -1).join(', ')} and ${reasons.at(-1)}` : reasons[0];
    const action = riskLevel === 'HIGH'
      ? 'Prioritise for auditor review and verify approver authority.'
      : riskLevel === 'MEDIUM'
        ? 'Sample for review in this audit cycle.'
        : 'Monitor; no immediate action needed.';
    return `${riskLevel} risk: ${entry.entityName} ${amount} entry flagged because ${joined}. ${action}`;
  }
}
