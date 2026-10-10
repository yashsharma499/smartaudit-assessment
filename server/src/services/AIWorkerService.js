import { EventEmitter } from 'node:events';

/**
 * Background worker that drains the PENDING queue stored in MongoDB.
 *
 * Queue design: MongoDB itself is the queue (status field + atomic claim), not a
 * separate broker. For this workload that means one source of truth, no dual-write
 * between DB and queue, and crash recovery via lock expiry. See README for when a
 * dedicated queue (BullMQ / SQS) would be the better choice.
 *
 * - Runs up to `concurrency` jobs in parallel; each slot claims atomically.
 * - Polls every `pollMs`, but `notify()` wakes it immediately after a POST/PUT.
 * - Failed attempts back off exponentially (2s, 4s, 8s...) and give up after maxAttempts.
 * - Results are written with a version guard; stale results are discarded.
 * - Emits events ('completed', 'stale', 'failed', 'retry') for logs and tests.
 */
export class AIWorkerService extends EventEmitter {
  constructor({ repository, aiService, pollMs = 1000, concurrency = 2, lockTtlMs = 30000, maxAttempts = 3, logger = console }) {
    super();
    this.repository = repository;
    this.aiService = aiService;
    this.pollMs = pollMs;
    this.concurrency = concurrency;
    this.lockTtlMs = lockTtlMs;
    this.maxAttempts = maxAttempts;
    this.logger = logger;

    this.running = false;
    this.active = 0;
    this.timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.logger.info?.(`[worker] started: concurrency=${this.concurrency}, poll=${this.pollMs}ms, ai=${this.aiService.mode}`);
    this.tick();
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    // Let in-flight jobs finish so we never leave a half-written result.
    while (this.active > 0) await new Promise((r) => setTimeout(r, 50));
  }

  /** Called by the controller after a write that queued work: skip the poll wait. */
  notify() {
    if (!this.running) return;
    clearTimeout(this.timer);
    setImmediate(() => this.tick());
  }

  tick() {
    if (!this.running) return;
    while (this.active < this.concurrency) {
      this.active += 1;
      this.runSlot().finally(() => {
        this.active -= 1;
      });
    }
    this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.running) this.timer = setTimeout(() => this.tick(), this.pollMs);
  }

  /** One slot keeps claiming jobs until the queue is empty, then frees itself. */
  async runSlot() {
    while (this.running) {
      let job;
      try {
        job = await this.repository.claimNextPending({ lockTtlMs: this.lockTtlMs });
      } catch (err) {
        this.logger.error?.(`[worker] claim failed: ${err.message}`);
        return;
      }
      if (!job) return;
      await this.process(job);
    }
  }

  async process(job) {
    const { _id, evidenceId } = job;
    const { version, attempts } = job.aiMetadata;
    const started = Date.now();

    try {
      const result = await this.aiService.enrich(job);
      const applied = await this.repository.completeEnrichment(_id, version, result);
      if (applied) {
        this.logger.info?.(`[worker] ${evidenceId} v${version} COMPLETED: ${result.riskLevel} ${result.riskScore} via ${result.provider} (${Date.now() - started}ms)`);
        this.emit('completed', { id: String(_id), version, result });
      } else {
        // A core edit bumped the version while we were working; that edit already re-queued it.
        this.logger.info?.(`[worker] ${evidenceId} v${version} result discarded (stale: record changed during processing)`);
        this.emit('stale', { id: String(_id), version });
      }
    } catch (err) {
      const retryDelayMs = 2000 * 2 ** (attempts - 1);
      const { applied, failed } = await this.repository.recordFailure(_id, version, {
        error: err.message,
        attempts,
        maxAttempts: this.maxAttempts,
        retryDelayMs,
      });
      if (!applied) return;
      if (failed) {
        this.logger.error?.(`[worker] ${evidenceId} FAILED after ${attempts} attempts: ${err.message}`);
        this.emit('failed', { id: String(_id), error: err.message });
      } else {
        this.logger.warn?.(`[worker] ${evidenceId} attempt ${attempts} failed, retry in ${retryDelayMs}ms: ${err.message}`);
        this.emit('retry', { id: String(_id), attempts, retryDelayMs });
      }
    }
  }
}
