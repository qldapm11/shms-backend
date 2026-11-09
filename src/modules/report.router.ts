import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authMiddleware, requirePermission } from '../core/auth.js';
import { ah, audit, getUser, ApiError, findUsersWithPermission, notifyUsers } from '../core/helpers.js';

export const reportRouter = Router();

// Mọi route cần đăng nhập.
reportRouter.use(authMiddleware);

// Khoảng thời gian 1 ngày hôm nay (local server time).
function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

// ============ DASHBOARD & BÁO CÁO (report.read) ============

reportRouter.get(
  '/reports/dashboard',
  requirePermission('report.read'),
  ah(async (_req, res) => {
    const { start, end } = todayRange();

    const [
      patientsToday,
      encountersToday,
      encByStatus,
      bedsByStatus,
      revenueTotal,
      revenueToday,
      prescriptionsPending,
    ] = await Promise.all([
      // Số người bệnh riêng biệt có lượt khám tạo hôm nay.
      prisma.encounter
        .findMany({
          where: { createdAt: { gte: start, lt: end } },
          distinct: ['patientId'],
          select: { patientId: true },
        })
        .then((rows) => rows.length),
      prisma.encounter.count({ where: { createdAt: { gte: start, lt: end } } }),
      prisma.encounter.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.bed.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.payment.aggregate({ _sum: { amount: true } }),
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { paidAt: { gte: start, lt: end } },
      }),
      // Đơn thuốc đã ký, chưa cấp phát = chờ cấp phát.
      prisma.prescription.count({ where: { status: 'SIGNED' } }),
    ]);

    const encounterByStatus: Record<string, number> = {};
    for (const r of encByStatus) encounterByStatus[r.status] = r._count._all;

    const bedByStatus: Record<string, number> = {};
    for (const r of bedsByStatus) bedByStatus[r.status] = r._count._all;

    res.json({
      generatedAt: new Date().toISOString(),
      patients: { today: patientsToday },
      encounters: { today: encountersToday, byStatus: encounterByStatus },
      beds: {
        empty: bedByStatus['EMPTY'] ?? 0,
        occupied: bedByStatus['OCCUPIED'] ?? 0,
        reserved: bedByStatus['RESERVED'] ?? 0,
        maintenance: bedByStatus['MAINT'] ?? 0,
        byStatus: bedByStatus,
      },
      revenue: {
        total: revenueTotal._sum.amount ?? 0,
        today: revenueToday._sum.amount ?? 0,
      },
      prescriptions: { pendingDispense: prescriptionsPending },
    });
  }),
);

// Báo cáo theo khoa: nhóm encounter theo departmentId trong [from, to).
async function departmentReport(from?: string, to?: string) {
  const where: any = {};
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lt = new Date(to);
  }
  const grouped = await prisma.encounter.groupBy({
    by: ['departmentId'],
    where,
    _count: { _all: true },
  });
  const deptIds = grouped
    .map((g) => g.departmentId)
    .filter((d): d is string => !!d);
  const depts = deptIds.length
    ? await prisma.department.findMany({
        where: { id: { in: deptIds } },
        select: { id: true, code: true, name: true },
      })
    : [];
  const deptMap = new Map(depts.map((d) => [d.id, d]));
  return grouped.map((g) => {
    const d = g.departmentId ? deptMap.get(g.departmentId) : undefined;
    return {
      departmentId: g.departmentId,
      code: d?.code ?? null,
      name: d?.name ?? (g.departmentId ? '(không rõ)' : '(chưa phân khoa)'),
      encounters: g._count._all,
    };
  });
}

reportRouter.get(
  '/reports/by-department',
  requirePermission('report.read'),
  ah(async (req, res) => {
    const q = z
      .object({ from: z.string().optional(), to: z.string().optional() })
      .parse(req.query);
    const rows = await departmentReport(q.from, q.to);
    res.json({ from: q.from ?? null, to: q.to ?? null, rows });
  }),
);

// Escape CSV cơ bản: bọc dấu ngoặc kép khi có phẩy/ngoặc kép/xuống dòng.
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

