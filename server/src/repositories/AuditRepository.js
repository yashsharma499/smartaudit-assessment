import mongoose from 'mongoose';
import { AuditEntry, AI_STATUS } from '../models/AuditEntry.js';

const { ObjectId } = mongoose.Types;

/**
 * All persistence for audit entries. Every write uses targeted operators ($set / $inc)
 * on dotted paths, never whole-document or whole-`aiMetadata` replacement, so baseline
 * evidence and auditor notes can't be clobbered by a concurrent writer.
 */
export class AuditRepository {
  constructor(model = AuditEntry) {
    this.model = model;
  }

  static isValidId(id) {
    return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
  }

  async create(data) {
    const doc = await this.model.create({
      ...data,
      aiMetadata: {
        status: AI_STATUS.PENDING,
        auditorNotes: data.aiMetadata?.auditorNotes ?? '',
        queuedAt: new Date(),
      },
    });
    return doc.toObject();
  }

  async insertMany(entries) {
    return this.model.insertMany(entries.map((e) => ({ ...e, aiMetadata: { ...(e.aiMetadata || {}), status: AI_STATUS.PENDING, queuedAt: new Date() } })));
  }

  async deleteAllForTenant(tenantId) {
    return this.model.deleteMany({ tenantId });
  }

  async count(filter = {}) {
    return this.model.countDocuments(filter);
  }

  async findById(id, tenantId) {
    const filter = { _id: id };
    if (tenantId) filter.tenantId = tenantId;
    return this.model.findOne(filter).lean();
  }

  async list({ tenantId, limit = 200 } = {}) {
    const filter = tenantId ? { tenantId } : {};
    return this.model.find(filter).sort({ created: -1 }).limit(limit).lean();
  }

