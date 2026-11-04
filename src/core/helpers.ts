import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import type { AuthUser } from './auth.js';

// Bọc handler async để lỗi rơi vào error middleware.
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export async function audit(
  req: Request,
  action: string,
  resource: string,
  resourceId?: string,
  detail?: unknown,
) {
  const user = (req as any).user as AuthUser | undefined;
  await prisma.auditLog.create({
    data: {
      userId: user?.id,
      action,
      resource,
      resourceId,
      detail: detail ? JSON.stringify(detail) : undefined,
      ip: req.ip,
    },
  });
}

export function getUser(req: Request): AuthUser {
  return (req as any).user as AuthUser;
}

// Lỗi nghiệp vụ có mã HTTP.
export class ApiError extends Error {
  constructor(public httpStatus: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
