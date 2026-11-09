import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'shms-dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  space: string;
  departmentId: string | null;
  twofaEnabled: boolean;
  permissions: string[];
  dataScopes: (string[] | null)[]; // mỗi role 1 scope; null = toàn bộ
}

export function hashPassword(pw: string) {
  return bcrypt.hashSync(pw, 10);
}
export function verifyPassword(pw: string, hash: string) {
  return bcrypt.compareSync(pw, hash);
}

export function signToken(userId: string) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      userRoles: {
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      },
    },
  });
  if (!user || user.status !== 'ACTIVE') return null;
  const now = new Date();
  const perms = new Set<string>();
  const scopes: (string[] | null)[] = [];
  for (const ur of user.userRoles) {
    if (ur.validFrom && ur.validFrom > now) continue;
    if (ur.validTo && ur.validTo < now) continue;
    scopes.push(ur.dataScope ? JSON.parse(ur.dataScope) : null);
    for (const rp of ur.role.permissions) perms.add(rp.permission.code);
  }
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    space: user.space,
    departmentId: user.departmentId,
    twofaEnabled: user.twofaEnabled,
    permissions: [...perms],
    dataScopes: scopes,
  };
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Thiếu token' } });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { sub: string };
    const user = await loadAuthUser(payload.sub);
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Token không hợp lệ' } });
    (req as any).user = user;
    next();
  } catch {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Token hết hạn hoặc sai' } });
  }
}

// RBAC action-level. '*' = superadmin bỏ qua.
export function requirePermission(...codes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as AuthUser;
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Chưa đăng nhập' } });
    if (user.permissions.includes('*')) return next();
    const ok = codes.some((c) => user.permissions.includes(c));
    if (!ok) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Không đủ quyền', details: codes } });
    }
    next();
  };
}

// Phạm vi dữ liệu theo khoa (A02.3). null scope = toàn bộ.
export function canAccessDepartment(user: AuthUser, departmentId: string | null | undefined): boolean {
  if (user.permissions.includes('*')) return true;
  if (user.dataScopes.some((s) => s === null)) return true;
  if (!departmentId) return true;
  return user.dataScopes.some((s) => Array.isArray(s) && s.includes(departmentId));
}

// Tập khoa user được phép xem, hoặc null nếu không giới hạn (toàn hệ thống).
// Gộp mọi scope của các role; chỉ giới hạn khi MỌI role đều có scope cụ thể.
export function allowedDepartmentIds(user: AuthUser): string[] | null {
  if (user.permissions.includes('*')) return null;
  if (user.dataScopes.length === 0) return null;
  if (user.dataScopes.some((s) => s === null)) return null;
  const set = new Set<string>();
  for (const s of user.dataScopes) if (Array.isArray(s)) for (const d of s) set.add(d);
  return [...set];
}

// Điều kiện Prisma lọc theo khoa cho bảng có trường `field` (mặc định departmentId).
// Trả {} nếu không giới hạn. Cho phép bản ghi departmentId=null (dùng chung) đi qua.
export function scopeDepartmentFilter(user: AuthUser, field = 'departmentId'): Record<string, unknown> {
  const allowed = allowedDepartmentIds(user);
  if (allowed === null) return {};
  return { OR: [{ [field]: { in: allowed } }, { [field]: null }] };
}
