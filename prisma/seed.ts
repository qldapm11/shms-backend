import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const hash = (pw: string) => bcrypt.hashSync(pw, 10);

// Quyền theo miền. '*' = toàn quyền (QTV).
const PERMISSIONS: Record<string, string> = {
  '*': 'super',
  'patient.read': 'HOSPITAL', 'patient.write': 'HOSPITAL',
  'encounter.read': 'HOSPITAL', 'encounter.write': 'HOSPITAL', 'encounter.exam': 'HOSPITAL',
  'encounter.prescribe': 'HOSPITAL', 'order.write': 'HOSPITAL',
  'emr.read': 'HOSPITAL', 'emr.sign': 'HOSPITAL',
  'admission.write': 'HOSPITAL', 'care.write': 'HOSPITAL', 'vitals.read': 'HOSPITAL',
  'bed.read': 'HOSPITAL', 'resource.write': 'HOSPITAL',
  'billing.read': 'HOSPITAL', 'billing.write': 'HOSPITAL',
  'pharmacy.read': 'HOSPITAL', 'pharmacy.write': 'HOSPITAL',
  'report.read': 'HOSPITAL', 'ai.use': 'HOSPITAL',
  'admin.users': 'HOSPITAL', 'admin.catalog': 'HOSPITAL', 'admin.config': 'HOSPITAL', 'admin.monitor': 'HOSPITAL',
  'hub.read': 'HUB', 'hub.write': 'HUB', 'hub.review': 'HUB',
};

// Vai trò → danh sách permission code.
const ROLES: Record<string, { name: string; space: string; perms: string[] }> = {
  QTV: { name: 'Quản trị viên', space: 'HOSPITAL', perms: ['*'] },
  TD: { name: 'Tiếp đón', space: 'HOSPITAL', perms: ['patient.read', 'patient.write', 'encounter.read', 'encounter.write', 'billing.read'] },
  BS: { name: 'Bác sĩ', space: 'HOSPITAL', perms: ['patient.read', 'encounter.read', 'encounter.exam', 'encounter.prescribe', 'order.write', 'emr.read', 'emr.sign', 'admission.write', 'vitals.read', 'bed.read', 'ai.use'] },
  DD: { name: 'Điều dưỡng', space: 'HOSPITAL', perms: ['patient.read', 'encounter.read', 'care.write', 'vitals.read', 'bed.read', 'resource.write', 'emr.read'] },
  DS: { name: 'Dược sĩ', space: 'HOSPITAL', perms: ['pharmacy.read', 'pharmacy.write', 'patient.read'] },
  KT: { name: 'Kế toán/Viện phí', space: 'HOSPITAL', perms: ['billing.read', 'billing.write', 'patient.read', 'report.read'] },
  LD: { name: 'Lãnh đạo', space: 'HOSPITAL', perms: ['report.read', 'bed.read', 'ai.use'] },
  NB: { name: 'Người bệnh', space: 'HOSPITAL', perms: ['patient.read'] },
  PM: { name: 'Quản lý dự án', space: 'HUB', perms: ['hub.read', 'hub.write', 'hub.review'] },
  DEV: { name: 'Lập trình viên', space: 'HUB', perms: ['hub.read', 'hub.write'] },
  QA: { name: 'Kiểm thử', space: 'HUB', perms: ['hub.read', 'hub.write', 'hub.review'] },
};

