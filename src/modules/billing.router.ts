import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requirePermission } from '../core/auth.js';
import { ah, audit, getUser, ApiError } from '../core/helpers.js';

export const billingRouter = Router();

// ============================================================
// SHMS — Viện phí (billing.*) + Dược (pharmacy.*)
// Lưu ý: mọi phần liên quan BHYT ở đây là MÔ PHỎNG cho bản demo.
// Tỷ lệ chi trả lấy từ tham số cấu hình (ConfigParam 'bhyt.coverage'),
// KHÔNG phải quy định BHYT thật.
// ============================================================

const DEMO_BHYT_NOTE =
  'Tham số cấu hình demo (ConfigParam bhyt.coverage), KHÔNG phải quy định BHYT thật';

// Đọc tỷ lệ BHYT từ cấu hình; mặc định 0.8 nếu chưa cấu hình.
async function getBhytCoverage(): Promise<number> {
  const cfg = await prisma.configParam.findUnique({ where: { key: 'bhyt.coverage' } });
  const raw = cfg ? Number(cfg.value) : NaN;
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return 0.8;
  return raw;
}

// Sinh số biên lai duy nhất (không xóa cứng, chỉ thêm mới).
function genReceiptNo(): string {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `BL-${ymd}-${rand}`;
}

// ------------------------------------------------------------
// VIỆN PHÍ
// ------------------------------------------------------------

// Tạo hóa đơn DRAFT từ dịch vụ (Order có serviceId) + thuốc (PrescriptionItem) của lượt.
billingRouter.post(
  '/encounters/:id/invoice',
  requirePermission('billing.write'),
  ah(async (req, res) => {
    const encounterId = z.string().parse(req.params.id);

    const encounter = await prisma.encounter.findUnique({
      where: { id: encounterId },
      include: {
        invoice: true,
        orders: true,
        prescriptions: { include: { items: true } },
      },
    });
    if (!encounter) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt khám');
    if (encounter.invoice) {
      throw new ApiError(422, 'BUSINESS_RULE', 'Lượt khám đã có hóa đơn');
    }

    // Dịch vụ: các Order có serviceId.
    const serviceIds = [...new Set(encounter.orders.map((o) => o.serviceId).filter((x): x is string => !!x))];
    const services = serviceIds.length
      ? await prisma.service.findMany({ where: { id: { in: serviceIds } } })
      : [];
    const serviceMap = new Map(services.map((s) => [s.id, s]));

    type NewItem = { refType: string; refId: string; qty: number; unitPrice: number; amount: number };
    const items: NewItem[] = [];

    for (const o of encounter.orders) {
      if (!o.serviceId) continue;
      const svc = serviceMap.get(o.serviceId);
      const unitPrice = svc?.price ?? 0;
      items.push({ refType: 'SERVICE', refId: o.serviceId, qty: 1, unitPrice, amount: unitPrice });
    }

    // Thuốc: gộp theo các PrescriptionItem của lượt.
    // Danh mục Drug hiện không có trường giá -> đơn giá demo = 0 (chưa có bảng giá thuốc).
    for (const presc of encounter.prescriptions) {
      for (const it of presc.items) {
        const unitPrice = 0;
        items.push({ refType: 'DRUG', refId: it.drugId, qty: it.quantity, unitPrice, amount: unitPrice * it.quantity });
      }
    }

    const total = items.reduce((s, it) => s + it.amount, 0);
    const coverage = await getBhytCoverage();
    const bhytPart = Math.round(total * coverage);
    const patientPart = total - bhytPart;

    const invoice = await prisma.invoice.create({
      data: {
        encounterId,
        total,
        bhytPart,
        patientPart,
        status: 'DRAFT',
        items: { create: items },
      },
      include: { items: true },
    });

    await audit(req, 'INVOICE_CREATE', 'invoice', invoice.id, { encounterId, total, coverage });
    res.status(201).json({
      invoice,
      note: { bhytCoverage: coverage, split: DEMO_BHYT_NOTE },
    });
  }),
);

// Danh sách hóa đơn (?status).
billingRouter.get(
  '/invoices',
  requirePermission('billing.read'),
  ah(async (req, res) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const invoices = await prisma.invoice.findMany({
      where: q.status ? { status: q.status } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { encounter: { include: { patient: true } } },
    });
    res.json({ invoices });
  }),
);

// Chi tiết 1 hóa đơn.
billingRouter.get(
  '/invoices/:id',
  requirePermission('billing.read'),
  ah(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        items: true,
        payments: true,
        bhytClaim: true,
        encounter: { include: { patient: true } },
      },
    });
    if (!invoice) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hóa đơn');
    const coverage = await getBhytCoverage();
    res.json({ invoice, note: { bhytCoverage: coverage, split: DEMO_BHYT_NOTE } });
  }),
);

