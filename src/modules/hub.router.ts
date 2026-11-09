// Project Hub router — quản lý dự án (tài liệu, review, task, quyết định, sự kiện, test, truy vết).
//
// GHI CHÚ NGUỒN DỮ LIỆU (giai đoạn demo):
// - Hub DB (các bảng Hub* trong Prisma/SQLite) là MỘT nguồn dữ liệu đang hoạt động.
// - Các file document/state/*.json là nguồn bootstrap SONG SONG, dùng để khởi tạo ban đầu
//   cho tới khi hoàn tất migration; sau migration các file đó chỉ còn vai trò CHỈ ĐỌC.
// - Bản demo KHÔNG đồng bộ 2 chiều tự động giữa DB và file JSON. Mọi ghi đi vào DB.
//
// Quyền: xem cần hub.read; sửa cần hub.write; review/duyệt cần hub.review.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authMiddleware, requirePermission } from '../core/auth.js';
import { ah, audit, getUser, ApiError } from '../core/helpers.js';

export const hubRouter = Router();

// Trạng thái task hợp lệ.
const TASK_STATUSES = [
  'DRAFT',
  'READY',
  'IN_PROGRESS',
  'BLOCKED',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'DONE',
  'CANCELLED',
] as const;

// Parse JSON string an toàn → mảng. Trả [] nếu rỗng/sai định dạng.
function parseIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Chuẩn hóa mảng id → JSON string để lưu.
function toJson(ids: string[] | undefined): string | undefined {
  return ids ? JSON.stringify(ids) : undefined;
}

// Mọi route Hub yêu cầu đăng nhập.
hubRouter.use(authMiddleware);

// ============ TÀI LIỆU ============

// Danh sách tài liệu, lọc theo ?q (title/path) và ?category.
hubRouter.get(
  '/hub/documents',
  requirePermission('hub.read'),
  ah(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const where: any = {};
    if (category) where.category = category;
    if (q) {
      where.OR = [{ title: { contains: q } }, { path: { contains: q } }];
    }
    const documents = await prisma.hubDocument.findMany({
      where,
      orderBy: { path: 'asc' },
    });
    res.json({ documents });
  }),
);

// Chi tiết 1 tài liệu kèm các version.
hubRouter.get(
  '/hub/documents/:id',
  requirePermission('hub.read'),
  ah(async (req, res) => {
    const doc = await prisma.hubDocument.findUnique({
      where: { id: req.params.id },
      include: { versions: { orderBy: { version: 'asc' } } },
    });
    if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy tài liệu');
    res.json({ document: doc });
  }),
);

// Tạo tài liệu mới + version 1.
hubRouter.post(
  '/hub/documents',
  requirePermission('hub.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        path: z.string().min(1),
        title: z.string().min(1),
        category: z.string().optional(),
        content: z.string().default(''),
      })
      .parse(req.body);
    const user = getUser(req);
    const exists = await prisma.hubDocument.findUnique({ where: { path: body.path } });
    if (exists) throw new ApiError(409, 'CONFLICT', 'Đường dẫn tài liệu đã tồn tại');
    const doc = await prisma.hubDocument.create({
      data: {
        path: body.path,
        title: body.title,
        category: body.category,
        currentVersion: 1,
        versions: {
          create: { version: 1, content: body.content, authorId: user.id },
        },
      },
      include: { versions: true },
    });
    await audit(req, 'HUB_DOC_CREATE', 'hubDocument', doc.id, { path: doc.path });
    res.status(201).json({ document: doc });
  }),
);

// Thêm version mới: tăng currentVersion, lưu nội dung mới.
hubRouter.post(
  '/hub/documents/:id/versions',
  requirePermission('hub.write'),
  ah(async (req, res) => {
    const body = z.object({ content: z.string() }).parse(req.body);
    const user = getUser(req);
    const doc = await prisma.hubDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy tài liệu');
    const nextVersion = doc.currentVersion + 1;
    const [version] = await prisma.$transaction([
      prisma.hubDocumentVersion.create({
        data: { documentId: doc.id, version: nextVersion, content: body.content, authorId: user.id },
      }),
      prisma.hubDocument.update({
        where: { id: doc.id },
        data: { currentVersion: nextVersion },
      }),
    ]);
    await audit(req, 'HUB_DOC_VERSION', 'hubDocument', doc.id, { version: nextVersion });
    res.status(201).json({ version });
  }),
);

// So sánh 2 version: trả nội dung của from & to để client tự diff.
hubRouter.get(
  '/hub/documents/:id/diff',
  requirePermission('hub.read'),
  ah(async (req, res) => {
    const doc = await prisma.hubDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy tài liệu');
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Thiếu from/to hợp lệ');
    }
    const [fromVer, toVer] = await Promise.all([
      prisma.hubDocumentVersion.findFirst({ where: { documentId: doc.id, version: from } }),
      prisma.hubDocumentVersion.findFirst({ where: { documentId: doc.id, version: to } }),
    ]);
    if (!fromVer || !toVer) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy version yêu cầu');
    res.json({
      documentId: doc.id,
      from: { version: fromVer.version, content: fromVer.content },
      to: { version: toVer.version, content: toVer.content },
    });
  }),
);

