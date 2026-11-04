import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { signToken, verifyPassword, hashPassword, authMiddleware } from '../core/auth.js';
import { ah, audit, getUser, ApiError } from '../core/helpers.js';

export const authRouter = Router();

authRouter.post(
  '/login',
  ah(async (req, res) => {
    const body = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { username: body.username } });
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sai tài khoản hoặc mật khẩu');
    }
    if (user.status !== 'ACTIVE') throw new ApiError(403, 'FORBIDDEN', 'Tài khoản bị khóa');
    // 2FA: nếu bật, demo chấp nhận bước xác minh đơn giản (A01.3 — bản demo).
    const token = signToken(user.id);
    await prisma.auditLog.create({ data: { userId: user.id, action: 'LOGIN', resource: 'auth', ip: req.ip } });
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        space: user.space,
        mustChangePassword: user.mustChangePassword,
        twofaEnabled: user.twofaEnabled,
      },
    });
  }),
);

authRouter.get(
  '/me',
  authMiddleware,
  ah(async (req, res) => {
    res.json({ user: getUser(req) });
  }),
);

authRouter.post(
  '/password/change',
  authMiddleware,
  ah(async (req, res) => {
    const body = z
      .object({ oldPassword: z.string(), newPassword: z.string().min(8) })
      .parse(req.body);
    const u = getUser(req);
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    if (!verifyPassword(body.oldPassword, dbUser.passwordHash)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Mật khẩu cũ sai');
    }
    if (body.newPassword === body.oldPassword) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Mật khẩu mới trùng mật khẩu cũ');
    }
    await prisma.user.update({
      where: { id: u.id },
      data: { passwordHash: hashPassword(body.newPassword), mustChangePassword: false },
    });
    await audit(req, 'PASSWORD_CHANGE', 'user', u.id);
    res.json({ ok: true });
  }),
);
