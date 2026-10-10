import { AuditRepository } from '../repositories/AuditRepository.js';
import { AI_STATUS } from '../models/AuditEntry.js';
import { HttpError } from '../lib/errors.js';
import { parseUpdatePayload, evaluateDelta, UPDATE_PATH } from '../lib/delta.js';
import { topKSimilar } from '../lib/vector.js';

const CREATE_FIELDS = ['timestamp', 'eventType', 'evidenceId', 'entityName', 'description', 'monetaryImpact', 'controlId', 'actorUserId', 'tenantId'];
const REQUIRED_ON_CREATE = ['eventType', 'entityName', 'description', 'monetaryImpact', 'controlId', 'actorUserId'];

/**
 * HTTP layer. Methods are arrow properties so they can be passed to Express directly.
 * Tenant scoping: every read/write is filtered by tenantId (x-tenant-id header, else the demo tenant).
 */
export class AuditController {
  constructor({ repository, worker, defaultTenantId }) {
    this.repository = repository;
    this.worker = worker;
    this.defaultTenantId = defaultTenantId;
  }

  tenantOf(req) {
    const tenantId = req.get('x-tenant-id') || req.body?.tenantId || req.query.tenantId || this.defaultTenantId;
    if (!AuditRepository.isValidId(tenantId)) throw new HttpError(400, 'Invalid tenantId');
    return tenantId;
  }

  entryId(req) {
    if (!AuditRepository.isValidId(req.params.id)) throw new HttpError(400, 'Invalid audit entry id');
    return req.params.id;
  }

  /** Scenario A: save immediately as PENDING, respond 202, let the worker enrich it. */
  create = async (req, res) => {
    const body = req.body || {};
    const missing = REQUIRED_ON_CREATE.filter((f) => body[f] === undefined || body[f] === '');
    if (missing.length) throw new HttpError(400, `Missing required field(s): ${missing.join(', ')}`);

    const data = Object.fromEntries(CREATE_FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));
    data.tenantId = this.tenantOf(req);
    data.monetaryImpact = Number(data.monetaryImpact);
    if (!Number.isFinite(data.monetaryImpact) || data.monetaryImpact < 0) throw new HttpError(400, 'monetaryImpact must be a non-negative number');
    data.evidenceId ||= `EVID-${Math.floor(100000 + Math.random() * 900000)}`;

    const entry = await this.repository.create({ ...data, aiMetadata: { auditorNotes: body.aiMetadata?.auditorNotes ?? body.auditorNotes ?? '' } });
    this.worker?.notify();
    res.status(202).location(`/api/audit-entries/${entry._id}`).json(entry);
  };

  list = async (req, res) => {
    const tenantId = this.tenantOf(req);
    const [entries, stats] = await Promise.all([
      this.repository.list({ tenantId }),
      this.repository.queueStats(tenantId),
    ]);
    res.json({ entries, stats });
  };

  get = async (req, res) => {
    const entry = await this.repository.findById(this.entryId(req), this.tenantOf(req));
    if (!entry) throw new HttpError(404, 'Audit entry not found');
    res.json(entry);
  };

  /**
   * Scenario B: Smart Delta Evaluation.
   * Compare requested values to stored values, then:
   *   core field changed -> $set changes + status PENDING + version++ (AI re-runs)
   *   only notes changed -> single atomic $set on aiMetadata.auditorNotes (no AI)
   *   nothing changed    -> no write
   * The response tells the client which path was taken.
   */
  update = async (req, res) => {
    const id = this.entryId(req);
    const tenantId = this.tenantOf(req);
    const patch = parseUpdatePayload(req.body);

    const current = await this.repository.findById(id, tenantId);
    if (!current) throw new HttpError(404, 'Audit entry not found');

    const delta = evaluateDelta(current, patch);
    let entry = current;

    if (delta.path === UPDATE_PATH.AI_REQUEUE) {
      entry = await this.repository.applyCoreEditAndRequeue(id, tenantId, delta.coreChanges, delta.notes);
      this.worker?.notify();
    } else if (delta.path === UPDATE_PATH.FAST_TRACK) {
      entry = await this.repository.updateAuditorNotes(id, tenantId, delta.notes);
    }
    if (!entry) throw new HttpError(404, 'Audit entry not found');

    res.json({ path: delta.path, changedFields: delta.changedFields, aiRecomputation: delta.path === UPDATE_PATH.AI_REQUEUE, entry });
  };

  /** Scenario C: top-3 most similar completed entries of the same tenant, by cosine similarity. */
  similar = async (req, res) => {
    const id = this.entryId(req);
    const tenantId = this.tenantOf(req);
    const k = Math.min(Math.max(Number.parseInt(req.query.k ?? req.body?.k ?? 3, 10) || 3, 1), 10);

    const target = await this.repository.findById(id, tenantId);
    if (!target) throw new HttpError(404, 'Audit entry not found');
    if (target.aiMetadata.status !== AI_STATUS.COMPLETED || target.aiMetadata.semanticVector.length === 0) {
      throw new HttpError(409, `Entry has no semantic vector yet (status: ${target.aiMetadata.status})`);
    }

    const started = performance.now();
    const candidates = await this.repository.findSimilarityCandidates({
      tenantId,
      excludeId: target._id,
      vectorModel: target.aiMetadata.vectorModel,
    });
    const top = topKSimilar(target.aiMetadata.semanticVector, candidates, k, (c) => c.aiMetadata.semanticVector);

    res.json({
      target: { _id: target._id, evidenceId: target.evidenceId, description: target.description, vectorModel: target.aiMetadata.vectorModel },
      results: top.map(({ item, score }) => {
        const { semanticVector, ...ai } = item.aiMetadata;
        return { ...item, aiMetadata: ai, similarity: Number(score.toFixed(4)) };
      }),
      scanned: candidates.length,
      tookMs: Number((performance.now() - started).toFixed(1)),
    });
  };

  retry = async (req, res) => {
    const entry = await this.repository.requeue(this.entryId(req), this.tenantOf(req));
    if (!entry) throw new HttpError(409, 'Only FAILED entries can be retried');
    this.worker?.notify();
    res.json(entry);
  };
}