  /** Fast track: one atomic write of the notes field only. Status, version and AI output untouched. */
  async updateAuditorNotes(id, tenantId, notes) {
    return this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: { 'aiMetadata.auditorNotes': notes } }, { new: true })
      .lean();
  }

  /**
   * Core-field edit: writes the changed fields, bumps the version and puts the entry back
   * in the queue. Bumping the version is what invalidates any AI run already in flight.
   * Previous AI output stays visible (marked PENDING) until the new run replaces it.
   */
  async applyCoreEditAndRequeue(id, tenantId, coreChanges, notes) {
    const set = {
      ...coreChanges,
      'aiMetadata.status': AI_STATUS.PENDING,
      'aiMetadata.queuedAt': new Date(),
      'aiMetadata.attempts': 0,
      'aiMetadata.nextAttemptAt': null,
      'aiMetadata.lockedAt': null,
      'aiMetadata.lastError': null,
    };
    if (notes !== undefined) set['aiMetadata.auditorNotes'] = notes;

    return this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: set, $inc: { 'aiMetadata.version': 1 } }, { new: true })
      .lean();
  }

  /**
   * Atomically claims the next job. findOneAndUpdate is a single document-level atomic
   * operation, so two workers (or two server instances) can never claim the same entry.
   * Also reclaims jobs whose worker died mid-run (lock older than lockTtlMs).
   */
  async claimNextPending({ lockTtlMs }) {
    const now = new Date();
    return this.model
      .findOneAndUpdate(
        {
          $or: [
            {
              'aiMetadata.status': AI_STATUS.PENDING,
              $or: [{ 'aiMetadata.nextAttemptAt': null }, { 'aiMetadata.nextAttemptAt': { $lte: now } }],
            },
            { 'aiMetadata.status': AI_STATUS.PROCESSING, 'aiMetadata.lockedAt': { $lt: new Date(now.getTime() - lockTtlMs) } },
          ],
        },
        {
          $set: { 'aiMetadata.status': AI_STATUS.PROCESSING, 'aiMetadata.lockedAt': now },
          $inc: { 'aiMetadata.attempts': 1 },
        },
        { sort: { 'aiMetadata.queuedAt': 1 }, new: true },
      )
      .lean();
  }

  /**
   * Writes AI results only if the entry is still the version the worker read.
   * If a core edit happened meanwhile, version changed, nothing matches, and the stale
   * result is dropped; the entry is already PENDING again for the new values.
   * Returns true when the write was applied.
   */
  async completeEnrichment(id, version, result) {
    const res = await this.model.updateOne(
      { _id: id, 'aiMetadata.version': version, 'aiMetadata.status': AI_STATUS.PROCESSING },
      {
        $set: {
          'aiMetadata.status': AI_STATUS.COMPLETED,
          'aiMetadata.riskScore': result.riskScore,
          'aiMetadata.riskLevel': result.riskLevel,
          'aiMetadata.aiSummary': result.aiSummary,
          'aiMetadata.anomalyFlags': result.anomalyFlags,
          'aiMetadata.semanticVector': result.semanticVector,
          'aiMetadata.provider': result.provider,
          'aiMetadata.vectorModel': result.vectorModel,
          'aiMetadata.processedAt': new Date(),
          'aiMetadata.lockedAt': null,
          'aiMetadata.nextAttemptAt': null,
          'aiMetadata.lastError': null,
        },
      },
    );
    return res.modifiedCount === 1;
  }

  /** Failed attempt: back to PENDING with a retry time, or FAILED after maxAttempts. Version-guarded too. */
  async recordFailure(id, version, { error, attempts, maxAttempts, retryDelayMs }) {
    const giveUp = attempts >= maxAttempts;
    const res = await this.model.updateOne(
      { _id: id, 'aiMetadata.version': version, 'aiMetadata.status': AI_STATUS.PROCESSING },
      {
        $set: {
          'aiMetadata.status': giveUp ? AI_STATUS.FAILED : AI_STATUS.PENDING,
          'aiMetadata.lastError': String(error).slice(0, 500),
          'aiMetadata.lockedAt': null,
          'aiMetadata.nextAttemptAt': giveUp ? null : new Date(Date.now() + retryDelayMs),
        },
      },
    );
    return { applied: res.modifiedCount === 1, failed: giveUp };
  }

  /** Manual retry of a FAILED entry. */
  async requeue(id, tenantId) {
    return this.model
      .findOneAndUpdate(
        { _id: id, tenantId, 'aiMetadata.status': AI_STATUS.FAILED },
        {
          $set: {
            'aiMetadata.status': AI_STATUS.PENDING,
            'aiMetadata.queuedAt': new Date(),
            'aiMetadata.attempts': 0,
            'aiMetadata.nextAttemptAt': null,
            'aiMetadata.lastError': null,
          },
        },
        { new: true },
      )
      .lean();
  }

  /**
   * Candidates for similarity: completed entries of the same tenant whose vectors come
   * from the same embedding model (vectors from different models aren't comparable).
   * Projection keeps the scan light: no notes, no full payload.
   */
  async findSimilarityCandidates({ tenantId, excludeId, vectorModel }) {
    return this.model
      .find(
        {
          tenantId,
          _id: { $ne: excludeId },
          'aiMetadata.status': AI_STATUS.COMPLETED,
          'aiMetadata.vectorModel': vectorModel,
        },
        {
          evidenceId: 1,
          entityName: 1,
          description: 1,
          monetaryImpact: 1,
          controlId: 1,
          timestamp: 1,
          'aiMetadata.semanticVector': 1,
          'aiMetadata.riskScore': 1,
          'aiMetadata.riskLevel': 1,
          'aiMetadata.anomalyFlags': 1,
          'aiMetadata.aiSummary': 1,
        },
      )
      .lean();
  }

  async queueStats(tenantId) {
    const match = tenantId ? [{ $match: { tenantId: new ObjectId(tenantId) } }] : [];
    const rows = await this.model.aggregate([...match, { $group: { _id: '$aiMetadata.status', count: { $sum: 1 } } }]);
    return Object.fromEntries(Object.values(AI_STATUS).map((s) => [s, rows.find((r) => r._id === s)?.count ?? 0]));
  }
}
