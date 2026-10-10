import { AuditRepository } from './repositories/AuditRepository.js';
import { AIService } from './services/AIService.js';
import { AIWorkerService } from './services/AIWorkerService.js';
import { AuditController } from './controllers/AuditController.js';
import { createApp } from './app.js';

/** Wires the classes together (plain constructor injection; overrides are used by tests). */
export function buildContainer(config, overrides = {}) {
  const repository = overrides.repository ?? new AuditRepository();
  const aiService = overrides.aiService ?? new AIService(config.ai);
  const worker = overrides.worker ?? new AIWorkerService({ repository, aiService, ...config.worker, logger: overrides.logger ?? console });
  const controller = new AuditController({ repository, worker, defaultTenantId: config.defaultTenantId });
  const app = createApp({ controller, aiService, worker });
  return { repository, aiService, worker, controller, app };
}
