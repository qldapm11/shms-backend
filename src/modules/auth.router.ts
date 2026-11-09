import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { signToken, verifyPassword, hashPassword, authMiddleware } from '../core/auth.js';
import { ah, audit, getUser, ApiError } from '../core/helpers.js';
import { generateSecret, verifyTotp, otpauthUri } from '../core/totp.js';

export const authRouter = Router();

authRouter.post(
  '/login',
  ah(async (req, res) => {
    const body = z
      .object({ username: z.string(), password: z.string(), totp: z.string().optional() })
      .parse(req.body);
    const user = await prisma.user.findUnique({ where: { username: body.username } });
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sai tài khoản hoặc mật khẩu');
    }
    if (user.status !== 'ACTIVE') throw new ApiError(403, 'FORBIDDEN', 'Tài khoản bị khóa');
    // A01.3 — 2FA TOTP thật: nếu bật, bắt buộc mã hợp lệ mới cấp token.
    if (user.twofaEnabled && user.twofaSecret) {
      if (!body.totp) {
        throw new ApiError(401, 'TWOFA_REQUIRED', 'Cần mã xác minh 2 lớp (TOTP)');
      }
      if (!verifyTotp(user.twofaSecret, body.totp)) {
        await prisma.auditLog.create({ data: { userId: user.id, action: 'LOGIN_2FA_FAIL', resource: 'auth', ip: req.ip } });
        throw new ApiError(401, 'TWOFA_INVALID', 'Mã xác minh 2 lớp không đúng');
      }
    }
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

// A01.3 — Bắt đầu thiết lập 2FA: sinh secret (chưa bật), trả URI otpauth để dựng QR.
authRouter.post(
  '/2fa/setup',
  authMiddleware,
  ah(async (req, res) => {
    const u = getUser(req);
    const secret = generateSecret();
    await prisma.user.update({ where: { id: u.id }, data: { twofaSecret: secret, twofaEnabled: false } });
    await audit(req, '2FA_SETUP', 'user', u.id);
    res.json({ secret, otpauthUri: otpauthUri(secret, u.username) });
  }),
);

// Bật 2FA: xác minh mã từ secret vừa thiết lập rồi mới kích hoạt.
authRouter.post(
  '/2fa/enable',
  authMiddleware,
  ah(async (req, res) => {
    const body = z.object({ totp: z.string() }).parse(req.body);
    const u = getUser(req);
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    if (!dbUser.twofaSecret) throw new ApiError(400, 'VALIDATION_ERROR', 'Chưa thiết lập 2FA');
    if (!verifyTotp(dbUser.twofaSecret, body.totp)) {
      throw new ApiError(400, 'TWOFA_INVALID', 'Mã xác minh không đúng');
    }
    await prisma.user.update({ where: { id: u.id }, data: { twofaEnabled: true } });
    await audit(req, '2FA_ENABLE', 'user', u.id);
    res.json({ ok: true, twofaEnabled: true });
  }),
);

// Tắt 2FA: cần mật khẩu hiện tại để xác nhận.
authRouter.post(
  '/2fa/disable',
  authMiddleware,
  ah(async (req, res) => {
    const body = z.object({ password: z.string() }).parse(req.body);
    const u = getUser(req);
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    if (!verifyPassword(body.password, dbUser.passwordHash)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Mật khẩu không đúng');
    }
    await prisma.user.update({ where: { id: u.id }, data: { twofaEnabled: false, twofaSecret: null } });
    await audit(req, '2FA_DISABLE', 'user', u.id);
    res.json({ ok: true, twofaEnabled: false });
  }),
);
