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

// Thư mục không hiện trong sidebar (chứa tài nguyên, không phải trang).
const HIDDEN_DIRS = new Set(['assets', 'img', 'images']);

// Kiểu ảnh được phục vụ qua /wiki/asset.
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

// Duyệt cây thư mục markdown, trả cấu trúc sidebar (bỏ qua thư mục tài nguyên).
function buildTree(dir: string, rel = ''): any[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  const nodes: any[] = [];
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (HIDDEN_DIRS.has(e.name.toLowerCase())) continue;
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

// Ảnh minh họa trong wiki theo ?path (png/jpg/gif/svg/webp). Công khai, chỉ đọc.
wikiRouter.get(
  '/wiki/asset',
  ah(async (req, res) => {
    const rel = String(req.query.path || '');
    const ext = path.extname(rel).toLowerCase();
    const type = IMAGE_TYPES[ext];
    if (!type) throw new ApiError(400, 'VALIDATION_ERROR', 'Định dạng ảnh không hỗ trợ');
    const file = safeResolve(rel);
    if (!fs.existsSync(file)) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy ảnh');
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(file).pipe(res);
  }),
);
