// Wiki hướng dẫn CÔNG KHAI — không cần đăng nhập (giống GitHub wiki).
// Chỉ đọc markdown trong document/content/. Không ghi.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ah, ApiError } from '../core/helpers.js';

export const wikiRouter = Router();

// Thư mục nội dung wiki; cấu hình qua WIKI_CONTENT_DIR.
const CONTENT_DIR = process.env.WIKI_CONTENT_DIR || '';

// Chuyển tên file/thư mục thành tiêu đề đọc được: bỏ số thứ tự + gạch ngang.
function titleize(name: string): string {
  return name.replace(/\.md$/, '').replace(/^\d+[-.]?/, '').replace(/-/g, ' ').trim() || name;
}

// Duyệt cây thư mục markdown, trả cấu trúc sidebar.
function buildTree(dir: string, rel = ''): any[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  const nodes: any[] = [];
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      nodes.push({ type: 'folder', title: titleize(e.name), path: relPath, children: buildTree(path.join(dir, e.name), relPath) });
    } else if (e.name.endsWith('.md')) {
      nodes.push({ type: 'file', title: titleize(e.name), path: relPath });
    }
  }
  return nodes;
}

// Chống path traversal: chỉ cho phép đường dẫn trong CONTENT_DIR.
function safeResolve(rel: string): string {
  const target = path.resolve(CONTENT_DIR, rel);
  if (!target.startsWith(path.resolve(CONTENT_DIR))) throw new ApiError(403, 'FORBIDDEN', 'Đường dẫn không hợp lệ');
  return target;
}

// Cây mục lục wiki.
wikiRouter.get(
  '/wiki/tree',
  ah(async (_req, res) => {
    if (!CONTENT_DIR) return res.json({ tree: [], note: 'Chưa cấu hình WIKI_CONTENT_DIR' });
    res.json({ tree: buildTree(CONTENT_DIR) });
  }),
);

// Nội dung 1 trang markdown theo ?path.
wikiRouter.get(
  '/wiki/page',
  ah(async (req, res) => {
    const rel = String(req.query.path || '');
    if (!rel.endsWith('.md')) throw new ApiError(400, 'VALIDATION_ERROR', 'Thiếu đường dẫn .md');
    const file = safeResolve(rel);
    if (!fs.existsSync(file)) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy trang');
    const content = fs.readFileSync(file, 'utf8');
    res.json({ path: rel, content });
  }),
);
