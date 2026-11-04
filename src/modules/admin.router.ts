import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { requirePermission } from '../core/auth.js';
import { ah, audit, getUser, ApiError } from '../core/helpers.js';

export const adminRouter = Router();

// ============================================================
// NGƯỜI DÙNG & VAI TRÒ (admin.users)
// ============================================================

adminRouter.get(
  '/admin/users',
  requirePermission('admin.users'),
  ah(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const where = q
      ? {
          OR: [
            { username: { contains: q } },
            { fullName: { contains: q } },
          ],
        }
      : {};
    const users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        department: { select: { id: true, code: true, name: true } },
        userRoles: { include: { role: { select: { code: true, name: true, space: true } } } },
      },
    });
    res.json({
      data: users.map((u) => ({
        id: u.id,
        username: u.username,
        fullName: u.fullName,
        status: u.status,
        space: u.space,
        mustChangePassword: u.mustChangePassword,
        departmentId: u.departmentId,
        department: u.department,
        roles: u.userRoles.map((ur) => ur.role.code),
        createdAt: u.createdAt,
      })),
    });
  }),
);

adminRouter.post(
  '/admin/users',
  requirePermission('admin.users'),
  ah(async (req, res) => {
    const body = z
      .object({
        username: z.string().min(1),
        password: z.string().min(6),
        fullName: z.string().min(1),
        space: z.enum(['HOSPITAL', 'HUB', 'BOTH']).default('HOSPITAL'),
        departmentId: z.string().nullish(),
        roles: z.array(z.string()).default([]),
      })
      .parse(req.body);

    const existing = await prisma.user.findUnique({ where: { username: body.username } });
    if (existing) throw new ApiError(409, 'CONFLICT', 'Tên đăng nhập đã tồn tại');

    const roleRecords = body.roles.length
      ? await prisma.role.findMany({ where: { code: { in: body.roles } } })
      : [];
    if (roleRecords.length !== body.roles.length) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Mã vai trò không hợp lệ');
    }

    const user = await prisma.user.create({
      data: {
        username: body.username,
        passwordHash: bcrypt.hashSync(body.password, 10),
        fullName: body.fullName,
        space: body.space,
        departmentId: body.departmentId ?? null,
        userRoles: {
          create: roleRecords.map((r) => ({ roleId: r.id })),
        },
      },
    });
    await audit(req, 'USER_CREATE', 'user', user.id, { username: user.username, roles: body.roles });
    res.status(201).json({ data: { id: user.id, username: user.username } });
  }),
);

adminRouter.patch(
  '/admin/users/:id',
  requirePermission('admin.users'),
  ah(async (req, res) => {
    const body = z
      .object({
        fullName: z.string().min(1).optional(),
        status: z.enum(['ACTIVE', 'LOCKED', 'DISABLED']).optional(),
        departmentId: z.string().nullable().optional(),
      })
      .parse(req.body);
    await prisma.user.findUniqueOrThrow({ where: { id: req.params.id } }).catch(() => {
      throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy người dùng');
    });
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(body.fullName !== undefined ? { fullName: body.fullName } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
      },
    });
    await audit(req, 'USER_UPDATE', 'user', user.id, body);
    res.json({ data: { id: user.id } });
  }),
);

adminRouter.post(
  '/admin/users/:id/lock',
  requirePermission('admin.users'),
  ah(async (req, res) => {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: 'LOCKED' },
    });
    await audit(req, 'USER_LOCK', 'user', user.id);
    res.json({ data: { id: user.id, status: user.status } });
  }),
);

adminRouter.post(
  '/admin/users/:id/unlock',
  requirePermission('admin.users'),
  ah(async (req, res) => {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: 'ACTIVE' },
    });
    await audit(req, 'USER_UNLOCK', 'user', user.id);
    res.json({ data: { id: user.id, status: user.status } });
  }),
);

