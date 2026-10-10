import { AIProviderError } from '../lib/errors.js';
import { ALLOWED_FLAGS, APPROVAL_THRESHOLD } from './MockAIEngine.js';

const SYSTEM_PROMPT = `You are a financial audit risk analyst for a continuous-auditing platform.
Assess ONE audit evidence record and reply with JSON only, matching exactly:
{"riskScore": integer 0-100, "aiSummary": string, "anomalyFlags": string[]}
Rules:
- riskScore reflects audit risk: amount vs the $${APPROVAL_THRESHOLD.toLocaleString('en-US')} approval threshold, manual overrides, unusual wording, segregation-of-duties issues, control type.
- aiSummary: 1-2 sentences explaining WHY this is (or is not) an audit risk. No markdown.
- anomalyFlags: only values from this list: ${[...ALLOWED_FLAGS].join(', ')}. Empty array if none apply.`;

/**
 * Thin OpenAI client over fetch (no SDK dependency).
 * Errors are classified as retryable (429, 5xx, timeouts) or not (4xx auth/validation),
 * so the caller can decide between retry and fallback.
 */
export class OpenAIProvider {
  constructor({ apiKey, model, embeddingModel, timeoutMs, baseUrl = 'https://api.openai.com/v1' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.embeddingModel = embeddingModel;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
    this.name = 'openai';
  }

  async request(path, body) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AIProviderError(`OpenAI request failed: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`, { retryable: true });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      throw new AIProviderError(`OpenAI ${res.status}: ${text.slice(0, 200)}`, { retryable, status: res.status });
    }
    return res.json();
  }

  async assess(entry) {
    const record = {
      eventType: entry.eventType,
      entityName: entry.entityName,
      description: entry.description,
      monetaryImpact: entry.monetaryImpact,
      controlId: entry.controlId,
    };
    const data = await this.request('/chat/completions', {
      model: this.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(record) },
      ],
    });

    const content = data?.choices?.[0]?.message?.content;
    try {
      return JSON.parse(content);
    } catch {
      throw new AIProviderError('OpenAI returned non-JSON content', { retryable: true });
    }
  }

  /** text-embedding-3-* models support `dimensions`, so we can request exactly 8. */
  async embed(text) {
    const data = await this.request('/embeddings', { model: this.embeddingModel, input: text, dimensions: 8 });
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== 8) throw new AIProviderError('Unexpected embedding shape', { retryable: false });
    return { vector: vector.map((x) => Number(x.toFixed(4))), model: `${this.embeddingModel}-8d` };
  }
}
