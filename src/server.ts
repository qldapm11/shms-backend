import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ApiError } from './core/helpers.js';
import { authMiddleware } from './core/auth.js';
import { authRouter } from './modules/auth.router.js';
import { registerModules } from './modules/index.js';

// BASE_PATH khớp prefix gateway Nginx (stripPrefix=false). Rỗng khi chạy local trần.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Toàn bộ API gắn dưới BASE_PATH + /api/v1.
const root = express.Router();
root.get('/api/v1/health', (_req, res) => res.json({ status: 'ok', service: 'shms-backend', basePath: BASE_PATH || '/', ts: Date.now() }));
root.use('/api/v1/auth', authRouter);

const api = express.Router();
api.use(authMiddleware);
registerModules(api);
root.use('/api/v1', api);

app.use(BASE_PATH || '/', root);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Project Hub phục vụ dưới BASE_PATH/docs/ — khai báo TRƯỚC app chính để path docs thắng.
const hubDist = path.resolve(__dirname, '../../shms-document/app/dist');
const hubMount = `${BASE_PATH}/docs`;
if (fs.existsSync(hubDist)) {
  app.use(hubMount, express.static(hubDist));
  app.get(`${hubMount}/*`, (req: Request, res: Response, next: NextFunction) => {
    if (req.path.includes('/api/')) return next();
    res.sendFile(path.join(hubDist, 'index.html'));
  });
}

// Phục vụ bản build frontend bệnh viện dưới BASE_PATH, kèm SPA fallback.
const distDir = path.resolve(__dirname, '../../shms-frontend/dist');
if (fs.existsSync(distDir)) {
  const mount = BASE_PATH || '/';
  app.use(mount, express.static(distDir));
  app.get(`${BASE_PATH}/*`, (req: Request, res: Response, next: NextFunction) => {
    if (req.path.includes('/api/')) return next();
    // Không nuốt route /docs (Hub) nếu build Hub tồn tại.
    if (fs.existsSync(hubDist) && req.path.startsWith(`${hubMount}`)) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// Error middleware chuẩn
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ', details: err.issues } });
  }
  if (err instanceof ApiError) {
    return res.status(err.httpStatus).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Lỗi hệ thống' } });
});

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`SHMS backend chạy tại http://${HOST}:${PORT}${BASE_PATH || ''} (BASE_PATH=${BASE_PATH || '/'})`);
});
