import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requirePermission, scopeDepartmentFilter } from '../core/auth.js';
import { ah, audit, getUser, ApiError } from '../core/helpers.js';

export const clinicalRouter = Router();

// Bộ nhớ tạm cho Idempotency-Key khi ký đơn thuốc (bản demo, theo tiến trình).
const signIdempotency = new Map<string, { prescriptionId: string }>();

// Sinh mã người bệnh dạng PID + năm + số tăng dần (6 chữ số), ví dụ PID2026000001.
async function nextPatientCode(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `PID${year}`;
  // Chỉ xét mã có phần đuôi TOÀN SỐ (bỏ qua mã demo dạng PID2026Dxxxxx).
  const candidates = await prisma.patient.findMany({
    where: { code: { startsWith: prefix } },
    select: { code: true },
  });
  let max = 0;
  for (const c of candidates) {
    const tail = c.code.slice(prefix.length);
    if (/^\d+$/.test(tail)) max = Math.max(max, Number(tail));
  }
  return `${prefix}${String(max + 1).padStart(6, '0')}`;
}

// Khoảng thời gian trong ngày hiện tại, phục vụ cấp số thứ tự theo khoa/ngày.
function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

// ============ Người bệnh (patient.read / patient.write) ============
clinicalRouter.get(
  '/patients',
  requirePermission('patient.read'),
  ah(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const where = q
      ? {
          OR: [
            { fullName: { contains: q } },
            { code: { contains: q } },
            { phone: { contains: q } },
            { cccd: { contains: q } },
            { bhytCardNo: { contains: q } },
          ],
        }
      : {};
    const patients = await prisma.patient.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ data: patients });
  }),
);

clinicalRouter.get(
  '/patients/:id',
  requirePermission('patient.read'),
  ah(async (req, res) => {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy người bệnh');
    res.json({ data: patient });
  }),
);

clinicalRouter.post(
  '/patients',
  requirePermission('patient.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        fullName: z.string().min(1),
        dob: z.coerce.date().optional(),
        gender: z.string().optional(),
        address: z.string().optional(),
        phone: z.string().optional(),
        cccd: z.string().optional(),
        bhytCardNo: z.string().optional(),
        bhytValidTo: z.coerce.date().optional(),
      })
      .parse(req.body);
    const code = await nextPatientCode();
    const patient = await prisma.patient.create({ data: { code, ...body } });
    await audit(req, 'CREATE', 'patient', patient.id, { code });
    res.status(201).json({ data: patient });
  }),
);

clinicalRouter.patch(
  '/patients/:id',
  requirePermission('patient.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        fullName: z.string().min(1).optional(),
        dob: z.coerce.date().optional(),
        gender: z.string().optional(),
        address: z.string().optional(),
        phone: z.string().optional(),
        cccd: z.string().optional(),
        bhytCardNo: z.string().optional(),
        bhytValidTo: z.coerce.date().optional(),
      })
      .parse(req.body);
    const exists = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!exists) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy người bệnh');
    const patient = await prisma.patient.update({ where: { id: req.params.id }, data: body });
    await audit(req, 'UPDATE', 'patient', patient.id, body);
    res.json({ data: patient });
  }),
);

// Kiểm tra BHYT — MÔ PHỎNG adapter, không gọi cổng thật.
clinicalRouter.get(
  '/patients/:id/bhyt-check',
  requirePermission('patient.read'),
  ah(async (req, res) => {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy người bệnh');
    res.json({
      valid: true,
      source: 'MOCK',
      note: 'adapter mô phỏng',
      cardNo: patient.bhytCardNo ?? null,
    });
  }),
);

// ============ Lượt khám (encounter.*) ============
clinicalRouter.get(
  '/encounters',
  requirePermission('encounter.read'),
  ah(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const departmentId = typeof req.query.departmentId === 'string' ? req.query.departmentId : undefined;
    const encounters = await prisma.encounter.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(departmentId ? { departmentId } : {}),
        ...scopeDepartmentFilter(getUser(req)),
      },
      orderBy: { createdAt: 'desc' },
      include: { patient: true },
      take: 200,
    });
    res.json({ data: encounters });
  }),
);

