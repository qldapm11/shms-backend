import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requirePermission } from '../core/auth.js';
import { ah, audit, getUser, ApiError } from '../core/helpers.js';

export const inpatientRouter = Router();

// ============ Nhập / chuyển / xuất viện (admission.write) ============

// Nhập viện: tạo Admission, gán giường, đồng bộ trạng thái encounter + bed.
inpatientRouter.post(
  '/encounters/:id/admit',
  requirePermission('admission.write'),
  ah(async (req, res) => {
    const body = z.object({ bedId: z.string() }).parse(req.body);
    const encounterId = req.params.id;

    const result = await prisma.$transaction(async (tx) => {
      const enc = await tx.encounter.findUnique({ where: { id: encounterId }, include: { admission: true } });
      if (!enc) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt khám');
      if (enc.admission) throw new ApiError(409, 'CONFLICT', 'Lượt khám đã có hồ sơ nhập viện');

      const bed = await tx.bed.findUnique({ where: { id: body.bedId } });
      if (!bed) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy giường');
      if (bed.status !== 'EMPTY') throw new ApiError(409, 'CONFLICT', 'Giường không trống');

      const admission = await tx.admission.create({
        data: { encounterId, bedId: bed.id, status: 'ADMITTED' },
      });
      await tx.bed.update({ where: { id: bed.id }, data: { status: 'OCCUPIED' } });
      await tx.encounter.update({ where: { id: encounterId }, data: { status: 'ADMITTED', type: 'INPATIENT' } });
      return admission;
    });

    await audit(req, 'ADMIT', 'admission', result.id, { encounterId, bedId: body.bedId });
    res.status(201).json(result);
  }),
);

// Chuyển giường: giải phóng giường cũ, chiếm giường mới.
inpatientRouter.post(
  '/admissions/:id/transfer',
  requirePermission('admission.write'),
  ah(async (req, res) => {
    const body = z.object({ bedId: z.string() }).parse(req.body);
    const admissionId = req.params.id;

    const result = await prisma.$transaction(async (tx) => {
      const adm = await tx.admission.findUnique({ where: { id: admissionId } });
      if (!adm) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hồ sơ nhập viện');
      if (adm.status !== 'ADMITTED') throw new ApiError(409, 'CONFLICT', 'Hồ sơ không ở trạng thái đang điều trị');
      if (adm.bedId === body.bedId) throw new ApiError(409, 'CONFLICT', 'Đã ở giường này');

      const newBed = await tx.bed.findUnique({ where: { id: body.bedId } });
      if (!newBed) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy giường');
      if (newBed.status !== 'EMPTY') throw new ApiError(409, 'CONFLICT', 'Giường không trống');

      if (adm.bedId) await tx.bed.update({ where: { id: adm.bedId }, data: { status: 'EMPTY' } });
      await tx.bed.update({ where: { id: newBed.id }, data: { status: 'OCCUPIED' } });
      return tx.admission.update({ where: { id: admissionId }, data: { bedId: newBed.id } });
    });

    await audit(req, 'TRANSFER', 'admission', admissionId, { bedId: body.bedId });
    res.json(result);
  }),
);

// Xuất viện: đóng hồ sơ, giải phóng giường, kết thúc lượt khám.
inpatientRouter.post(
  '/admissions/:id/discharge',
  requirePermission('admission.write'),
  ah(async (req, res) => {
    const admissionId = req.params.id;

    const result = await prisma.$transaction(async (tx) => {
      const adm = await tx.admission.findUnique({ where: { id: admissionId } });
      if (!adm) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hồ sơ nhập viện');
      if (adm.status === 'DISCHARGED') throw new ApiError(409, 'CONFLICT', 'Hồ sơ đã xuất viện');

      if (adm.bedId) await tx.bed.update({ where: { id: adm.bedId }, data: { status: 'EMPTY' } });
      await tx.encounter.update({ where: { id: adm.encounterId }, data: { status: 'DISCHARGED' } });
      return tx.admission.update({
        where: { id: admissionId },
        data: { status: 'DISCHARGED', dischargeAt: new Date() },
      });
    });

    await audit(req, 'DISCHARGE', 'admission', admissionId);
    res.json(result);
  }),
);