// ============ REVIEW ============

// Ghi review cho tài liệu (duyệt hoặc yêu cầu sửa).
hubRouter.post(
  '/hub/documents/:id/reviews',
  requirePermission('hub.review'),
  ah(async (req, res) => {
    const body = z
      .object({
        status: z.enum(['APPROVED', 'CHANGES']),
        comment: z.string().optional(),
        version: z.number().int().optional(),
      })
      .parse(req.body);
    const user = getUser(req);
    const doc = await prisma.hubDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy tài liệu');
    const review = await prisma.hubReview.create({
      data: {
        documentId: doc.id,
        version: body.version ?? doc.currentVersion,
        reviewerId: user.id,
        status: body.status,
        comment: body.comment,
      },
    });
    await audit(req, 'HUB_REVIEW', 'hubDocument', doc.id, { status: body.status });
    res.status(201).json({ review });
  }),
);

// Danh sách review của 1 tài liệu (mới nhất trước).
hubRouter.get(
  '/hub/documents/:id/reviews',
  requirePermission('hub.read'),
  ah(async (req, res) => {
    const doc = await prisma.hubDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy tài liệu');
    const reviews = await prisma.hubReview.findMany({
      where: { documentId: doc.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ reviews });
  }),
);

// ============ TASK ============

// Danh sách task, lọc theo ?status và ?owner.
hubRouter.get(
  '/hub/tasks',
  requirePermission('hub.read'),
  ah(async (req, res) => {
    const where: any = {};
    if (typeof req.query.status === 'string') where.status = req.query.status;
    if (typeof req.query.owner === 'string') where.ownerId = req.query.owner;
    const tasks = await prisma.hubTask.findMany({ where, orderBy: { updatedAt: 'desc' } });
    res.json({ tasks });
  }),
);

// Chi tiết 1 task.
hubRouter.get(
  '/hub/tasks/:id',
  requirePermission('hub.read'),
  ah(async (req, res) => {
    const task = await prisma.hubTask.findUnique({ where: { id: req.params.id } });
    if (!task) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy task');
    res.json({ task });
  }),
);

// Tạo task mới.
hubRouter.post(
  '/hub/tasks',
  requirePermission('hub.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(1),
        title: z.string().min(1),
        type: z.string().min(1),
        featureIds: z.array(z.string()).optional(),
        screenIds: z.array(z.string()).optional(),
        dependencyIds: z.array(z.string()).optional(),
        ownerId: z.string().optional(),
        reviewerId: z.string().optional(),
        status: z.enum(TASK_STATUSES).default('DRAFT'),
        description: z.string().optional(),
      })
      .parse(req.body);
    const exists = await prisma.hubTask.findUnique({ where: { code: body.code } });
    if (exists) throw new ApiError(409, 'CONFLICT', 'Mã task đã tồn tại');
    const task = await prisma.hubTask.create({
      data: {
        code: body.code,
        title: body.title,
        type: body.type,
        featureIds: toJson(body.featureIds),
        screenIds: toJson(body.screenIds),
        dependencyIds: toJson(body.dependencyIds),
        ownerId: body.ownerId,
        reviewerId: body.reviewerId,
        status: body.status,
        description: body.description,
      },
    });
    await audit(req, 'HUB_TASK_CREATE', 'hubTask', task.id, { code: task.code });
    res.status(201).json({ task });
  }),
);

// Cập nhật task: đổi status/owner (và reviewer).
// Quy tắc demo không tự duyệt: chặn chuyển sang DONE khi reviewerId trùng ownerId.
hubRouter.patch(
  '/hub/tasks/:id',
  requirePermission('hub.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        status: z.enum(TASK_STATUSES).optional(),
        ownerId: z.string().optional(),
        reviewerId: z.string().optional(),
      })
      .parse(req.body);
    const task = await prisma.hubTask.findUnique({ where: { id: req.params.id } });
    if (!task) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy task');

    const nextOwner = body.ownerId ?? task.ownerId;
    const nextReviewer = body.reviewerId ?? task.reviewerId;
    if (body.status === 'DONE' && nextReviewer && nextOwner && nextReviewer === nextOwner) {
      throw new ApiError(
        422,
        'SELF_APPROVAL_FORBIDDEN',
        'Người tạo/owner không được tự chuyển task sang DONE khi trùng reviewer',
      );
    }

    const updated = await prisma.hubTask.update({
      where: { id: task.id },
      data: {
        status: body.status ?? undefined,
        ownerId: body.ownerId ?? undefined,
        reviewerId: body.reviewerId ?? undefined,
      },
    });
    await audit(req, 'HUB_TASK_UPDATE', 'hubTask', task.id, { status: updated.status });
    res.json({ task: updated });
  }),
);

// ============ QUYẾT ĐỊNH ============

hubRouter.get(
  '/hub/decisions',
  requirePermission('hub.read'),
  ah(async (_req, res) => {
    const decisions = await prisma.hubDecision.findMany({ orderBy: { decidedAt: 'desc' } });
    res.json({ decisions });
  }),
);