// Phát hành hóa đơn: DRAFT -> ISSUED.
billingRouter.post(
  '/invoices/:id/issue',
  requirePermission('billing.write'),
  ah(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hóa đơn');
    if (invoice.status !== 'DRAFT') {
      throw new ApiError(422, 'BUSINESS_RULE', 'Chỉ phát hành hóa đơn ở trạng thái DRAFT');
    }
    const updated = await prisma.invoice.update({ where: { id }, data: { status: 'ISSUED' } });
    await audit(req, 'INVOICE_ISSUE', 'invoice', id);
    res.json({ invoice: updated });
  }),
);

// Thu tiền. Hỗ trợ Idempotency-Key để chống thu trùng.
billingRouter.post(
  '/invoices/:id/payment',
  requirePermission('billing.write'),
  ah(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const body = z
      .object({
        amount: z.number().positive(),
        method: z.string().default('CASH'),
        idempotencyKey: z.string().min(1).optional(),
      })
      .parse(req.body);

    // Idempotency-Key ưu tiên header, sau đó body.
    const headerKey = req.header('Idempotency-Key') || undefined;
    const idempotencyKey = headerKey ?? body.idempotencyKey;

    // Nếu trùng key -> trả lại payment cũ, KHÔNG thu 2 lần.
    if (idempotencyKey) {
      const existing = await prisma.payment.findUnique({ where: { idempotencyKey } });
      if (existing) {
        return res.status(200).json({ payment: existing, idempotent: true });
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id }, include: { payments: true } });
      if (!invoice) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hóa đơn');
      if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIAL') {
        throw new ApiError(422, 'BUSINESS_RULE', 'Chỉ thu tiền hóa đơn đã phát hành (ISSUED/PARTIAL)');
      }

      const payment = await tx.payment.create({
        data: {
          invoiceId: id,
          amount: body.amount,
          method: body.method,
          receiptNo: genReceiptNo(),
          idempotencyKey,
        },
      });

      const paid = invoice.payments.reduce((s, p) => s + p.amount, 0) + body.amount;
      // Phần người bệnh phải trả là patientPart (demo). Đủ -> PAID, thiếu -> PARTIAL.
      const due = invoice.patientPart > 0 ? invoice.patientPart : invoice.total;
      const status = paid >= due ? 'PAID' : 'PARTIAL';
      const updated = await tx.invoice.update({ where: { id }, data: { status } });

      return { payment, invoice: updated, paid, due };
    });

    await audit(req, 'PAYMENT_CREATE', 'invoice', id, {
      paymentId: result.payment.id,
      amount: body.amount,
      status: result.invoice.status,
    });
    res.status(201).json({ payment: result.payment, invoice: result.invoice });
  }),
);

// Danh sách thu của hóa đơn.
billingRouter.get(
  '/invoices/:id/payments',
  requirePermission('billing.read'),
  ah(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hóa đơn');
    const payments = await prisma.payment.findMany({ where: { invoiceId: id }, orderBy: { paidAt: 'asc' } });
    res.json({ payments });
  }),
);

// ------------------------------------------------------------
// BHYT CLAIM — MÔ PHỎNG (không kết nối cổng BHYT thật)
// ------------------------------------------------------------

billingRouter.post(
  '/invoices/:id/bhyt-claim',
  requirePermission('billing.write'),
  ah(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id }, include: { bhytClaim: true } });
    if (!invoice) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy hóa đơn');
    if (invoice.bhytClaim) {
      throw new ApiError(422, 'BUSINESS_RULE', 'Hóa đơn đã có hồ sơ BHYT');
    }

    const response = { accepted: true, source: 'MOCK' };
    const claim = await prisma.bhytClaim.create({
      data: {
        invoiceId: id,
        status: 'SENT',
        sentAt: new Date(),
        response: JSON.stringify(response),
      },
    });

    await audit(req, 'BHYT_CLAIM_SEND', 'invoice', id, { claimId: claim.id, mock: true });
    res.status(201).json({ claim, response, note: 'Gửi hồ sơ BHYT mô phỏng, không kết nối cổng thật' });
  }),
);

billingRouter.get(
  '/invoices/:id/bhyt-claim',
  requirePermission('billing.read'),
  ah(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const claim = await prisma.bhytClaim.findUnique({ where: { invoiceId: id } });
    if (!claim) throw new ApiError(404, 'NOT_FOUND', 'Chưa có hồ sơ BHYT cho hóa đơn');
    res.json({ claim, response: claim.response ? JSON.parse(claim.response) : null });
  }),
);

// ------------------------------------------------------------
// DƯỢC (pharmacy.*)
// ------------------------------------------------------------

// Đơn thuốc chờ cấp phát (mặc định SIGNED).
billingRouter.get(
  '/pharmacy/prescriptions',
  requirePermission('pharmacy.read'),
  ah(async (req, res) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const status = q.status ?? 'SIGNED';
    const prescriptions = await prisma.prescription.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      include: {
        items: { include: { drug: true } },
        encounter: { include: { patient: true } },
        dispense: true,
      },
    });
    res.json({ prescriptions });
  }),
);

