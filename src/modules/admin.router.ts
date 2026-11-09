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

// Xóa cứng người dùng — chỉ khi chưa phát sinh dữ liệu (không là bác sĩ của lượt khám nào,
// không có bản ghi audit). Nếu đã phát sinh → 409, gợi ý "Khóa". Xóa kèm UserRole.
adminRouter.delete(
  '/admin/users/:id',
  requirePermission('admin.users'),
  ah(async (req, res) => {
    const id = req.params.id;
    const self = getUser(req);
    if (id === self.id) throw new ApiError(422, 'SELF_DELETE_FORBIDDEN', 'Không thể tự xóa tài khoản của chính mình');
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy người dùng');
    const [encounters, audits] = await Promise.all([
      prisma.encounter.count({ where: { doctorId: id } }),
      prisma.auditLog.count({ where: { userId: id } }),
    ]);
    if (encounters + audits > 0) {
      throw new ApiError(409, 'IN_USE', 'Người dùng đã phát sinh dữ liệu, không thể xóa. Hãy dùng "Khóa".', { encounters, audits });
    }
    await prisma.userRole.deleteMany({ where: { userId: id } });
    await prisma.user.delete({ where: { id } });
    await audit(req, 'USER_DELETE', 'user', id);
    res.json({ ok: true });
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

// Xóa cứng vai trò — chỉ khi không phải vai trò mặc định và không còn ai được gán.
// Xóa kèm RolePermission.
adminRouter.delete(
  '/admin/roles/:id',
  requirePermission('admin.users'),
  ah(async (req, res) => {
    const id = req.params.id;
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy vai trò');
    if (role.isDefault) throw new ApiError(422, 'DEFAULT_ROLE', 'Không thể xóa vai trò mặc định');
    const assigned = await prisma.userRole.count({ where: { roleId: id } });
    if (assigned > 0) {
      throw new ApiError(409, 'IN_USE', 'Vai trò đang được gán cho người dùng, không thể xóa.', { assigned });
    }
    await prisma.rolePermission.deleteMany({ where: { roleId: id } });
    await prisma.role.delete({ where: { id } });
    await audit(req, 'ROLE_DELETE', 'role', id);
    res.json({ ok: true });
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

// Xóa cứng khoa/phòng — chỉ khi KHÔNG còn bản ghi tham chiếu (user/giường/khoa con/
// lượt khám/lịch hẹn/thiết bị/lịch trực). Nếu còn → 409, gợi ý dùng "Ngừng".
adminRouter.delete(
  '/admin/departments/:id',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const id = req.params.id;
    const [users, beds, children, encounters, appts, devices, rosters] = await Promise.all([
      prisma.user.count({ where: { departmentId: id } }),
      prisma.bed.count({ where: { departmentId: id } }),
      prisma.department.count({ where: { parentId: id } }),
      prisma.encounter.count({ where: { departmentId: id } }),
      prisma.appointment.count({ where: { departmentId: id } }),
      prisma.medicalDevice.count({ where: { departmentId: id } }),
      prisma.dutyRoster.count({ where: { departmentId: id } }),
    ]);
    const refs = users + beds + children + encounters + appts + devices + rosters;
    if (refs > 0) {
      throw new ApiError(409, 'IN_USE', 'Khoa/phòng đang được tham chiếu, không thể xóa. Hãy dùng "Ngừng".', {
        users, beds, children, encounters, appointments: appts, devices, rosters,
      });
    }
    await prisma.department.delete({ where: { id } });
    await audit(req, 'DEPARTMENT_DELETE', 'department', id);
    res.json({ ok: true });
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

// Xóa cứng giường — chỉ khi không còn lần nhập viện nào tham chiếu và không đang dùng.
adminRouter.delete(
  '/admin/beds/:id',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const id = req.params.id;
    const bed = await prisma.bed.findUnique({ where: { id } });
    if (!bed) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy giường');
    const admissions = await prisma.admission.count({ where: { bedId: id } });
    if (admissions > 0 || bed.status === 'OCCUPIED') {
      throw new ApiError(409, 'IN_USE', 'Giường đang/đã được dùng, không thể xóa. Hãy dùng "Ngừng".', { admissions, status: bed.status });
    }
    await prisma.bed.delete({ where: { id } });
    await audit(req, 'BED_DELETE', 'bed', id);
    res.json({ ok: true });
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

// Xóa cứng dịch vụ — chỉ khi không có chỉ định (order) hay dòng hóa đơn nào tham chiếu.
adminRouter.delete(
  '/admin/services/:id',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const id = req.params.id;
    const [orders, invoiceItems] = await Promise.all([
      prisma.order.count({ where: { serviceId: id } }),
      prisma.invoiceItem.count({ where: { refType: 'SERVICE', refId: id } }),
    ]);
    if (orders + invoiceItems > 0) {
      throw new ApiError(409, 'IN_USE', 'Dịch vụ đã phát sinh chỉ định/hóa đơn, không thể xóa. Hãy dùng "Ngừng".', { orders, invoiceItems });
    }
    await prisma.service.delete({ where: { id } });
    await audit(req, 'SERVICE_DELETE', 'service', id);
    res.json({ ok: true });
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

// Xóa cứng thuốc — chỉ khi không có dòng đơn thuốc, lô tồn kho hay dòng hóa đơn tham chiếu.
adminRouter.delete(
  '/admin/drugs/:id',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const id = req.params.id;
    const [items, lots, invoiceItems] = await Promise.all([
      prisma.prescriptionItem.count({ where: { drugId: id } }),
      prisma.inventoryLot.count({ where: { drugId: id } }),
      prisma.invoiceItem.count({ where: { refType: 'DRUG', refId: id } }),
    ]);
    if (items + lots + invoiceItems > 0) {
      throw new ApiError(409, 'IN_USE', 'Thuốc đã phát sinh đơn/tồn kho/hóa đơn, không thể xóa. Hãy dùng "Ngừng".', { items, lots, invoiceItems });
    }
    await prisma.drug.delete({ where: { id } });
    await audit(req, 'DRUG_DELETE', 'drug', id);
    res.json({ ok: true });
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

// Ngừng/kích hoạt ICD-10 (xóa mềm, nhất quán với danh mục khác).
adminRouter.post(
  '/admin/icd10/:code/deactivate',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const icd = await prisma.icd10.update({ where: { code: req.params.code }, data: { status: 'INACTIVE' } });
    await audit(req, 'ICD10_DEACTIVATE', 'icd10', icd.code);
    res.json({ data: icd });
  }),
);

adminRouter.post(
  '/admin/icd10/:code/activate',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const icd = await prisma.icd10.update({ where: { code: req.params.code }, data: { status: 'ACTIVE' } });
    await audit(req, 'ICD10_ACTIVATE', 'icd10', icd.code);
    res.json({ data: icd });
  }),
);

// Xóa cứng ICD-10 — chỉ khi không có chẩn đoán nào dùng mã này.
adminRouter.delete(
  '/admin/icd10/:code',
  requirePermission('admin.catalog'),
  ah(async (req, res) => {
    const code = req.params.code;
    const diagnoses = await prisma.diagnosis.count({ where: { icd10Code: code } });
    if (diagnoses > 0) {
      throw new ApiError(409, 'IN_USE', 'Mã ICD-10 đã dùng trong chẩn đoán, không thể xóa. Hãy dùng "Ngừng".', { diagnoses });
    }
    await prisma.icd10.delete({ where: { code } });
    await audit(req, 'ICD10_DELETE', 'icd10', code);
    res.json({ ok: true });
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

// ============================================================
// NHẬP TÀI KHOẢN TỪ EXCEL (A01.4) — admin.users
// Frontend parse file Excel, gửi JSON rows.
// ============================================================
adminRouter.post(
  '/admin/users/import',
  requirePermission('admin.users'),
  ah(async (req, res) => {
    const body = z
      .object({
        rows: z
          .array(
            z.object({
              username: z.string().min(1),
              fullName: z.string().min(1),
              password: z.string().min(6).optional(),
              roleCode: z.string().min(1),
              departmentCode: z.string().optional(),
            }),
          )
          .min(1),
      })
      .parse(req.body);

    const created: string[] = [];
    const skipped: string[] = [];
    const errors: { username: string; message: string }[] = [];

    for (const row of body.rows) {
      try {
        const existing = await prisma.user.findUnique({ where: { username: row.username } });
        if (existing) {
          skipped.push(row.username);
          continue;
        }
        const role = await prisma.role.findUnique({ where: { code: row.roleCode } });
        if (!role) {
          errors.push({ username: row.username, message: `Mã vai trò không hợp lệ: ${row.roleCode}` });
          continue;
        }
        let departmentId: string | null = null;
        if (row.departmentCode) {
          const dep = await prisma.department.findUnique({ where: { code: row.departmentCode } });
          if (!dep) {
            errors.push({ username: row.username, message: `Mã khoa không hợp lệ: ${row.departmentCode}` });
            continue;
          }
          departmentId = dep.id;
        }
        const user = await prisma.user.create({
          data: {
            username: row.username,
            passwordHash: bcrypt.hashSync(row.password ?? `${row.username}123`, 10),
            fullName: row.fullName,
            space: role.space === 'HUB' ? 'HUB' : 'HOSPITAL',
            mustChangePassword: !row.password,
            departmentId,
            userRoles: { create: [{ roleId: role.id }] },
          },
        });
        created.push(user.username);
      } catch (e) {
        errors.push({ username: row.username, message: (e as Error).message });
      }
    }

    await audit(req, 'USER_IMPORT', 'user', undefined, {
      created: created.length,
      skipped: skipped.length,
      errors: errors.length,
    });
    res.json({ created, skipped, errors });
  }),
);

// ============================================================
// PHÂN QUYỀN TẠM THỜI (A02.4) — admin.users
// ============================================================
adminRouter.post(
  '/admin/users/:id/temp-grant',
  requirePermission('admin.users'),
  ah(async (req, res) => {
    const body = z
      .object({
        roleCode: z.string().min(1),
        validFrom: z.coerce.date(),
        validTo: z.coerce.date(),
        dataScope: z.array(z.string()).optional(),
      })
      .parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy người dùng');
    const role = await prisma.role.findUnique({ where: { code: body.roleCode } });
    if (!role) throw new ApiError(400, 'VALIDATION_ERROR', 'Mã vai trò không hợp lệ');
    if (body.validTo <= body.validFrom) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'validTo phải sau validFrom');
    }
    const userRole = await prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: role.id,
        validFrom: body.validFrom,
        validTo: body.validTo,
        dataScope: body.dataScope ? JSON.stringify(body.dataScope) : null,
      },
    });
    await audit(req, 'TEMP_GRANT', 'userRole', userRole.id, {
      userId: user.id,
      roleCode: body.roleCode,
      validFrom: body.validFrom,
      validTo: body.validTo,
    });
    res.status(201).json({ data: userRole });
  }),
);

adminRouter.delete(
  '/admin/user-roles/:id',
  requirePermission('admin.users'),
  ah(async (req, res) => {
    const userRole = await prisma.userRole.findUnique({ where: { id: req.params.id } });
    if (!userRole) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy phân quyền');
    await prisma.userRole.delete({ where: { id: req.params.id } });
    await audit(req, 'REVOKE_ROLE', 'userRole', req.params.id, { userId: userRole.userId });
    res.json({ data: { id: req.params.id } });
  }),
);

// ============================================================
// CẤU HÌNH QUY TRÌNH (A04.3) + MẪU IN (A04.4) — admin.config
// Lưu trong ConfigParam theo prefix 'workflow.' / 'printtpl.'.
// ============================================================
adminRouter.get(
  '/admin/workflows',
  requirePermission('admin.config'),
  ah(async (_req, res) => {
    const params = await prisma.configParam.findMany({
      where: { key: { startsWith: 'workflow.' } },
      orderBy: { key: 'asc' },
    });
    const data = params.map((p) => ({ name: p.key.slice('workflow.'.length), value: p.value, scope: p.scope }));
    res.json({ data });
  }),
);

adminRouter.put(
  '/admin/workflows',
  requirePermission('admin.config'),
  ah(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        value: z.string(),
        scope: z.string().default('GLOBAL'),
      })
      .parse(req.body);
    const key = `workflow.${body.name}`;
    const param = await prisma.configParam.upsert({
      where: { key },
      update: { value: body.value, scope: body.scope },
      create: { key, value: body.value, scope: body.scope },
    });
    await audit(req, 'WORKFLOW_UPDATE', 'config', param.key);
    res.json({ data: param });
  }),
);

adminRouter.get(
  '/admin/print-templates',
  requirePermission('admin.config'),
  ah(async (_req, res) => {
    const params = await prisma.configParam.findMany({
      where: { key: { startsWith: 'printtpl.' } },
      orderBy: { key: 'asc' },
    });
    const data = params.map((p) => ({ name: p.key.slice('printtpl.'.length), value: p.value, scope: p.scope }));
    res.json({ data });
  }),
);

adminRouter.put(
  '/admin/print-templates',
  requirePermission('admin.config'),
  ah(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        value: z.string(),
        scope: z.string().default('GLOBAL'),
      })
      .parse(req.body);
    const key = `printtpl.${body.name}`;
    const param = await prisma.configParam.upsert({
      where: { key },
      update: { value: body.value, scope: body.scope },
      create: { key, value: body.value, scope: body.scope },
    });
    await audit(req, 'PRINTTPL_UPDATE', 'config', param.key);
    res.json({ data: param });
  }),
);

