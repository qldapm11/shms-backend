import { Router } from 'express';
import { prisma } from '../db.js';
import { ah } from '../core/helpers.js';

// Danh mục đọc dùng chung cho nhân viên lâm sàng (BS kê đơn cần thuốc/ICD,
// TD cần dịch vụ/khoa). Chỉ ĐỌC, không sửa — sửa danh mục vẫn qua admin.catalog.
// Mọi user đã đăng nhập đều đọc được (đã qua authMiddleware).
export const catalogRouter = Router();

catalogRouter.get(
  '/catalog/drugs',
  ah(async (req, res) => {
    const q = String((req.query.q as string) || '');
    const drugs = await prisma.drug.findMany({
      where: { status: 'ACTIVE', ...(q ? { OR: [{ name: { contains: q } }, { code: { contains: q } }] } : {}) },
      orderBy: { name: 'asc' },
    });
    res.json({ data: drugs });
  }),
);

catalogRouter.get(
  '/catalog/icd10',
  ah(async (req, res) => {
    const q = String((req.query.q as string) || '');
    const icd = await prisma.icd10.findMany({
      where: q ? { OR: [{ name: { contains: q } }, { code: { contains: q } }] } : {},
      take: 50,
    });
    res.json({ data: icd });
  }),
);

catalogRouter.get(
  '/catalog/services',
  ah(async (_req, res) => {
    const services = await prisma.service.findMany({ where: { status: 'ACTIVE' }, orderBy: { name: 'asc' } });
    res.json({ data: services });
  }),
);

catalogRouter.get(
  '/catalog/departments',
  ah(async (_req, res) => {
    const depts = await prisma.department.findMany({ where: { status: 'ACTIVE' }, orderBy: { code: 'asc' } });
    res.json({ data: depts });
  }),
);