// Cấp phát thuốc: trừ InventoryLot theo FEFO (hạn gần nhất trước); thiếu tồn -> 422.
billingRouter.post(
  '/prescriptions/:id/dispense',
  requirePermission('pharmacy.write'),
  ah(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const user = getUser(req);

    const result = await prisma.$transaction(async (tx) => {
      const presc = await tx.prescription.findUnique({
        where: { id },
        include: { items: true, dispense: true },
      });
      if (!presc) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy đơn thuốc');
      if (presc.status !== 'SIGNED') {
        throw new ApiError(422, 'BUSINESS_RULE', 'Chỉ cấp phát đơn đã ký (SIGNED)');
      }
      if (presc.dispense) {
        throw new ApiError(422, 'BUSINESS_RULE', 'Đơn thuốc đã được cấp phát');
      }

      // Gộp nhu cầu theo thuốc.
      const need = new Map<string, number>();
      for (const it of presc.items) need.set(it.drugId, (need.get(it.drugId) ?? 0) + it.quantity);

      // Trừ kho FEFO cho từng thuốc.
      for (const [drugId, qtyNeed] of need) {
        const lots = await tx.inventoryLot.findMany({
          where: { drugId, qty: { gt: 0 } },
          orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
        });
        const available = lots.reduce((s, l) => s + l.qty, 0);
        if (available < qtyNeed) {
          throw new ApiError(422, 'BUSINESS_RULE', `Không đủ tồn kho cho thuốc ${drugId} (cần ${qtyNeed}, có ${available})`);
        }
        let remaining = qtyNeed;
        for (const lot of lots) {
          if (remaining <= 0) break;
          const take = Math.min(lot.qty, remaining);
          await tx.inventoryLot.update({ where: { id: lot.id }, data: { qty: lot.qty - take } });
          remaining -= take;
        }
      }

      const dispense = await tx.drugDispense.create({
        data: { prescriptionId: id, dispensedBy: user.id },
      });
      const updated = await tx.prescription.update({ where: { id }, data: { status: 'DISPENSED' } });
      return { dispense, prescription: updated };
    });

    await audit(req, 'DRUG_DISPENSE', 'prescription', id, { dispenseId: result.dispense.id });
    res.status(201).json(result);
  }),
);

// Tồn kho theo thuốc + cảnh báo hạn dùng < 90 ngày.
billingRouter.get(
  '/pharmacy/inventory',
  requirePermission('pharmacy.read'),
  ah(async (_req, res) => {
    const lots = await prisma.inventoryLot.findMany({
      include: { drug: true },
      orderBy: [{ drugId: 'asc' }, { expiryDate: 'asc' }],
    });
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    const byDrug = new Map<string, { drugId: string; drugCode: string; drugName: string; totalQty: number; lots: any[] }>();
    for (const lot of lots) {
      const daysToExpiry = lot.expiryDate ? Math.floor((lot.expiryDate.getTime() - now) / DAY) : null;
      const expiringSoon = daysToExpiry !== null && daysToExpiry < 90;
      const entry = byDrug.get(lot.drugId) ?? {
        drugId: lot.drugId,
        drugCode: lot.drug.code,
        drugName: lot.drug.name,
        totalQty: 0,
        lots: [],
      };
      entry.totalQty += lot.qty;
      entry.lots.push({
        id: lot.id,
        lotNo: lot.lotNo,
        qty: lot.qty,
        warehouse: lot.warehouse,
        expiryDate: lot.expiryDate,
        daysToExpiry,
        expiringSoon,
      });
      byDrug.set(lot.drugId, entry);
    }

    const inventory = [...byDrug.values()];
    const expiryAlerts = inventory
      .flatMap((d) => d.lots.filter((l) => l.expiringSoon).map((l) => ({ drugCode: d.drugCode, drugName: d.drugName, ...l })));

    res.json({ inventory, expiryAlerts, expiryWarningDays: 90 });
  }),
);

// Nhập lô thuốc vào kho.
billingRouter.post(
  '/pharmacy/inventory',
  requirePermission('pharmacy.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        drugId: z.string(),
        lotNo: z.string().min(1),
        qty: z.number().int().positive(),
        expiryDate: z.coerce.date().optional(),
        warehouse: z.string().default('MAIN'),
      })
      .parse(req.body);

    const drug = await prisma.drug.findUnique({ where: { id: body.drugId } });
    if (!drug) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thuốc');

    const lot = await prisma.inventoryLot.create({
      data: {
        drugId: body.drugId,
        lotNo: body.lotNo,
        qty: body.qty,
        expiryDate: body.expiryDate,
        warehouse: body.warehouse,
      },
    });

    await audit(req, 'INVENTORY_IMPORT', 'inventoryLot', lot.id, { drugId: body.drugId, qty: body.qty, lotNo: body.lotNo });
    res.status(201).json({ lot });
  }),
);
