// SHMS — AI (qua provider, mặc định MOCK vì 9router chưa sẵn sàng — Q002) + IoT mô phỏng.
// AI: requirePermission('ai.use'); mỗi lần gọi ghi 1 AiRequest. Kết quả chỉ GỢI Ý,
// không auto-apply. IoT: requirePermission('vitals.read'); dữ liệu mô phỏng
// (source IOT/SIMULATED). Ngưỡng cảnh báo đọc từ AlertThreshold (đã seed), KHÔNG
// bịa ngưỡng cố định trong code.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requirePermission } from '../core/auth.js';
import { ah, audit, ApiError } from '../core/helpers.js';
import { aiProvider, AI_DISCLAIMER } from '../core/ai-provider.js';

export const aiIotRouter = Router();

// Timeout mô phỏng cho lời gọi AI (ms).
const AI_TIMEOUT_MS = 2500;
// Khoảng thời gian coi là mất tín hiệu IoT (phút).
const SIGNAL_LOST_MINUTES = 15;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ApiError(504, 'AI_TIMEOUT', 'AI quá thời gian phản hồi')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Chạy 1 tính năng AI: ghi AiRequest (request/response/status/latencyMs/provider),
// có try/catch + fallback khi lỗi.
async function runAi<T extends { source: string }>(
  featureCode: string,
  request: unknown,
  fn: () => Promise<T>,
  fallback: () => T,
): Promise<{ result: T; status: string; latencyMs: number }> {
  const start = Date.now();
  let result: T;
  let status = 'OK';
  try {
    result = await withTimeout(fn(), AI_TIMEOUT_MS);
  } catch (e) {
    status = e instanceof ApiError ? e.code : 'ERROR';
    result = fallback();
  }
  const latencyMs = Date.now() - start;
  await prisma.aiRequest.create({
    data: {
      featureCode,
      request: JSON.stringify(request ?? null),
      response: JSON.stringify(result),
      status,
      latencyMs,
      provider: 'mock',
    },
  });
  return { result, status, latencyMs };
}

// ================== AI (ai.use) ==================

// U05.1 — Phân loại ưu tiên (triage).
aiIotRouter.post(
  '/ai/triage',
  requirePermission('ai.use'),
  ah(async (req, res) => {
    const body = z
      .object({ symptoms: z.string().min(1), age: z.number().int().positive().optional(), note: z.string().optional() })
      .parse(req.body);
    const { result, status, latencyMs } = await runAi(
      'U05.1',
      body,
      () => aiProvider.triage(body),
      () => ({
        source: 'MOCK' as const,
        disclaimer: AI_DISCLAIMER,
        priority: 'STANDARD' as const,
        level: 3,
        suggestedDepartment: 'Khoa Khám bệnh',
        matchedKeywords: [] as string[],
        rationale: 'Fallback: không thể chạy mô hình, phân loại mức trung bình.',
      }),
    );
    await audit(req, 'AI_TRIAGE', 'ai', undefined, { status, latencyMs });
    res.json({ feature: 'U05.1', status, latencyMs, result });
  }),
);

// U05.2 — Cảnh báo sớm (early warning) theo dấu hiệu sinh tồn.
aiIotRouter.post(
  '/ai/early-warning',
  requirePermission('ai.use'),
  ah(async (req, res) => {
    const body = z
      .object({
        admissionId: z.string().optional(),
        vitals: z.object({
          hr: z.number().optional(),
          spo2: z.number().optional(),
          temp: z.number().optional(),
          bpSys: z.number().optional(),
          bpDia: z.number().optional(),
        }),
      })
      .parse(req.body);
    const { result, status, latencyMs } = await runAi(
      'U05.2',
      body,
      () => aiProvider.earlyWarning(body),
      () => ({
        source: 'MOCK' as const,
        disclaimer: AI_DISCLAIMER,
        score: 0,
        risk: 'LOW' as const,
        flags: ['Fallback: không chấm điểm được'],
        recommendation: 'Theo dõi thường quy; nhân viên tự đánh giá.',
      }),
    );
    await audit(req, 'AI_EARLY_WARNING', 'ai', body.admissionId, { status, latencyMs });
    res.json({ feature: 'U05.2', status, latencyMs, result });
  }),
);

