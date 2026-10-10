import { CORE_FIELDS } from '../models/AuditEntry.js';
import { HttpError } from './errors.js';

export const UPDATE_PATH = Object.freeze({
  FAST_TRACK: 'FAST_TRACK', // only auditor notes changed: atomic $set, AI untouched
  AI_REQUEUE: 'AI_REQUEUE', // a core financial field changed: re-run the AI pipeline
  NO_CHANGE: 'NO_CHANGE', // values identical to what is stored: nothing written
});

const EDITABLE_FIELDS = [...CORE_FIELDS, 'auditorNotes'];

/** Normalises values so "85000" vs 85000 or trailing spaces don't count as edits. */
function normalize(field, value) {
  if (value === null || value === undefined) return value;
  if (field === 'monetaryImpact') return Number(value);
  return String(value).trim();
}

/**
 * Accepts `auditorNotes` either top-level or as `aiMetadata.auditorNotes`.
 * Rejects unknown or immutable fields so a client can't overwrite baseline evidence
 * (evidenceId, tenantId, AI output, status...) through this endpoint.
 */
export function parseUpdatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }

  const input = { ...body };
  if (input.aiMetadata && typeof input.aiMetadata === 'object') {
    const { auditorNotes, ...rest } = input.aiMetadata;
    if (Object.keys(rest).length > 0) {
      throw new HttpError(400, `AI metadata is system-managed; only aiMetadata.auditorNotes is editable (got: ${Object.keys(rest).join(', ')})`);
    }
    if (auditorNotes !== undefined) input.auditorNotes = auditorNotes;
    delete input.aiMetadata;
  }

  const unknown = Object.keys(input).filter((k) => !EDITABLE_FIELDS.includes(k));
  if (unknown.length > 0) {
    throw new HttpError(400, `Field(s) not editable: ${unknown.join(', ')}. Editable: ${EDITABLE_FIELDS.join(', ')}`);
  }

  const patch = {};
  for (const field of EDITABLE_FIELDS) {
    if (input[field] === undefined) continue;
    const value = normalize(field, input[field]);
    if (field === 'monetaryImpact' && (!Number.isFinite(value) || value < 0)) {
      throw new HttpError(400, 'monetaryImpact must be a non-negative number');
    }
    if ((field === 'description' || field === 'controlId') && !value) {
      throw new HttpError(400, `${field} cannot be empty`);
    }
    patch[field] = field === 'auditorNotes' ? String(input[field] ?? '') : value;
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, 'No editable fields in request');
  return patch;
}

/**
 * Compares the requested values against the stored document (value-level, not key presence)
 * and decides which path the update takes.
 */
export function evaluateDelta(current, patch) {
  const coreChanges = {};
  for (const field of CORE_FIELDS) {
    if (patch[field] === undefined) continue;
    if (normalize(field, patch[field]) !== normalize(field, current[field])) coreChanges[field] = patch[field];
  }

  const notesChanged = patch.auditorNotes !== undefined && patch.auditorNotes !== (current.aiMetadata?.auditorNotes ?? '');

  let path = UPDATE_PATH.NO_CHANGE;
  if (Object.keys(coreChanges).length > 0) path = UPDATE_PATH.AI_REQUEUE;
  else if (notesChanged) path = UPDATE_PATH.FAST_TRACK;

  return {
    path,
    coreChanges,
    notes: notesChanged ? patch.auditorNotes : undefined,
    changedFields: [...Object.keys(coreChanges), ...(notesChanged ? ['auditorNotes'] : [])],
  };
}