adminRouter.post(
  '/admin/users/:id/reset-password',
  requirePermission('admin.users'),
  ah(async (req, res) => {
    const tempPassword = `Tmp-${Math.random().toString(36).slice(2, 10)}`;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        passwordHash: bcrypt.hashSync(tempPassword, 10),
        mustChangePassword: true,
      },
    });
    await audit(req, 'USER_RESET_PASSWORD', 'user', user.id);
    res.json({ data: { id: user.id, tempPassword } });
  }),
);

adminRouter.get(
  '/admin/roles',
  requirePermission('admin.users'),
  ah(async (_req, res) => {
    const roles = await prisma.role.findMany({
      orderBy: { code: 'asc' },
      include: { permissions: { include: { permission: { select: { code: true } } } } },
    });
    res.json({
      data: roles.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        space: r.space,
        isDefault: r.isDefault,
        permissions: r.permissions.map((rp) => rp.permission.code),
      })),
    });
  }),
);

adminRouter.get(
  '/admin/permissions',
  requirePermission('admin.users'),
  ah(async (_req, res) => {
    const perms = await prisma.permission.findMany({ orderBy: { code: 'asc' } });
    res.json({ data: perms });
  }),
);

// ============================================================
// DANH MỤC (admin.catalog)
// ============================================================

// ----- Departments -----
adminRouter.get(
  '/admin/departments',
  requirePermission('admin.catalog'),
  ah(async (_req, res) => {
    const data = await prisma.department.findMany({ orderBy: { code: 'asc' } });
    res.json({ data });
  }),
);

adminRouter.post(
  '/admin/departments',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        type: z.enum(['KHOA', 'PHONG', 'BUONG']),
        parentId: z.string().nullish(),
      })
      .parse(req.body);
    const dep = await prisma.department.create({
      data: { code: body.code, name: body.name, type: body.type, parentId: body.parentId ?? null },
    });
    await audit(req, 'DEPARTMENT_CREATE', 'department', dep.id, body);
    res.status(201).json({ data: dep });
  }),
);

adminRouter.patch(
  '/admin/departments/:id',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).optional(),
        type: z.enum(['KHOA', 'PHONG', 'BUONG']).optional(),
        status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
        parentId: z.string().nullable().optional(),
      })
      .parse(req.body);
    const dep = await prisma.department.update({ where: { id: req.params.id }, data: body });
    await audit(req, 'DEPARTMENT_UPDATE', 'department', dep.id, body);
    res.json({ data: dep });
  }),
);

adminRouter.post(
  '/admin/departments/:id/deactivate',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const dep = await prisma.department.update({
      where: { id: req.params.id },
      data: { status: 'INACTIVE' },
    });
    await audit(req, 'DEPARTMENT_DEACTIVATE', 'department', dep.id);
    res.json({ data: dep });
  }),
);

// ----- Beds -----
adminRouter.get(
  '/admin/beds',
  requirePermission('admin.catalog'),
  ah(async (_req, res) => {
    const data = await prisma.bed.findMany({
      orderBy: { code: 'asc' },
      include: { department: { select: { code: true, name: true } } },
    });
    res.json({ data });
  }),
);

adminRouter.post(
  '/admin/beds',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(1),
        departmentId: z.string().min(1),
        status: z.enum(['EMPTY', 'RESERVED', 'OCCUPIED', 'MAINT']).default('EMPTY'),
      })
      .parse(req.body);
    const bed = await prisma.bed.create({ data: body });
    await audit(req, 'BED_CREATE', 'bed', bed.id, body);
    res.status(201).json({ data: bed });
  }),
);

adminRouter.patch(
  '/admin/beds/:id',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const body = z
      .object({
        departmentId: z.string().min(1).optional(),
        status: z.enum(['EMPTY', 'RESERVED', 'OCCUPIED', 'MAINT']).optional(),
      })
      .parse(req.body);
    const bed = await prisma.bed.update({ where: { id: req.params.id }, data: body });
    await audit(req, 'BED_UPDATE', 'bed', bed.id, body);
    res.json({ data: bed });
  }),
);