// U05.3 — Dự báo giường (bed forecast).
aiIotRouter.get(
  '/ai/bed-forecast',
  requirePermission('ai.use'),
  ah(async (req, res) => {
    const q = z
      .object({
        departmentId: z.string().optional(),
        horizonHours: z.coerce.number().int().positive().max(168).optional(),
      })
      .parse(req.query);
    const { result, status, latencyMs } = await runAi(
      'U05.3',
      q,
      () => aiProvider.bedForecast(q),
      () => ({
        source: 'MOCK' as const,
        disclaimer: AI_DISCLAIMER,
        horizonHours: q.horizonHours ?? 24,
        expectedAdmissions: 0,
        expectedDischarges: 0,
        projectedOccupancyPct: 0,
        note: 'Fallback: không dự báo được.',
      }),
    );
    res.json({ feature: 'U05.3', status, latencyMs, result });
  }),
);

// U05.4 — Kiểm tra tương tác thuốc (drug interaction).
aiIotRouter.post(
  '/ai/drug-interaction',
  requirePermission('ai.use'),
  ah(async (req, res) => {
    const body = z.object({ drugs: z.array(z.string().min(1)).min(2) }).parse(req.body);
    const { result, status, latencyMs } = await runAi(
      'U05.4',
      body,
      () => aiProvider.drugInteraction(body),
      () => ({
        source: 'MOCK' as const,
        disclaimer: AI_DISCLAIMER,
        interactions: [],
        checkedPairs: 0,
      }),
    );
    await audit(req, 'AI_DRUG_INTERACTION', 'ai', undefined, { status, latencyMs, drugs: body.drugs });
    res.json({ feature: 'U05.4', status, latencyMs, result });
  }),
);

// ================== IoT (vitals.read) — mô phỏng ==================

function randIn(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 10) / 10;
}

// Sinh VitalSign mô phỏng (source='IOT') cho 1 admission.
aiIotRouter.post(
  '/iot/vitals/simulate',
  requirePermission('vitals.read'),
  ah(async (req, res) => {
    const body = z.object({ admissionId: z.string().min(1) }).parse(req.body);
    const adm = await prisma.admission.findUnique({ where: { id: body.admissionId } });
    if (!adm) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lượt nằm viện');
    const vital = await prisma.vitalSign.create({
      data: {
        admissionId: adm.id,
        bedId: adm.bedId,
        hr: randIn(55, 125),
        spo2: randIn(90, 100),
        temp: randIn(36, 39),
        bpSys: randIn(95, 160),
        bpDia: randIn(60, 95),
        source: 'IOT',
      },
    });
    await audit(req, 'IOT_VITALS_SIMULATE', 'vitalSign', vital.id, { admissionId: adm.id });
    res.status(201).json({ source: 'SIMULATED', vital });
  }),
);

// Danh sách VitalSign của 1 admission.
aiIotRouter.get(
  '/iot/vitals/:admissionId',
  requirePermission('vitals.read'),
  ah(async (req, res) => {
    const { admissionId } = z.object({ admissionId: z.string().min(1) }).parse(req.params);
    const items = await prisma.vitalSign.findMany({
      where: { admissionId },
      orderBy: { measuredAt: 'desc' },
      take: 200,
    });
    res.json({ source: 'MOCK', admissionId, count: items.length, items });
  }),
);