clinicalRouter.get(
  '/encounters/queue',
  requirePermission('encounter.read'),
  ah(async (req, res) => {
    const departmentId = typeof req.query.departmentId === 'string' ? req.query.departmentId : undefined;
    const encounters = await prisma.encounter.findMany({
      where: {
        status: 'WAITING',
        ...(departmentId ? { departmentId } : {}),
        ...scopeDepartmentFilter(getUser(req)),
      },
      orderBy: { queueNo: 'asc' },
      include: { patient: true },
    });
    res.json({ data: encounters });
  }),
);

clinicalRouter.post(
  '/encounters',
  requirePermission('encounter.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        patientId: z.string().min(1),
        type: z.enum(['OUTPATIENT', 'INPATIENT']).default('OUTPATIENT'),
        departmentId: z.string().optional(),
        doctorId: z.string().optional(),
      })
      .parse(req.body);
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy người bệnh');

    // Cấp số thứ tự = max theo khoa/ngày + 1.
    const { start, end } = todayRange();
    const top = await prisma.encounter.findFirst({
      where: { departmentId: body.departmentId ?? null, createdAt: { gte: start, lt: end } },
      orderBy: { queueNo: 'desc' },
    });
    const queueNo = (top?.queueNo ?? 0) + 1;

    const encounter = await prisma.encounter.create({
      data: { ...body, queueNo, status: 'WAITING' },
    });
    await audit(req, 'CREATE', 'encounter', encounter.id, { queueNo });
    res.status(201).json({ data: encounter });
  }),
);

clinicalRouter.post(
  '/encounters/:id/exam',
  requirePermission('encounter.exam'),
  ah(async (req, res) => {
    const body = z
      .object({
        icd10: z.array(z.string().min(1)).default([]),
        note: z.string().optional(),
      })
      .parse(req.body);
    const encounter = await prisma.encounter.findUnique({ where: { id: req.params.id } });
    if (!encounter) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt khám');
    if (encounter.status === 'DONE') throw new ApiError(409, 'CONFLICT', 'Lượt khám đã kết thúc');
    const user = getUser(req);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.encounter.update({
        where: { id: encounter.id },
        data: { status: 'IN_EXAM', doctorId: encounter.doctorId ?? user.id },
      });
      if (body.icd10.length) {
        await tx.diagnosis.deleteMany({ where: { encounterId: encounter.id } });
        await tx.diagnosis.createMany({
          data: body.icd10.map((code, i) => ({
            encounterId: encounter.id,
            icd10Code: code,
            type: i === 0 ? 'PRIMARY' : 'SECONDARY',
            note: body.note,
          })),
        });
      }
      return tx.encounter.findUniqueOrThrow({ where: { id: encounter.id }, include: { diagnoses: true } });
    });
    await audit(req, 'EXAM', 'encounter', encounter.id, { icd10: body.icd10 });
    res.json({ data: updated });
  }),
);

clinicalRouter.post(
  '/encounters/:id/done',
  requirePermission('encounter.exam'),
  ah(async (req, res) => {
    const encounter = await prisma.encounter.findUnique({ where: { id: req.params.id } });
    if (!encounter) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt khám');
    const updated = await prisma.encounter.update({
      where: { id: encounter.id },
      data: { status: 'DONE' },
    });
    await audit(req, 'DONE', 'encounter', encounter.id);
    res.json({ data: updated });
  }),
);

// ============ Chỉ định CLS (order.write) ============
clinicalRouter.post(
  '/encounters/:id/orders',
  requirePermission('order.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        type: z.enum(['LAB', 'IMAGING']),
        serviceId: z.string().optional(),
      })
      .parse(req.body);
    const encounter = await prisma.encounter.findUnique({ where: { id: req.params.id } });
    if (!encounter) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt khám');
    const order = await prisma.order.create({
      data: { encounterId: encounter.id, type: body.type, serviceId: body.serviceId, status: 'ORDERED' },
    });
    await audit(req, 'CREATE', 'order', order.id, { type: body.type });
    res.status(201).json({ data: order });
  }),
);