// Danh sách hồ sơ nhập viện.
inpatientRouter.get(
  '/admissions',
  requirePermission('admission.write', 'care.write', 'vitals.read'),
  ah(async (req, res) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const admissions = await prisma.admission.findMany({
      where: q.status ? { status: q.status } : undefined,
      include: { bed: true, encounter: { include: { patient: true } } },
      orderBy: { admitAt: 'desc' },
    });
    res.json(admissions);
  }),
);

// ============ Chăm sóc nội trú (care.write) ============

inpatientRouter.get(
  '/admissions/:id/care-tasks',
  requirePermission('care.write'),
  ah(async (req, res) => {
    const tasks = await prisma.careTask.findMany({
      where: { admissionId: req.params.id },
      orderBy: { scheduledAt: 'asc' },
    });
    res.json(tasks);
  }),
);

inpatientRouter.post(
  '/admissions/:id/care-tasks',
  requirePermission('care.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        type: z.string(),
        scheduledAt: z.coerce.date().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);
    const admissionId = req.params.id;
    const adm = await prisma.admission.findUnique({ where: { id: admissionId } });
    if (!adm) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hồ sơ nhập viện');
    const task = await prisma.careTask.create({
      data: {
        admissionId,
        nurseId: getUser(req).id,
        type: body.type,
        scheduledAt: body.scheduledAt,
        note: body.note,
      },
    });
    await audit(req, 'CREATE', 'care_task', task.id, { admissionId });
    res.status(201).json(task);
  }),
);

inpatientRouter.post(
  '/care-tasks/:id/done',
  requirePermission('care.write'),
  ah(async (req, res) => {
    const task = await prisma.careTask.findUnique({ where: { id: req.params.id } });
    if (!task) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy công việc chăm sóc');
    const updated = await prisma.careTask.update({
      where: { id: req.params.id },
      data: { doneAt: new Date(), nurseId: task.nurseId ?? getUser(req).id },
    });
    await audit(req, 'DONE', 'care_task', updated.id);
    res.json(updated);
  }),
);

// ============ Sinh hiệu (vitals.read xem; care.write ghi tay) ============

inpatientRouter.get(
  '/admissions/:id/vitals',
  requirePermission('vitals.read'),
  ah(async (req, res) => {
    const vitals = await prisma.vitalSign.findMany({
      where: { admissionId: req.params.id },
      orderBy: { measuredAt: 'desc' },
    });
    res.json(vitals);
  }),
);

inpatientRouter.post(
  '/admissions/:id/vitals',
  requirePermission('care.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        hr: z.number().optional(),
        spo2: z.number().optional(),
        temp: z.number().optional(),
        bpSys: z.number().optional(),
        bpDia: z.number().optional(),
        measuredAt: z.coerce.date().optional(),
      })
      .parse(req.body);
    const admissionId = req.params.id;
    const adm = await prisma.admission.findUnique({ where: { id: admissionId } });
    if (!adm) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hồ sơ nhập viện');
    const vital = await prisma.vitalSign.create({
      data: {
        admissionId,
        bedId: adm.bedId,
        hr: body.hr,
        spo2: body.spo2,
        temp: body.temp,
        bpSys: body.bpSys,
        bpDia: body.bpDia,
        measuredAt: body.measuredAt ?? new Date(),
        source: 'MANUAL',
      },
    });
    await audit(req, 'CREATE', 'vital_sign', vital.id, { admissionId });
    res.status(201).json(vital);
  }),
);

// ============ Sơ đồ giường & nguồn lực (bed.read / resource.write) ============

// Sơ đồ giường kèm trạng thái + bệnh nhân đang nằm nếu OCCUPIED.
inpatientRouter.get(
  '/beds',
  requirePermission('bed.read'),
  ah(async (req, res) => {
    const q = z.object({ departmentId: z.string().optional() }).parse(req.query);
    const beds = await prisma.bed.findMany({
      where: q.departmentId ? { departmentId: q.departmentId } : undefined,
      include: {
        department: true,
        admissions: {
          where: { status: 'ADMITTED' },
          include: { encounter: { include: { patient: true } } },
        },
      },
      orderBy: { code: 'asc' },
    });
    const result = beds.map((b) => {
      const active = b.status === 'OCCUPIED' ? b.admissions[0] : undefined;
      return {
        id: b.id,
        code: b.code,
        status: b.status,
        departmentId: b.departmentId,
        department: b.department,
        patient: active?.encounter?.patient ?? null,
        admissionId: active?.id ?? null,
      };
    });
    res.json(result);
  }),
);

