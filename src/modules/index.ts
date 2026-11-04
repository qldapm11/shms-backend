import type { Router } from 'express';
import { adminRouter } from './admin.router.js';
import { clinicalRouter } from './clinical.router.js';
import { inpatientRouter } from './inpatient.router.js';
import { billingRouter } from './billing.router.js';
import { aiIotRouter } from './ai-iot.router.js';
import { reportRouter } from './report.router.js';
import { hubRouter } from './hub.router.js';
import { catalogRouter } from './catalog.router.js';

// Gắn toàn bộ router module vào nhánh /api/v1 (đã qua authMiddleware).
export function registerModules(api: Router) {
  api.use(catalogRouter);
  api.use(adminRouter);
  api.use(clinicalRouter);
  api.use(inpatientRouter);
  api.use(billingRouter);
  api.use(aiIotRouter);
  api.use(reportRouter);
  api.use(hubRouter);
}