async function main() {
  console.log('Seeding...');

  // Permissions
  for (const [code, resource] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, action: code.split('.')[1] || 'all', resource },
    });
  }

  // Roles + role_permissions
  for (const [code, def] of Object.entries(ROLES)) {
    const role = await prisma.role.upsert({
      where: { code },
      update: { name: def.name, space: def.space },
      create: { code, name: def.name, space: def.space, isDefault: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    for (const pc of def.perms) {
      const perm = await prisma.permission.findUnique({ where: { code: pc } });
      if (perm) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    }
  }

  // Departments
  const deptData = [
    { code: 'KHOA-NOI', name: 'Khoa Nội', type: 'KHOA' },
    { code: 'KHOA-NGOAI', name: 'Khoa Ngoại', type: 'KHOA' },
    { code: 'KHOA-CC', name: 'Khoa Cấp cứu', type: 'KHOA' },
  ];
  const depts: Record<string, string> = {};
  for (const d of deptData) {
    const dep = await prisma.department.upsert({ where: { code: d.code }, update: {}, create: d });
    depts[d.code] = dep.id;
  }
  // Beds cho Khoa Nội
  for (let i = 1; i <= 6; i++) {
    await prisma.bed.upsert({
      where: { code: `NOI-G${i}` },
      update: {},
      create: { code: `NOI-G${i}`, departmentId: depts['KHOA-NOI'], status: 'EMPTY' },
    });
  }

  // Demo users: mỗi vai trò 1 tài khoản, mật khẩu = <role thường>123
  const users: { username: string; role: string; fullName: string; dept?: string; space?: string }[] = [
    { username: 'admin', role: 'QTV', fullName: 'Quản trị hệ thống' },
    { username: 'tiepdon', role: 'TD', fullName: 'Lễ tân Tiếp đón', dept: 'KHOA-CC' },
    { username: 'bacsi', role: 'BS', fullName: 'BS. Trần Văn Khám', dept: 'KHOA-NOI' },
    { username: 'dieuduong', role: 'DD', fullName: 'ĐD. Lê Thị Chăm', dept: 'KHOA-NOI' },
    { username: 'duocsi', role: 'DS', fullName: 'DS. Phạm Thuốc' },
    { username: 'ketoan', role: 'KT', fullName: 'KT. Nguyễn Thu' },
    { username: 'lanhdao', role: 'LD', fullName: 'GĐ. Hoàng Lãnh' },
    { username: 'pm', role: 'PM', fullName: 'PM Nguyệt', space: 'HUB' },
  ];
  for (const u of users) {
    const role = await prisma.role.findUniqueOrThrow({ where: { code: u.role } });
    const user = await prisma.user.upsert({
      where: { username: u.username },
      update: {},
      create: {
        username: u.username,
        passwordHash: hash(`${u.username}123`),
        fullName: u.fullName,
        space: u.space || 'HOSPITAL',
        departmentId: u.dept ? depts[u.dept] : null,
      },
    });
    const exists = await prisma.userRole.findFirst({ where: { userId: user.id, roleId: role.id } });
    if (!exists) await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }

  // Services, drugs, ICD
  const services = [
    { code: 'KB-NOI', name: 'Khám Nội khoa', specialty: 'Nội', price: 150000, bhytPrice: 100000 },
    { code: 'XN-MAU', name: 'Xét nghiệm máu', specialty: 'CLS', price: 120000, bhytPrice: 80000 },
    { code: 'XQ-PHOI', name: 'Chụp X-quang phổi', specialty: 'CĐHA', price: 200000, bhytPrice: 150000 },
  ];
  for (const s of services) await prisma.service.upsert({ where: { code: s.code }, update: {}, create: s });

  const drugs = [
    { code: 'PARA500', name: 'Paracetamol 500mg', unit: 'viên', form: 'Viên nén' },
    { code: 'AMOX500', name: 'Amoxicillin 500mg', unit: 'viên', form: 'Viên nang' },
    { code: 'OME20', name: 'Omeprazole 20mg', unit: 'viên', form: 'Viên nang' },
  ];
  for (const d of drugs) {
    const drug = await prisma.drug.upsert({ where: { code: d.code }, update: {}, create: d });
    await prisma.inventoryLot.create({
      data: { drugId: drug.id, lotNo: `LOT-${d.code}`, qty: 1000, expiryDate: new Date('2027-12-31') },
    });
  }

  const icds = [
    { code: 'J06.9', name: 'Nhiễm khuẩn hô hấp trên cấp' },
    { code: 'K29.7', name: 'Viêm dạ dày' },
    { code: 'I10', name: 'Tăng huyết áp vô căn' },
  ];
  for (const i of icds) await prisma.icd10.upsert({ where: { code: i.code }, update: {}, create: i });

  // Config + threshold + integration mock
  await prisma.configParam.upsert({ where: { key: 'hospital.name' }, update: {}, create: { key: 'hospital.name', value: 'Bệnh viện SHMS (demo)' } });
  await prisma.alertThreshold.create({ data: { metric: 'spo2', minVal: 92, severity: 'CRITICAL' } }).catch(() => {});
  await prisma.alertThreshold.create({ data: { metric: 'hr', minVal: 50, maxVal: 120, severity: 'WARN' } }).catch(() => {});
  for (const t of ['IOT', 'BHYT', 'LIS', 'AI']) {
    await prisma.integration.create({ data: { type: t, name: `${t} (mô phỏng)`, status: 'MOCK' } }).catch(() => {});
  }

  // Một người bệnh mẫu + lượt khám chờ
  const pt = await prisma.patient.upsert({
    where: { code: 'PID2026000001' },
    update: {},
    create: { code: 'PID2026000001', fullName: 'Nguyễn Văn Bệnh', gender: 'Nam', phone: '0900000001', dob: new Date('1990-05-20') },
  });
  const encExists = await prisma.encounter.findFirst({ where: { patientId: pt.id } });
  if (!encExists) {
    await prisma.encounter.create({
      data: { patientId: pt.id, type: 'OUTPATIENT', departmentId: depts['KHOA-NOI'], queueNo: 1, status: 'WAITING' },
    });
  }

  console.log('Seed xong. Tài khoản demo: admin/admin123, bacsi/bacsi123, tiepdon/tiepdon123, ...');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