// Cây khoa / phòng / buồng.
inpatientRouter.get(
  '/departments',
  requirePermission('bed.read'),
  ah(async (_req, res) => {
    const depts = await prisma.department.findMany({ orderBy: { code: 'asc' } });
    const byId = new Map(depts.map((d) => [d.id, { ...d, children: [] as any[] }]));
    const roots: any[] = [];
    for (const d of byId.values()) {
      if (d.parentId && byId.has(d.parentId)) byId.get(d.parentId)!.children.push(d);
      else roots.push(d);
    }
    res.json(roots);
  }),
);

// ---- Thiết bị y tế (MedicalDevice) ----

inpatientRouter.get(
  '/devices',
  requirePermission('bed.read'),
  ah(async (req, res) => {
    const q = z.object({ departmentId: z.string().optional(), status: z.string().optional() }).parse(req.query);
    const devices = await prisma.medicalDevice.findMany({
      where: {
        ...(q.departmentId ? { departmentId: q.departmentId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { code: 'asc' },
    });
    res.json(devices);
  }),
);

inpatientRouter.post(
  '/devices',
  requirePermission('resource.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        code: z.string(),
        name: z.string(),
        departmentId: z.string().optional(),
        status: z.string().optional(),
        nextMaintenance: z.coerce.date().optional(),
      })
      .parse(req.body);
    const device = await prisma.medicalDevice.create({
      data: {
        code: body.code,
        name: body.name,
        departmentId: body.departmentId,
        status: body.status ?? 'ACTIVE',
        nextMaintenance: body.nextMaintenance,
      },
    });
    await audit(req, 'CREATE', 'medical_device', device.id, { code: body.code });
    res.status(201).json(device);
  }),
);

inpatientRouter.patch(
  '/devices/:id',
  requirePermission('resource.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        name: z.string().optional(),
        departmentId: z.string().optional(),
        status: z.string().optional(),
        nextMaintenance: z.coerce.date().optional(),
      })
      .parse(req.body);
    const exists = await prisma.medicalDevice.findUnique({ where: { id: req.params.id } });
    if (!exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thiết bị');
    const device = await prisma.medicalDevice.update({ where: { id: req.params.id }, data: body });
    await audit(req, 'UPDATE', 'medical_device', device.id, body);
    res.json(device);
  }),
);

// Xóa thiết bị y tế (không có bảng tham chiếu nên xóa cứng trực tiếp).
inpatientRouter.delete(
  '/devices/:id',
  requirePermission('resource.write'),
  ah(async (req, res) => {
    const exists = await prisma.medicalDevice.findUnique({ where: { id: req.params.id } });
    if (!exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thiết bị');
    await prisma.medicalDevice.delete({ where: { id: req.params.id } });
    await audit(req, 'DELETE', 'medical_device', req.params.id);
    res.json({ ok: true });
  }),
);

// ---- Lịch trực (DutyRoster) ----

inpatientRouter.get(
  '/rosters',
  requirePermission('bed.read'),
  ah(async (req, res) => {
    const q = z.object({ departmentId: z.string().optional() }).parse(req.query);
    const rosters = await prisma.dutyRoster.findMany({
      where: q.departmentId ? { departmentId: q.departmentId } : undefined,
      orderBy: { date: 'desc' },
    });
    res.json(rosters);
  }),
);

inpatientRouter.post(
  '/rosters',
  requirePermission('resource.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        departmentId: z.string(),
        staffId: z.string(),
        shift: z.string(),
        date: z.coerce.date(),
      })
      .parse(req.body);
    const roster = await prisma.dutyRoster.create({ data: body });
    await audit(req, 'CREATE', 'duty_roster', roster.id, { departmentId: body.departmentId });
    res.status(201).json(roster);
  }),
);

// Xóa lịch trực (không có tham chiếu, xóa cứng trực tiếp).
inpatientRouter.delete(
  '/rosters/:id',
  requirePermission('resource.write'),
  ah(async (req, res) => {
    const exists = await prisma.dutyRoster.findUnique({ where: { id: req.params.id } });
    if (!exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lịch trực');
    await prisma.dutyRoster.delete({ where: { id: req.params.id } });
    await audit(req, 'DELETE', 'duty_roster', req.params.id);
    res.json({ ok: true });
  }),
);