clinicalRouter.get(
  '/encounters/:id/orders',
  requirePermission('order.write', 'encounter.read'),
  ah(async (req, res) => {
    const orders = await prisma.order.findMany({ where: { encounterId: req.params.id } });
    res.json({ data: orders });
  }),
);

// Nhận kết quả CLS — MÔ PHỎNG LIS/RIS.
clinicalRouter.post(
  '/orders/:id/result',
  requirePermission('order.write'),
  ah(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy chỉ định');
    const user = getUser(req);
    const resultJson = {
      source: 'MOCK',
      system: order.type === 'LAB' ? 'LIS' : 'RIS',
      note: 'kết quả mô phỏng',
      items:
        order.type === 'LAB'
          ? [{ name: 'WBC', value: 7.2, unit: '10^9/L', flag: 'N' }]
          : [{ name: 'Kết luận', value: 'Không phát hiện bất thường' }],
    };
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'RESULTED',
        resultJson: JSON.stringify(resultJson),
        verifiedBy: user.id,
        verifiedAt: new Date(),
      },
    });
    await audit(req, 'RESULT', 'order', order.id, { source: 'MOCK' });
    res.json({ data: updated, source: 'MOCK' });
  }),
);

// ============ Đơn thuốc (encounter.prescribe) ============
clinicalRouter.post(
  '/encounters/:id/prescriptions',
  requirePermission('encounter.prescribe'),
  ah(async (req, res) => {
    const encounter = await prisma.encounter.findUnique({ where: { id: req.params.id } });
    if (!encounter) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt khám');
    const user = getUser(req);
    const prescription = await prisma.prescription.create({
      data: { encounterId: encounter.id, doctorId: user.id, status: 'DRAFT' },
    });
    await audit(req, 'CREATE', 'prescription', prescription.id);
    res.status(201).json({ data: prescription });
  }),
);

clinicalRouter.post(
  '/prescriptions/:id/items',
  requirePermission('encounter.prescribe'),
  ah(async (req, res) => {
    const body = z
      .object({
        drugId: z.string().min(1),
        dose: z.string().min(1),
        frequency: z.string().min(1),
        durationDays: z.coerce.number().int().positive(),
        quantity: z.coerce.number().int().positive().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);
    const prescription = await prisma.prescription.findUnique({ where: { id: req.params.id } });
    if (!prescription) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy đơn thuốc');
    if (prescription.status !== 'DRAFT') {
      throw new ApiError(409, 'CONFLICT', 'Đơn đã ký, không thể thêm thuốc');
    }
    const drug = await prisma.drug.findUnique({ where: { id: body.drugId } });
    if (!drug) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thuốc');

    // Tự tính số lượng nếu thiếu: lần/ngày (số đầu tiên trong frequency) * số ngày.
    let quantity = body.quantity;
    if (quantity == null) {
      const perDay = Number((body.frequency.match(/\d+/) ?? ['1'])[0]) || 1;
      quantity = perDay * body.durationDays;
    }
    const item = await prisma.prescriptionItem.create({
      data: {
        prescriptionId: prescription.id,
        drugId: body.drugId,
        dose: body.dose,
        frequency: body.frequency,
        durationDays: body.durationDays,
        quantity,
        note: body.note,
      },
    });
    await audit(req, 'ADD_ITEM', 'prescription', prescription.id, { drugId: body.drugId, quantity });
    res.status(201).json({ data: item });
  }),
);

// Kiểm tra tương tác thuốc — AI MÔ PHỎNG, ghi log AiRequest (U05.4).
clinicalRouter.post(
  '/prescriptions/:id/check-interaction',
  requirePermission('encounter.prescribe'),
  ah(async (req, res) => {
    const prescription = await prisma.prescription.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { drug: true } } },
    });
    if (!prescription) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy đơn thuốc');

    const codes = new Set(prescription.items.map((it) => it.drug.code));
    // Luật demo đơn giản, KHÔNG phải tri thức y khoa thực tế.
    const warnings: { pair: string[]; severity: string; note: string }[] = [];
    if (codes.has('AMOX500') && codes.has('OME20')) {
      warnings.push({
        pair: ['AMOX500', 'OME20'],
        severity: 'MINOR',
        note: 'Cảnh báo demo (mô phỏng), không phải tư vấn y khoa',
      });
    }

    const started = Date.now();
    await prisma.aiRequest.create({
      data: {
        featureCode: 'U05.4',
        request: JSON.stringify({ drugCodes: [...codes] }),
        response: JSON.stringify(warnings),
        status: 'DONE',
        latencyMs: Date.now() - started,
        provider: 'mock',
      },
    });
    await audit(req, 'CHECK_INTERACTION', 'prescription', prescription.id, { count: warnings.length });
    res.json({ data: warnings, source: 'MOCK' });
  }),
);