adminRouter.post(
  '/admin/beds/:id/deactivate',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const bed = await prisma.bed.update({
      where: { id: req.params.id },
      data: { status: 'MAINT' },
    });
    await audit(req, 'BED_DEACTIVATE', 'bed', bed.id);
    res.json({ data: bed });
  }),
);

// ----- Services -----
adminRouter.get(
  '/admin/services',
  requirePermission('admin.catalog'),
  ah(async (_req, res) => {
    const data = await prisma.service.findMany({ orderBy: { code: 'asc' } });
    res.json({ data });
  }),
);

adminRouter.post(
  '/admin/services',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        specialty: z.string().nullish(),
        price: z.number().nonnegative().default(0),
        bhytPrice: z.number().nonnegative().default(0),
      })
      .parse(req.body);
    const svc = await prisma.service.create({
      data: {
        code: body.code,
        name: body.name,
        specialty: body.specialty ?? null,
        price: body.price,
        bhytPrice: body.bhytPrice,
      },
    });
    await audit(req, 'SERVICE_CREATE', 'service', svc.id, body);
    res.status(201).json({ data: svc });
  }),
);

adminRouter.patch(
  '/admin/services/:id',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).optional(),
        specialty: z.string().nullable().optional(),
        price: z.number().nonnegative().optional(),
        bhytPrice: z.number().nonnegative().optional(),
        status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
      })
      .parse(req.body);
    const svc = await prisma.service.update({ where: { id: req.params.id }, data: body });
    await audit(req, 'SERVICE_UPDATE', 'service', svc.id, body);
    res.json({ data: svc });
  }),
);

adminRouter.post(
  '/admin/services/:id/deactivate',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const svc = await prisma.service.update({
      where: { id: req.params.id },
      data: { status: 'INACTIVE' },
    });
    await audit(req, 'SERVICE_DEACTIVATE', 'service', svc.id);
    res.json({ data: svc });
  }),
);

// ----- Drugs -----
adminRouter.get(
  '/admin/drugs',
  requirePermission('admin.catalog'),
  ah(async (_req, res) => {
    const data = await prisma.drug.findMany({ orderBy: { code: 'asc' } });
    res.json({ data });
  }),
);

adminRouter.post(
  '/admin/drugs',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        unit: z.string().min(1),
        form: z.string().nullish(),
        activeIngredient: z.string().nullish(),
      })
      .parse(req.body);
    const drug = await prisma.drug.create({
      data: {
        code: body.code,
        name: body.name,
        unit: body.unit,
        form: body.form ?? null,
        activeIngredient: body.activeIngredient ?? null,
      },
    });
    await audit(req, 'DRUG_CREATE', 'drug', drug.id, body);
    res.status(201).json({ data: drug });
  }),
);

adminRouter.patch(
  '/admin/drugs/:id',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).optional(),
        unit: z.string().min(1).optional(),
        form: z.string().nullable().optional(),
        activeIngredient: z.string().nullable().optional(),
        status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
      })
      .parse(req.body);
    const drug = await prisma.drug.update({ where: { id: req.params.id }, data: body });
    await audit(req, 'DRUG_UPDATE', 'drug', drug.id, body);
    res.json({ data: drug });
  }),
);

adminRouter.post(
  '/admin/drugs/:id/deactivate',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const drug = await prisma.drug.update({
      where: { id: req.params.id },
      data: { status: 'INACTIVE' },
    });
    await audit(req, 'DRUG_DEACTIVATE', 'drug', drug.id);
    res.json({ data: drug });
  }),
);

// ----- ICD10 -----
adminRouter.get(
  '/admin/icd10',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const where = q
      ? { OR: [{ code: { contains: q } }, { name: { contains: q } }] }
      : {};
    const data = await prisma.icd10.findMany({ where, orderBy: { code: 'asc' }, take: 200 });
    res.json({ data });
  }),
);

