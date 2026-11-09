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

// Tìm user ACTIVE có ít nhất một trong các quyền chỉ định (gồm cả superadmin '*').
// Dùng để định tuyến cảnh báo/nhắc việc tới đúng nhóm trách nhiệm.
export async function findUsersWithPermission(codes: string[]): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE' },
    include: {
      userRoles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    },
  });
  const now = new Date();
  const ids: string[] = [];
  for (const u of users) {
    const perms = new Set<string>();
    for (const ur of u.userRoles) {
      if (ur.validFrom && ur.validFrom > now) continue;
      if (ur.validTo && ur.validTo < now) continue;
      for (const rp of ur.role.permissions) perms.add(rp.permission.code);
    }
    if (perms.has('*') || codes.some((c) => perms.has(c))) ids.push(u.id);
  }
  return ids;
}

// Tạo 1 notification cho mỗi user, chống trùng: bỏ qua nếu user đã có notification
// cùng dedupeKey (lưu trong type) còn chưa đọc. Trả số notification đã tạo.
export async function notifyUsers(
  userIds: string[],
  payload: { type: string; title: string; body?: string; severity?: string; dedupeKey?: string },
): Promise<number> {
  if (userIds.length === 0) return 0;
  const type = payload.dedupeKey ? `${payload.type}:${payload.dedupeKey}` : payload.type;
  const existing = await prisma.notification.findMany({
    where: { userId: { in: userIds }, type, readAt: null },
    select: { userId: true },
  });
  const already = new Set(existing.map((e) => e.userId));
  const toCreate = userIds.filter((id) => !already.has(id));
  if (toCreate.length === 0) return 0;
  const res = await prisma.notification.createMany({
    data: toCreate.map((userId) => ({
      userId,
      type,
      title: payload.title,
      body: payload.body,
      severity: payload.severity ?? 'INFO',
    })),
  });
  return res.count;
}

// Lỗi nghiệp vụ có mã HTTP.
export class ApiError extends Error {
  constructor(public httpStatus: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
