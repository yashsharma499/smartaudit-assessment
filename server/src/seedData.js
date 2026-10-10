import { config } from './config.js';

const tenantId = config.defaultTenantId;
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

/**
 * Sample evidence. Two vendor-override records are deliberately worded alike, so
 * "Similar" on one surfaces the other at the top; the payroll and access records differ.
 */
export const SEED_ENTRIES = [
  {
    timestamp: hoursAgo(72),
    eventType: 'Control Execution',
    evidenceId: 'EVID-902188',
    entityName: 'Global Procurement Services',
    description: 'Manual approval override executed for vendor invoice payables exceeding $50k threshold',
    monetaryImpact: 85000,
    controlId: 'CTRL-FIN-302',
    actorUserId: 'user_7731',
    tenantId,
  },
  {
    timestamp: hoursAgo(50),
    eventType: 'Control Execution',
    evidenceId: 'EVID-902245',
    entityName: 'Northwind Logistics',
    description: 'Vendor invoice approval override by manual exception for urgent payables batch',
    monetaryImpact: 120000,
    controlId: 'CTRL-FIN-302',
    actorUserId: 'user_4410',
    tenantId,
  },
  {
    timestamp: hoursAgo(30),
    eventType: 'Payroll Adjustment',
    evidenceId: 'EVID-903011',
    entityName: 'Contoso HR Shared Services',
    description: 'Off-cycle payroll bonus self-approved by the same user who raised the request',
    monetaryImpact: 300000,
    controlId: 'CTRL-FIN-118',
    actorUserId: 'user_2290',
    tenantId,
  },
  {
    timestamp: hoursAgo(20),
    eventType: 'Access Review',
    evidenceId: 'EVID-903377',
    entityName: 'Fabrikam IT Operations',
    description: 'Quarterly user access review completed for ERP finance module with no exceptions',
    monetaryImpact: 0,
    controlId: 'CTRL-ITG-021',
    actorUserId: 'user_1185',
    tenantId,
  },
  {
    timestamp: hoursAgo(6),
    eventType: 'Journal Entry',
    evidenceId: 'EVID-903502',
    entityName: 'Global Procurement Services',
    description: 'Standard monthly accrual journal posted for facilities maintenance contract',
    monetaryImpact: 18250,
    controlId: 'CTRL-FIN-207',
    actorUserId: 'user_7731',
    tenantId,
  },
];