hubRouter.post(
  '/hub/decisions',
  requirePermission('hub.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        title: z.string().min(1),
        decision: z.string().min(1),
        authority: z.string().optional(),
        reason: z.string().optional(),
      })
      .parse(req.body);
    const decision = await prisma.hubDecision.create({ data: body });
    await audit(req, 'HUB_DECISION_CREATE', 'hubDecision', decision.id, { title: decision.title });
    res.status(201).json({ decision });
  }),
);

// ============ SỰ KIỆN ============

// Sự kiện mới nhất, lọc theo ?type.
hubRouter.get(
  '/hub/events',
  requirePermission('hub.read'),
  ah(async (req, res) => {
    const where: any = {};
    if (typeof req.query.type === 'string') where.type = req.query.type;
    const events = await prisma.hubEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ events });
  }),
);

// Ghi 1 dòng sự kiện.
hubRouter.post(
  '/hub/events',
  requirePermission('hub.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        type: z.string().min(1),
        detail: z.string().optional(),
        actor: z.string().optional(),
      })
      .parse(req.body);
    const user = getUser(req);
    const event = await prisma.hubEvent.create({
      data: { actor: body.actor ?? user.username, type: body.type, detail: body.detail },
    });
    await audit(req, 'HUB_EVENT_CREATE', 'hubEvent', event.id, { type: event.type });
    res.status(201).json({ event });
  }),
);

// ============ TEST CASE ============

hubRouter.get(
  '/hub/test-cases',
  requirePermission('hub.read'),
  ah(async (req, res) => {
    const where: any = {};
    if (typeof req.query.featureId === 'string') where.featureId = req.query.featureId;
    if (typeof req.query.result === 'string') where.result = req.query.result;
    const testCases = await prisma.hubTestCase.findMany({ where });
    res.json({ testCases });
  }),
);

hubRouter.post(
  '/hub/test-cases',
  requirePermission('hub.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        featureId: z.string().min(1),
        steps: z.string().optional(),
        expected: z.string().optional(),
        result: z.enum(['PASS', 'FAIL', 'NOT_RUN']).default('NOT_RUN'),
        evidence: z.string().optional(),
      })
      .parse(req.body);
    const testCase = await prisma.hubTestCase.create({ data: body });
    await audit(req, 'HUB_TESTCASE_CREATE', 'hubTestCase', testCase.id, { featureId: testCase.featureId });
    res.status(201).json({ testCase });
  }),
);

// Cập nhật kết quả chạy test + bằng chứng.
hubRouter.patch(
  '/hub/test-cases/:id',
  requirePermission('hub.write'),
  ah(async (req, res) => {
    const body = z
      .object({
        result: z.enum(['PASS', 'FAIL', 'NOT_RUN']).optional(),
        evidence: z.string().optional(),
      })
      .parse(req.body);
    const tc = await prisma.hubTestCase.findUnique({ where: { id: req.params.id } });
    if (!tc) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy test case');
    const updated = await prisma.hubTestCase.update({
      where: { id: tc.id },
      data: { result: body.result ?? undefined, evidence: body.evidence ?? undefined },
    });
    await audit(req, 'HUB_TESTCASE_UPDATE', 'hubTestCase', tc.id, { result: updated.result });
    res.json({ testCase: updated });
  }),
);

// ============ TRUY VẾT ============

// Trả danh sách task kèm featureIds/screenIds đã parse từ JSON để client dựng ma trận truy vết.
hubRouter.get(
  '/hub/traceability',
  requirePermission('hub.read'),
  ah(async (_req, res) => {
    const tasks = await prisma.hubTask.findMany({ orderBy: { code: 'asc' } });
    const matrix = tasks.map((t) => ({
      id: t.id,
      code: t.code,
      title: t.title,
      type: t.type,
      status: t.status,
      ownerId: t.ownerId,
      reviewerId: t.reviewerId,
      featureIds: parseIds(t.featureIds),
      screenIds: parseIds(t.screenIds),
      dependencyIds: parseIds(t.dependencyIds),
    }));
    res.json({ traceability: matrix });
  }),
);

// ============ DANH MỤC TÍNH NĂNG (đọc từ state bootstrap) ============
// Đọc document/state/features.json (67 tính năng bệnh viện + 9 HUB) để Hub hiển thị.
// Đường dẫn qua FEATURES_FILE; chỉ đọc, không ghi. Lỗi/không có file → trả rỗng có ghi chú.
hubRouter.get(
  '/hub/features',
  requirePermission('hub.read'),
  ah(async (_req, res) => {
    const file = process.env.FEATURES_FILE;
    if (!file) return res.json({ features: [], hubFeatures: [], note: 'Chưa cấu hình FEATURES_FILE' });
    try {
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(file, 'utf8');
      const data = JSON.parse(raw);
      res.json({
        features: data.features || [],
        hubFeatures: data.hub_features || [],
        groups: data.groups || [],
        counts: data.counts || null,
      });
    } catch {
      res.json({ features: [], hubFeatures: [], note: 'Không đọc được features.json' });
    }
  }),
);