// Trend: gộp VitalSign theo mốc thời gian (từng bản ghi, tăng dần).
aiIotRouter.get(
  '/iot/vitals/:admissionId/trend',
  requirePermission('vitals.read'),
  ah(async (req, res) => {
    const { admissionId } = z.object({ admissionId: z.string().min(1) }).parse(req.params);
    const items = await prisma.vitalSign.findMany({
      where: { admissionId },
      orderBy: { measuredAt: 'asc' },
      take: 500,
    });
    const points = items.map((v) => ({
      t: v.measuredAt,
      hr: v.hr,
      spo2: v.spo2,
      temp: v.temp,
      bpSys: v.bpSys,
      bpDia: v.bpDia,
    }));
    res.json({ source: 'MOCK', admissionId, points });
  }),
);

// Cảnh báo: so VitalSign mới nhất mỗi admission với AlertThreshold (đọc DB).
aiIotRouter.get(
  '/iot/alerts',
  requirePermission('vitals.read'),
  ah(async (req, res) => {
    const thresholds = await prisma.alertThreshold.findMany();
    const admissions = await prisma.admission.findMany({ where: { status: 'ADMITTED' } });
    const now = Date.now();
    const alerts: {
      admissionId: string;
      type: 'THRESHOLD' | 'SIGNAL_LOST';
      metric?: string;
      value?: number | null;
      minVal?: number | null;
      maxVal?: number | null;
      severity: string;
      measuredAt?: Date;
      message: string;
    }[] = [];

    for (const adm of admissions) {
      const latest = await prisma.vitalSign.findFirst({
        where: { admissionId: adm.id },
        orderBy: { measuredAt: 'desc' },
      });
      // Mất tín hiệu: không có số liệu hoặc số liệu cũ quá ngưỡng.
      if (!latest || now - latest.measuredAt.getTime() > SIGNAL_LOST_MINUTES * 60_000) {
        alerts.push({
          admissionId: adm.id,
          type: 'SIGNAL_LOST',
          severity: 'WARN',
          measuredAt: latest?.measuredAt,
          message: latest
            ? `Mất tín hiệu IoT > ${SIGNAL_LOST_MINUTES} phút`
            : 'Chưa có dữ liệu sinh tồn',
        });
        continue;
      }
      // So từng metric với ngưỡng từ AlertThreshold.
      for (const th of thresholds) {
        const value = (latest as any)[th.metric] as number | null | undefined;
        if (value === null || value === undefined) continue;
        const underMin = th.minVal !== null && th.minVal !== undefined && value < th.minVal;
        const overMax = th.maxVal !== null && th.maxVal !== undefined && value > th.maxVal;
        if (underMin || overMax) {
          alerts.push({
            admissionId: adm.id,
            type: 'THRESHOLD',
            metric: th.metric,
            value,
            minVal: th.minVal,
            maxVal: th.maxVal,
            severity: th.severity,
            measuredAt: latest.measuredAt,
            message: `${th.metric}=${value} vượt ngưỡng (${th.minVal ?? '-'}..${th.maxVal ?? '-'})`,
          });
        }
      }
    }
    res.json({ source: 'MOCK', thresholdCount: thresholds.length, alertCount: alerts.length, alerts });
  }),
);

// Nhiệt độ kho thuốc / tủ lạnh mô phỏng.
aiIotRouter.get(
  '/iot/fridge',
  requirePermission('vitals.read'),
  ah(async (_req, res) => {
    const fridges = [
      { code: 'FRIDGE-DUOC-01', name: 'Tủ lạnh kho Dược 1', target: [2, 8] as [number, number] },
      { code: 'FRIDGE-VACCINE-01', name: 'Tủ bảo quản vắc-xin', target: [2, 8] as [number, number] },
    ].map((f) => {
      const temp = randIn(1, 9);
      const inRange = temp >= f.target[0] && temp <= f.target[1];
      return {
        code: f.code,
        name: f.name,
        temp,
        unit: '°C',
        targetMin: f.target[0],
        targetMax: f.target[1],
        status: inRange ? 'OK' : 'ALERT',
      };
    });
    res.json({ source: 'SIMULATED', measuredAt: new Date(), fridges });
  }),
);