adminRouter.post(
  '/admin/icd10',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        parent: z.string().nullish(),
      })
      .parse(req.body);
    const icd = await prisma.icd10.create({
      data: { code: body.code, name: body.name, parent: body.parent ?? null },
    });
    await audit(req, 'ICD10_CREATE', 'icd10', icd.code, body);
    res.status(201).json({ data: icd });
  }),
);

adminRouter.patch(
  '/admin/icd10/:code',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).optional(),
        parent: z.string().nullable().optional(),
      })
      .parse(req.body);
    const icd = await prisma.icd10.update({ where: { code: req.params.code }, data: body });
    await audit(req, 'ICD10_UPDATE', 'icd10', icd.code, body);
    res.json({ data: icd });
  }),
);

// ============================================================
// CẤU HÌNH (admin.config)
// ============================================================

adminRouter.get(
  '/admin/config',
  requirePermission('admin.config'),
  ah(async (_req, res) => {
    const data = await prisma.configParam.findMany({ orderBy: { key: 'asc' } });
    res.json({ data });
  }),
);

adminRouter.put(
  '/admin/config',
  requirePermission('admin.config'),
  ah(async (req, res) => {
    const body = z
      .object({
        key: z.string().min(1),
        value: z.string(),
        scope: z.string().default('GLOBAL'),
      })
      .parse(req.body);
    const param = await prisma.configParam.upsert({
      where: { key: body.key },
      update: { value: body.value, scope: body.scope },
      create: { key: body.key, value: body.value, scope: body.scope },
    });
    await audit(req, 'CONFIG_UPDATE', 'config', param.key, { value: body.value });
    res.json({ data: param });
  }),
);

adminRouter.get(
  '/admin/thresholds',
  requirePermission('admin.config'),
  ah(async (_req, res) => {
    const data = await prisma.alertThreshold.findMany({ orderBy: { metric: 'asc' } });
    res.json({ data });
  }),
);

adminRouter.post(
  '/admin/thresholds',
  requirePermission('admin.config'),
  ah(async (req, res) => {
    const body = z
      .object({
        metric: z.string().min(1),
        deptId: z.string().nullish(),
        minVal: z.number().nullish(),
        maxVal: z.number().nullish(),
        severity: z.enum(['INFO', 'WARN', 'CRITICAL']).default('WARN'),
      })
      .parse(req.body);
    const th = await prisma.alertThreshold.create({
      data: {
        metric: body.metric,
        deptId: body.deptId ?? null,
        minVal: body.minVal ?? null,
        maxVal: body.maxVal ?? null,
        severity: body.severity,
      },
    });
    await audit(req, 'THRESHOLD_CREATE', 'alertThreshold', th.id, body);
    res.status(201).json({ data: th });
  }),
);

// ============================================================
// GIÁM SÁT (admin.monitor)
// ============================================================

adminRouter.get(
  '/admin/audit',
  requirePermission('admin.monitor'),
  ah(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
    const [total, data] = await Promise.all([
      prisma.auditLog.count(),
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * size,
        take: size,
      }),
    ]);
    res.json({ data, page, size, total });
  }),
);

adminRouter.get(
  '/admin/integrations',
  requirePermission('admin.monitor'),
  ah(async (_req, res) => {
    const data = await prisma.integration.findMany({ orderBy: { type: 'asc' } });
    res.json({ data });
  }),
);

adminRouter.get(
  '/admin/sync-logs',
  requirePermission('admin.monitor'),
  ah(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
    const [total, data] = await Promise.all([
      prisma.syncLog.count(),
      prisma.syncLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * size,
        take: size,
        include: { integration: { select: { type: true, name: true } } },
      }),
    ]);
    res.json({ data, page, size, total });
  }),
);

adminRouter.get(
  '/admin/monitor/health',
  requirePermission('admin.monitor'),
  ah(async (_req, res) => {
    const [users, patients, encounters] = await Promise.all([
      prisma.user.count(),
      prisma.patient.count(),
      prisma.encounter.count(),
    ]);
    res.json({ data: { status: 'OK', users, patients, encounters, time: new Date().toISOString() } });
  }),
);
