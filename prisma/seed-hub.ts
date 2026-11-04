// Seed dữ liệu Project Hub từ document/state (quyết định, task nhóm, tài liệu).
// Chỉ nạp khi bảng Hub rỗng; không ghi đè dữ liệu đã có.
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';

const prisma = new PrismaClient();
const STATE = '/config/workspace/shms/shms-document/document/state';

function readJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

async function main() {
  console.log('Seeding Hub...');

  // Quyết định (D001..) + giả định
  const dec = readJson(`${STATE}/decisions.json`);
  if (dec && (await prisma.hubDecision.count()) === 0) {
    const all = [...(dec.decisions || []), ...(dec.decisions_appended || [])];
    for (const d of all) {
      await prisma.hubDecision.create({
        data: { title: `${d.id} — ${d.title}`, decision: d.decision, authority: d.authority, reason: d.impact || d.source },
      });
    }
    console.log(`  + ${all.length} quyết định`);
  }

  // Task nhóm G01–G40 + T-*
  const tasks = readJson(`${STATE}/tasks.json`);
  if (tasks && (await prisma.hubTask.count()) === 0) {
    for (const g of tasks.group_tasks || []) {
      await prisma.hubTask.create({
        data: {
          code: g.id, title: g.title, type: 'group', status: g.status || 'DRAFT',
          ownerId: g.owner, reviewerId: g.reviewer, description: g.note,
        },
      });
    }
    for (const t of tasks.tasks || []) {
      await prisma.hubTask.create({
        data: {
          code: t.id, title: t.title, type: t.type || 'tech', status: t.status || 'DRAFT',
          ownerId: t.human_owner, reviewerId: t.reviewer, description: t.description,
          featureIds: JSON.stringify(t.feature_ids || []), screenIds: JSON.stringify(t.screen_ids || []),
          dependencyIds: JSON.stringify(t.dependency_ids || []),
        },
      });
    }
    console.log(`  + ${(tasks.group_tasks || []).length} task nhóm, ${(tasks.tasks || []).length} task kỹ thuật`);
  }

  // Tài liệu: liệt kê các file nội dung chính
  if ((await prisma.hubDocument.count()) === 0) {
    const docs = [
      { path: 'content/00-tong-quan/00-chi-muc.md', title: 'Chỉ mục tài liệu dự án', category: 'Tổng quan' },
      { path: 'content/02-yeu-cau/00-danh-muc-tinh-nang.md', title: 'Danh mục 67 tính năng + HUB', category: 'Yêu cầu' },
      { path: 'content/03-man-hinh/00-danh-muc-man-hinh.md', title: 'Danh mục màn hình & đối chiếu ảnh', category: 'Màn hình' },
      { path: 'content/04-kien-truc/00-kien-truc-tong-the.md', title: 'Kiến trúc tổng thể', category: 'Kiến trúc' },
      { path: 'content/05-du-lieu/00-mo-hinh-du-lieu.md', title: 'Mô hình dữ liệu ERD', category: 'Dữ liệu' },
      { path: 'content/06-api/00-hop-dong-api.md', title: 'Hợp đồng API & phân quyền', category: 'API' },
      { path: 'content/07-truy-vet/00-ma-tran-truy-vet.md', title: 'Ma trận truy vết', category: 'Truy vết' },
      { path: 'content/08-backlog/00-ke-hoach-trien-khai.md', title: 'Backlog & roadmap', category: 'Kế hoạch' },
    ];
    for (const d of docs) {
      const doc = await prisma.hubDocument.create({ data: { path: d.path, title: d.title, category: d.category, currentVersion: 1 } });
      await prisma.hubDocumentVersion.create({ data: { documentId: doc.id, version: 1, content: `Tài liệu nguồn: document/${d.path}` } });
    }
    console.log(`  + ${docs.length} tài liệu`);
  }

  console.log('Seed Hub xong.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
