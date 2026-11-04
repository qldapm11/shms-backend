// Cổng người bệnh trực tuyến (U11) — người bệnh chỉ xem dữ liệu của CHÍNH MÌNH.
// Liên kết user↔patient qua ConfigParam key `patient.link.<userId>`.
import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, getUser, ApiError } from '../core/helpers.js';

export const portalRouter = Router();

// Lấy patientId gắn với user hiện tại; lỗi nếu chưa liên kết.
async function linkedPatientId(userId: string): Promise<string> {
  const cfg = await prisma.configParam.findUnique({ where: { key: `patient.link.${userId}` } });
  if (!cfg) throw new ApiError(403, 'FORBIDDEN', 'Tài khoản chưa liên kết hồ sơ người bệnh');
  return cfg.value;
}

// Hồ sơ của tôi
portalRouter.get(
  '/portal/me',
  ah(async (req, res) => {
    const pid = await linkedPatientId(getUser(req).id);
    const patient = await prisma.patient.findUniqueOrThrow({ where: { id: pid } });
    res.json({ data: patient });
  }),
);

// Lịch hẹn của tôi
portalRouter.get(
  '/portal/appointments',
  ah(async (req, res) => {
    const pid = await linkedPatientId(getUser(req).id);
    const appts = await prisma.appointment.findMany({ where: { patientId: pid }, orderBy: { scheduledAt: 'desc' } });
    res.json({ data: appts });
  }),
);

// Đặt lịch hẹn mới (người bệnh tự đặt)
portalRouter.post(
  '/portal/appointments',
  ah(async (req, res) => {
    const pid = await linkedPatientId(getUser(req).id);
    const { departmentId, scheduledAt } = req.body || {};
    if (!scheduledAt) throw new ApiError(400, 'VALIDATION_ERROR', 'Thiếu thời gian hẹn');
    const appt = await prisma.appointment.create({
      data: { patientId: pid, departmentId: departmentId || null, scheduledAt: new Date(scheduledAt), channel: 'ONLINE', status: 'BOOKED' },
    });
    res.status(201).json({ data: appt });
  }),
);

// Lượt khám & kết quả của tôi
portalRouter.get(
  '/portal/encounters',
  ah(async (req, res) => {
    const pid = await linkedPatientId(getUser(req).id);
    const encs = await prisma.encounter.findMany({
      where: { patientId: pid },
      include: { diagnoses: true, orders: true, prescriptions: { include: { items: { include: { drug: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: encs });
  }),
);

// Hóa đơn của tôi
portalRouter.get(
  '/portal/invoices',
  ah(async (req, res) => {
    const pid = await linkedPatientId(getUser(req).id);
    const invoices = await prisma.invoice.findMany({
      where: { encounter: { patientId: pid } },
      include: { items: true, payments: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: invoices });
  }),
);
