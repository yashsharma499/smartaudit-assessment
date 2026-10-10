import { MockAIEngine, ALLOWED_FLAGS, riskLevelFor } from './MockAIEngine.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { RateLimiter } from './RateLimiter.js';
import { AIProviderError } from '../lib/errors.js';
import { HASH_VECTOR_MODEL } from '../lib/vector.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The AI Enrichment Engine. Produces { riskScore, riskLevel, aiSummary, anomalyFlags,
 * semanticVector, provider, vectorModel } for one audit entry.
 *
 * Strategy:
 *  - MOCK_AI=true  -> deterministic local engine (400 ms simulated latency).
 *  - MOCK_AI=false -> OpenAI, rate-limited, with in-call retries on 429/5xx/timeouts.
 *                     If the LLM still fails, falls back to the local engine so the
 *                     queue keeps moving; the record is marked provider = 'mock-fallback'.
 *  - Every LLM output is validated and normalised before it is stored.
 *  - riskLevel is always derived from riskScore, so the two can never disagree.
 */
export class AIService {
  constructor(aiConfig) {
    this.config = aiConfig;
    this.mock = new MockAIEngine({ delayMs: aiConfig.mockDelayMs });
    this.useLLM = !aiConfig.mock && Boolean(aiConfig.openaiApiKey);
    if (this.useLLM) {
      this.llm = new OpenAIProvider({
        apiKey: aiConfig.openaiApiKey,
        model: aiConfig.model,
        embeddingModel: aiConfig.embeddingModel,
        timeoutMs: aiConfig.requestTimeoutMs,
      });
      this.limiter = new RateLimiter(aiConfig.maxRpm);
    }
  }

  get mode() {
    return this.useLLM ? `openai (${this.config.model})` : 'mock';
  }

  async enrich(entry) {
    if (!this.useLLM) {
      const assessment = await this.mock.assess(entry);
      const { vector, model } = this.mock.embed(entry.description);
      return { ...assessment, semanticVector: vector, vectorModel: model, provider: 'mock' };
    }

    try {
      const raw = await this.withRetry(() => this.llm.assess(entry));
      const assessment = AIService.validate(raw);
      const embedding = await this.embedWithFallback(entry.description);
      return { ...assessment, semanticVector: embedding.vector, vectorModel: embedding.model, provider: 'openai' };
    } catch (err) {
      // Fallback keeps the pipeline flowing during an LLM outage; the reason is surfaced in logs.
      console.warn(`[ai] LLM failed for ${entry.evidenceId}, using local engine: ${err.message}`);
      const assessment = await this.mock.assess(entry);
      const { vector, model } = this.mock.embed(entry.description);
      return { ...assessment, semanticVector: vector, vectorModel: model, provider: 'mock-fallback' };
    }
  }

  async embedWithFallback(text) {
    try {
      return await this.withRetry(() => this.llm.embed(text));
    } catch {
      return { vector: this.mock.embed(text).vector, model: HASH_VECTOR_MODEL };
    }
  }

  /** Rate-limited call with exponential backoff on retryable errors (1s, 2s). */
  async withRetry(fn, retries = 2) {
    for (let attempt = 0; ; attempt += 1) {
      await this.limiter.acquire();
      try {
        return await fn();
      } catch (err) {
        const retryable = err instanceof AIProviderError ? err.retryable : true;
        if (!retryable || attempt >= retries) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  /** Never trust model output blindly: coerce, clamp, and whitelist. */
  static validate(raw) {
    if (!raw || typeof raw !== 'object') throw new AIProviderError('LLM output is not an object', { retryable: true });
    const score = Number(raw.riskScore);
    if (!Number.isFinite(score)) throw new AIProviderError('LLM output missing numeric riskScore', { retryable: true });
    const riskScore = Math.round(Math.min(100, Math.max(0, score)));

    const aiSummary = typeof raw.aiSummary === 'string' ? raw.aiSummary.trim().slice(0, 600) : '';
    if (!aiSummary) throw new AIProviderError('LLM output missing aiSummary', { retryable: true });

    const anomalyFlags = Array.isArray(raw.anomalyFlags)
      ? [...new Set(raw.anomalyFlags.map((f) => String(f).toUpperCase().trim()).filter((f) => ALLOWED_FLAGS.has(f)))]
      : [];

    return { riskScore, riskLevel: riskLevelFor(riskScore), aiSummary, anomalyFlags };
  }
}