// ============================================================
// THEO DÕI SAO LƯU / PHỤC HỒI (A06.4) — admin.monitor (MÔ PHỎNG)
// Lưu bản ghi mô phỏng trong ConfigParam prefix 'backup.'.
// ============================================================
adminRouter.get(
  '/admin/backups',
  requirePermission('admin.monitor'),
  ah(async (_req, res) => {
    const params = await prisma.configParam.findMany({
      where: { key: { startsWith: 'backup.' } },
      orderBy: { key: 'desc' },
    });
    if (params.length === 0) {
      return res.json({
        data: [
          { id: 'MOCK-1', source: 'MOCK', status: 'DONE', note: 'Bản sao lưu mô phỏng', createdAt: new Date().toISOString() },
        ],
        source: 'MOCK',
      });
    }
    const data = params.map((p) => {
      let parsed: unknown = p.value;
      try {
        parsed = JSON.parse(p.value);
      } catch {
        /* giữ nguyên chuỗi */
      }
      return { id: p.key.slice('backup.'.length), ...(typeof parsed === 'object' && parsed ? parsed : { value: parsed }) };
    });
    res.json({ data, source: 'MOCK' });
  }),
);

adminRouter.post(
  '/admin/backups',
  requirePermission('admin.monitor'),
  ah(async (req, res) => {
    const body = z
      .object({
        note: z.string().optional(),
        type: z.enum(['BACKUP', 'RESTORE']).default('BACKUP'),
      })
      .parse(req.body);
    const id = `${Date.now()}`;
    const record = {
      type: body.type,
      status: 'DONE',
      source: 'MOCK',
      note: body.note ?? 'Bản ghi mô phỏng',
      createdAt: new Date().toISOString(),
    };
    const key = `backup.${id}`;
    await prisma.configParam.create({ data: { key, value: JSON.stringify(record), scope: 'BACKUP' } });
    await audit(req, 'BACKUP_CREATE', 'config', key, { type: body.type });
    res.status(201).json({ data: { id, ...record }, source: 'MOCK' });
  }),
);
