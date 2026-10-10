import mongoose from 'mongoose';

export const AI_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];

/** Fields whose change invalidates the AI assessment and re-queues the record. */
export const CORE_FIELDS = ['monetaryImpact', 'description', 'controlId'];

const aiMetadataSchema = new mongoose.Schema(
  {
    // Fields from the assessment's baseline schema
    status: { type: String, enum: Object.values(AI_STATUS), default: AI_STATUS.PENDING, index: true },
    riskScore: { type: Number, default: null, min: 0, max: 100 },
    riskLevel: { type: String, enum: [...RISK_LEVELS, null], default: null },
    aiSummary: { type: String, default: null },
    anomalyFlags: { type: [String], default: [] },
    semanticVector: { type: [Number], default: [] },
    auditorNotes: { type: String, default: '' },

    // Pipeline bookkeeping (added on top of the baseline schema)
    version: { type: Number, default: 0 }, // bumped on every core-field edit; guards against stale AI writes
    attempts: { type: Number, default: 0 }, // AI attempts for the current version
    queuedAt: { type: Date, default: Date.now }, // FIFO ordering of the queue
    nextAttemptAt: { type: Date, default: null }, // retry backoff
    lockedAt: { type: Date, default: null }, // set when a worker claims the job
    processedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    provider: { type: String, default: null }, // 'mock' | 'openai' | 'mock-fallback'
    vectorModel: { type: String, default: null }, // only vectors from the same model are compared
  },
  { _id: false },
);

const auditEntrySchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true, default: Date.now },
    eventType: { type: String, required: true, trim: true },
    evidenceId: { type: String, required: true, trim: true },
    entityName: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    monetaryImpact: { type: Number, required: true, min: 0 },
    controlId: { type: String, required: true, trim: true },
    actorUserId: { type: String, required: true, trim: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    aiMetadata: { type: aiMetadataSchema, default: () => ({}) },
  },
  {
    // The baseline schema names these `created` / `updated`
    timestamps: { createdAt: 'created', updatedAt: 'updated' },
    versionKey: false,
  },
);

// Evidence IDs are unique per tenant.
auditEntrySchema.index({ tenantId: 1, evidenceId: 1 }, { unique: true });
// Worker queue scan: oldest PENDING first.
auditEntrySchema.index({ 'aiMetadata.status': 1, 'aiMetadata.queuedAt': 1 });
// Similarity candidate scan: completed entries of one tenant.
auditEntrySchema.index({ tenantId: 1, 'aiMetadata.status': 1 });

export const AuditEntry = mongoose.model('AuditEntry', auditEntrySchema);