clinicalRouter.post(
  '/prescriptions/:id/sign',
  requirePermission('encounter.prescribe'),
  ah(async (req, res) => {
    const idemKey = req.header('Idempotency-Key') ?? undefined;
    if (idemKey) {
      const cached = signIdempotency.get(idemKey);
      if (cached) {
        const presc = await prisma.prescription.findUnique({ where: { id: cached.prescriptionId } });
        return res.json({ data: presc, idempotentReplay: true });
      }
    }

    const prescription = await prisma.prescription.findUnique({ where: { id: req.params.id } });
    if (!prescription) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy đơn thuốc');
    if (prescription.status === 'SIGNED') {
      throw new ApiError(409, 'CONFLICT', 'Đơn thuốc đã được ký');
    }

    const signed = await prisma.prescription.update({
      where: { id: prescription.id },
      data: { status: 'SIGNED', signedAt: new Date() },
    });
    if (idemKey) signIdempotency.set(idemKey, { prescriptionId: signed.id });
    await audit(req, 'SIGN', 'prescription', signed.id);
    res.json({ data: signed });
  }),
);

clinicalRouter.get(
  '/prescriptions/:id',
  requirePermission('encounter.prescribe', 'encounter.read'),
  ah(async (req, res) => {
    const prescription = await prisma.prescription.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { drug: true } } },
    });
    if (!prescription) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy đơn thuốc');
    res.json({ data: prescription });
  }),
);

// ============ Bệnh án (emr.*) ============
clinicalRouter.get(
  '/encounters/:id/medical-record',
  requirePermission('emr.read'),
  ah(async (req, res) => {
    const encounter = await prisma.encounter.findUnique({ where: { id: req.params.id } });
    if (!encounter) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt khám');
    let record = await prisma.medicalRecord.findFirst({ where: { encounterId: encounter.id } });
    if (!record) {
      record = await prisma.medicalRecord.create({
        data: { patientId: encounter.patientId, encounterId: encounter.id, status: 'OPEN' },
      });
      await audit(req, 'CREATE', 'medical_record', record.id);
    }
    res.json({ data: record });
  }),
);

clinicalRouter.patch(
  '/medical-records/:id',
  requirePermission('emr.read'),
  ah(async (req, res) => {
    const body = z.object({ summary: z.string() }).parse(req.body);
    const record = await prisma.medicalRecord.findUnique({ where: { id: req.params.id } });
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy bệnh án');
    if (record.status !== 'OPEN') {
      throw new ApiError(409, 'CONFLICT', 'Bệnh án đã ký, không thể sửa');
    }
    const updated = await prisma.medicalRecord.update({
      where: { id: record.id },
      data: { summary: body.summary },
    });
    await audit(req, 'UPDATE', 'medical_record', record.id);
    res.json({ data: updated });
  }),
);

clinicalRouter.post(
  '/medical-records/:id/sign',
  requirePermission('emr.sign'),
  ah(async (req, res) => {
    const record = await prisma.medicalRecord.findUnique({ where: { id: req.params.id } });
    if (!record) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy bệnh án');
    if (record.status === 'SIGNED') {
      throw new ApiError(409, 'CONFLICT', 'Bệnh án đã được ký');
    }
    const user = getUser(req);
    const signed = await prisma.medicalRecord.update({
      where: { id: record.id },
      data: { status: 'SIGNED', signedBy: user.id, signedAt: new Date() },
    });
    await audit(req, 'SIGN', 'medical_record', record.id);
    res.json({ data: signed });
  }),
);