reportRouter.get(
  '/reports/export',
  requirePermission('report.read'),
  ah(async (req, res) => {
    const q = z
      .object({
        format: z.enum(['csv', 'json']).default('csv'),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(req.query);
    const rows = await departmentReport(q.from, q.to);
    await audit(req, 'REPORT_EXPORT', 'report', 'by-department', { format: q.format });

    if (q.format === 'json') {
      res.json({ from: q.from ?? null, to: q.to ?? null, rows });
      return;
    }

    const header = ['departmentId', 'code', 'name', 'encounters'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [r.departmentId, r.code, r.name, r.encounters].map(csvCell).join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="report-by-department.csv"',
    );
    res.send(lines.join('\n'));
  }),
);

// ============ THÔNG BÁO (user đã đăng nhập, của chính mình) ============

reportRouter.get(
  '/notifications',
  ah(async (req, res) => {
    const user = getUser(req);
    const q = z
      .object({
        unread: z
          .enum(['true', 'false'])
          .optional()
          .transform((v) => v === 'true'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const where: any = { userId: user.id };
    if (q.unread) where.readAt = null;
    const items = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    res.json({ items });
  }),
);

reportRouter.get(
  '/notifications/unread-count',
  ah(async (req, res) => {
    const user = getUser(req);
    const count = await prisma.notification.count({
      where: { userId: user.id, readAt: null },
    });
    res.json({ count });
  }),
);

reportRouter.post(
  '/notifications/:id/read',
  ah(async (req, res) => {
    const user = getUser(req);
    const id = z.string().parse(req.params.id);
    // Chỉ thao tác thông báo của chính mình.
    const notif = await prisma.notification.findUnique({ where: { id } });
    if (!notif || notif.userId !== user.id) {
      throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thông báo');
    }
    const updated = notif.readAt
      ? notif
      : await prisma.notification.update({
          where: { id },
          data: { readAt: new Date() },
        });
    res.json({ notification: updated });
  }),
);

reportRouter.post(
  '/notifications',
  requirePermission('admin.monitor'),
  ah(async (req, res) => {
    const actor = getUser(req);
    const body = z
      .object({
        userId: z.string().optional(),
        type: z.string().min(1),
        title: z.string().min(1),
        body: z.string().optional(),
        severity: z.enum(['INFO', 'WARN', 'CRITICAL']).default('INFO'),
      })
      .parse(req.body);

    if (body.userId) {
      // Gửi tới 1 user cụ thể.
      const target = await prisma.user.findUnique({ where: { id: body.userId } });
      if (!target) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy người nhận');
      const notif = await prisma.notification.create({
        data: {
          userId: body.userId,
          type: body.type,
          title: body.title,
          body: body.body,
          severity: body.severity,
        },
      });
      await audit(req, 'NOTIFY_CREATE', 'notification', notif.id, { userId: body.userId });
      res.status(201).json({ notification: notif });
      return;
    }

    // Broadcast cảnh báo vận hành tới mọi user đang hoạt động.
    const targets = await prisma.user.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });
    const result = await prisma.notification.createMany({
      data: targets.map((t) => ({
        userId: t.id,
        type: body.type,
        title: body.title,
        body: body.body,
        severity: body.severity,
      })),
    });
    await audit(req, 'NOTIFY_BROADCAST', 'notification', undefined, {
      count: result.count,
      by: actor.id,
    });
    res.status(201).json({ broadcast: true, count: result.count });
  }),
);

// ============ U08.1 NHẮC LỊCH + U08.2/U08.3 SINH CẢNH BÁO ============
// Các endpoint "quét" (scan) chủ động phát sinh notification. Bản demo không có cron:
// gọi qua nút trên UI hoặc lịch ngoài. Mỗi lần quét chống trùng bằng dedupeKey.

// U08.1 — Nhắc lịch hẹn trong N giờ tới (mặc định 24h). Gửi cho nhân viên tiếp đón.
reportRouter.post(
  '/notifications/scan-appointments',
  requirePermission('encounter.write', 'admin.monitor'),
  ah(async (req, res) => {
    const q = z.object({ withinHours: z.coerce.number().int().min(1).max(168).default(24) }).parse(req.query);
    const now = new Date();
    const until = new Date(now.getTime() + q.withinHours * 3600_000);
    const appts = await prisma.appointment.findMany({
      where: { status: 'BOOKED', scheduledAt: { gte: now, lte: until } },
      include: { patient: true },
      orderBy: { scheduledAt: 'asc' },
    });
    const receptionists = await findUsersWithPermission(['encounter.write']);
    let created = 0;
    for (const a of appts) {
      created += await notifyUsers(receptionists, {
        type: 'APPOINTMENT_REMINDER',
        dedupeKey: a.id,
        severity: 'INFO',
        title: `Nhắc lịch hẹn: ${a.patient.fullName}`,
        body: `Lịch hẹn lúc ${a.scheduledAt.toLocaleString('vi-VN')} (kênh ${a.channel}).`,
      });
    }
    await audit(req, 'NOTIFY_SCAN_APPT', 'notification', undefined, { appointments: appts.length, created });
    res.json({ scanned: appts.length, created });
  }),
);

// U08.2 — Cảnh báo lâm sàng: quét sinh hiệu vượt ngưỡng/mất tín hiệu, gửi điều dưỡng & bác sĩ.
reportRouter.post(
  '/notifications/scan-clinical-alerts',
  requirePermission('vitals.read', 'admin.monitor'),
  ah(async (req, res) => {
    const thresholds = await prisma.alertThreshold.findMany();
    const admissions = await prisma.admission.findMany({ where: { status: 'ADMITTED' } });
    const SIGNAL_LOST_MIN = 30;
    const now = Date.now();
    const recipients = await findUsersWithPermission(['vitals.read', 'care.write']);
    let created = 0;
    let alertCount = 0;

    for (const adm of admissions) {
      const latest = await prisma.vitalSign.findFirst({
        where: { admissionId: adm.id },
        orderBy: { measuredAt: 'desc' },
      });
      if (!latest || now - latest.measuredAt.getTime() > SIGNAL_LOST_MIN * 60_000) {
        alertCount++;
        created += await notifyUsers(recipients, {
          type: 'CLINICAL_ALERT',
          dedupeKey: `signal-lost:${adm.id}`,
          severity: 'WARN',
          title: 'Mất tín hiệu theo dõi',
          body: `Giường nhập viện ${adm.id}: ${latest ? `không có số liệu > ${SIGNAL_LOST_MIN} phút` : 'chưa có dữ liệu sinh tồn'}.`,
        });
        continue;
      }
      for (const th of thresholds) {
        const value = (latest as any)[th.metric] as number | null | undefined;
        if (value === null || value === undefined) continue;
        const underMin = th.minVal !== null && th.minVal !== undefined && value < th.minVal;
        const overMax = th.maxVal !== null && th.maxVal !== undefined && value > th.maxVal;
        if (underMin || overMax) {
          alertCount++;
          created += await notifyUsers(recipients, {
            type: 'CLINICAL_ALERT',
            dedupeKey: `threshold:${adm.id}:${th.metric}`,
            severity: th.severity === 'CRITICAL' ? 'CRITICAL' : 'WARN',
            title: `Sinh hiệu vượt ngưỡng: ${th.metric}`,
            body: `Giường nhập viện ${adm.id}: ${th.metric}=${value} (ngưỡng ${th.minVal ?? '-'}..${th.maxVal ?? '-'}).`,
          });
        }
      }
    }
    await audit(req, 'NOTIFY_SCAN_CLINICAL', 'notification', undefined, { alertCount, created });
    res.json({ admissions: admissions.length, alertCount, created });
  }),
);

// U08.3 — Cảnh báo vận hành: quét thuốc sắp hết hạn, gửi dược sĩ & quản trị.
reportRouter.post(
  '/notifications/scan-operational-alerts',
  requirePermission('pharmacy.read', 'admin.monitor'),
  ah(async (req, res) => {
    const q = z.object({ expiryDays: z.coerce.number().int().min(1).max(365).default(90) }).parse(req.query);
    const cutoff = new Date(Date.now() + q.expiryDays * 86400_000);
    const lots = await prisma.inventoryLot.findMany({
      where: { expiryDate: { lte: cutoff }, qty: { gt: 0 } },
      include: { drug: true },
      orderBy: { expiryDate: 'asc' },
    });
    const recipients = await findUsersWithPermission(['pharmacy.read', 'admin.monitor']);
    let created = 0;
    for (const lot of lots) {
      created += await notifyUsers(recipients, {
        type: 'OPERATIONAL_ALERT',
        dedupeKey: `expiry:${lot.id}`,
        severity: 'WARN',
        title: `Thuốc sắp hết hạn: ${lot.drug?.name ?? lot.drugId}`,
        body: `Lô ${lot.lotNo ?? lot.id} hết hạn ${lot.expiryDate ? lot.expiryDate.toLocaleDateString('vi-VN') : '—'}, tồn ${lot.qty}.`,
      });
    }
    await audit(req, 'NOTIFY_SCAN_OPERATIONAL', 'notification', undefined, { lots: lots.length, created });
    res.json({ lots: lots.length, created });
  }),
);