// ============ Lịch hẹn (U02.2) — patient.read / patient.write ============
clinicalRouter.get(
  '/appointments',
  requirePermission('patient.read'),
  ah(async (req, res) => {
    const patientId = typeof req.query.patientId === 'string' ? req.query.patientId : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const appointments = await prisma.appointment.findMany({
      where: { ...(patientId ? { patientId } : {}), ...(status ? { status } : {}) },
      orderBy: { scheduledAt: 'asc' },
      include: { patient: true },
      take: 200,
    });
    res.json({ data: appointments });
  }),
);

clinicalRouter.post(
  '/appointments',
  requirePermission('patient.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        patientId: z.string().min(1),
        departmentId: z.string().optional(),
        scheduledAt: z.coerce.date(),
        channel: z.enum(['ONLINE', 'COUNTER']).default('ONLINE'),
      })
      .parse(req.body);
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy người bệnh');
    const appointment = await prisma.appointment.create({
      data: {
        patientId: body.patientId,
        departmentId: body.departmentId ?? null,
        scheduledAt: body.scheduledAt,
        channel: body.channel,
        status: 'BOOKED',
      },
    });
    await audit(req, 'CREATE', 'appointment', appointment.id, { patientId: body.patientId });
    res.status(201).json({ data: appointment });
  }),
);

clinicalRouter.post(
  '/appointments/:id/cancel',
  requirePermission('patient.write'),
  ah(async (req, res) => {
    const appointment = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!appointment) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lịch hẹn');
    if (appointment.status === 'CANCELLED') throw new ApiError(409, 'CONFLICT', 'Lịch hẹn đã hủy');
    if (appointment.status === 'DONE') throw new ApiError(409, 'CONFLICT', 'Lịch hẹn đã tiếp nhận');
    const updated = await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: 'CANCELLED' },
    });
    await audit(req, 'CANCEL', 'appointment', appointment.id);
    res.json({ data: updated });
  }),
);

// Tiếp nhận từ lịch hẹn: tạo lượt khám WAITING + cấp số thứ tự, lịch hẹn chuyển DONE.
clinicalRouter.post(
  '/appointments/:id/check-in',
  requirePermission('patient.write'),
  ah(async (req, res) => {
    const appointment = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!appointment) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lịch hẹn');
    if (appointment.status === 'DONE') throw new ApiError(409, 'CONFLICT', 'Lịch hẹn đã tiếp nhận');
    if (appointment.status === 'CANCELLED') throw new ApiError(409, 'CONFLICT', 'Lịch hẹn đã hủy');

    const { start, end } = todayRange();
    const result = await prisma.$transaction(async (tx) => {
      const top = await tx.encounter.findFirst({
        where: { departmentId: appointment.departmentId ?? null, createdAt: { gte: start, lt: end } },
        orderBy: { queueNo: 'desc' },
      });
      const queueNo = (top?.queueNo ?? 0) + 1;
      const encounter = await tx.encounter.create({
        data: {
          patientId: appointment.patientId,
          type: 'OUTPATIENT',
          departmentId: appointment.departmentId ?? undefined,
          queueNo,
          status: 'WAITING',
        },
      });
      await tx.appointment.update({ where: { id: appointment.id }, data: { status: 'DONE' } });
      return { encounter, queueNo };
    });
    await audit(req, 'CHECK_IN', 'appointment', appointment.id, {
      encounterId: result.encounter.id,
      queueNo: result.queueNo,
    });
    res.status(201).json({ data: result.encounter });
  }),
);

// ============ Lịch sử điều trị theo người bệnh (U03.2) — encounter.read ============
clinicalRouter.get(
  '/patients/:id/history',
  requirePermission('encounter.read'),
  ah(async (req, res) => {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy người bệnh');
    const encounters = await prisma.encounter.findMany({
      where: { patientId: patient.id },
      orderBy: { createdAt: 'desc' },
      include: {
        diagnoses: true,
        orders: true,
        prescriptions: { include: { items: { include: { drug: true } } } },
        medicalRecords: true,
      },
    });
    res.json({ data: { patient, encounters } });
  }),
);
