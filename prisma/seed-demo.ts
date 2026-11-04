// Seed dữ liệu DEMO phong phú cho mọi vai trò. Idempotent: bỏ qua nếu đã có.
// Tạo: nhiều người bệnh, lượt khám đủ trạng thái, nội trú + sinh hiệu, đơn thuốc,
// hóa đơn + thanh toán, thông báo, lịch hẹn, tài khoản người bệnh (NB) cho cổng U11.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const hash = (pw: string) => bcrypt.hashSync(pw, 10);
const pick = <T,>(arr: T[], i: number) => arr[i % arr.length];

async function main() {
  console.log('Seed demo phong phú...');

  const noi = await prisma.department.findUnique({ where: { code: 'KHOA-NOI' } });
  const ngoai = await prisma.department.findUnique({ where: { code: 'KHOA-NGOAI' } });
  const cc = await prisma.department.findUnique({ where: { code: 'KHOA-CC' } });
  const depts = [noi, ngoai, cc].filter(Boolean) as { id: string }[];
  const bs = await prisma.user.findUnique({ where: { username: 'bacsi' } });
  const dd = await prisma.user.findUnique({ where: { username: 'dieuduong' } });
  const drugs = await prisma.drug.findMany();
  const services = await prisma.service.findMany();
  const icds = await prisma.icd10.findMany();

  // Guard bằng marker: chỉ seed bộ demo 1 lần, nhưng không phụ thuộc số người bệnh ad-hoc.
  const marker = await prisma.configParam.findUnique({ where: { key: 'demo.rich.seeded' } });
  if (marker) {
    console.log('  Đã seed bộ demo đầy đủ (marker), bỏ qua.');
  } else {
    const names = ['Trần Thị Hoa', 'Lê Văn Nam', 'Phạm Thị Mai', 'Hoàng Văn Sơn', 'Vũ Thị Lan', 'Đặng Văn Hùng', 'Bùi Thị Thu', 'Ngô Văn Dũng', 'Dương Thị Hương', 'Phan Văn Tùng'];
    for (let i = 0; i < names.length; i++) {
      const seq = `D${String(i + 1).padStart(5, '0')}`;
      const dept = pick(depts, i);
      const pt = await prisma.patient.create({
        data: {
          code: `PID2026${seq}`.replace('PID2026D', 'PID2026D'), fullName: names[i], gender: i % 2 ? 'Nữ' : 'Nam',
          phone: `09000000${String(i).padStart(2, '0')}`, dob: new Date(1980 + i, i % 12, (i % 27) + 1),
          bhytCardNo: i % 2 ? `DN4010000000${i}` : null,
        },
      });

      // Lượt khám: xoay vòng trạng thái
      const statuses = ['WAITING', 'IN_EXAM', 'DONE', 'ADMITTED'];
      const st = pick(statuses, i);
      const enc = await prisma.encounter.create({
        data: {
          patientId: pt.id, type: st === 'ADMITTED' ? 'INPATIENT' : 'OUTPATIENT',
          departmentId: dept.id, doctorId: bs?.id, queueNo: i + 1, status: st,
        },
      });

      // Lượt đã khám trở lên: thêm chẩn đoán + đơn + bệnh án
      if (st === 'DONE' || st === 'IN_EXAM' || st === 'ADMITTED') {
        await prisma.diagnosis.create({ data: { encounterId: enc.id, icd10Code: pick(icds, i).code, type: 'PRIMARY', note: 'Chẩn đoán demo' } });
        const rx = await prisma.prescription.create({
          data: { encounterId: enc.id, doctorId: bs?.id, status: st === 'DONE' || st === 'ADMITTED' ? 'SIGNED' : 'DRAFT', signedAt: st === 'DONE' || st === 'ADMITTED' ? new Date() : null },
        });
        await prisma.prescriptionItem.create({ data: { prescriptionId: rx.id, drugId: pick(drugs, i).id, dose: '1 viên', frequency: '2 lần/ngày', durationDays: 5, quantity: 10 } });
        await prisma.medicalRecord.create({ data: { patientId: pt.id, encounterId: enc.id, summary: `Tóm tắt bệnh án demo cho ${names[i]}`, status: st === 'ADMITTED' ? 'OPEN' : 'SIGNED', signedBy: st === 'ADMITTED' ? null : bs?.id, signedAt: st === 'ADMITTED' ? null : new Date() } });
      }

      // Nhập viện: gán giường + sinh hiệu + y lệnh
      if (st === 'ADMITTED') {
        const bed = await prisma.bed.findFirst({ where: { status: 'EMPTY' } });
        if (bed) {
          await prisma.bed.update({ where: { id: bed.id }, data: { status: 'OCCUPIED' } });
          const adm = await prisma.admission.create({ data: { encounterId: enc.id, bedId: bed.id, status: 'ADMITTED' } });
          for (let h = 0; h < 4; h++) {
            await prisma.vitalSign.create({
              data: { admissionId: adm.id, bedId: bed.id, measuredAt: new Date(Date.now() - h * 3600000), hr: 70 + h * 3, spo2: 97 - (h % 3), temp: 36.8 + h * 0.1, bpSys: 118 + h, bpDia: 76 + h, source: 'IOT' },
            });
          }
          await prisma.careTask.create({ data: { admissionId: adm.id, nurseId: dd?.id, type: 'Đo sinh hiệu mỗi 4h', scheduledAt: new Date(), note: 'Theo dõi sát' } });
        }
      }

      // Lượt DONE: hóa đơn + thanh toán
      if (st === 'DONE') {
        const svc = pick(services, i);
        const inv = await prisma.invoice.create({
          data: { encounterId: enc.id, total: svc.price, bhytPart: Math.round(svc.price * 0.8), patientPart: Math.round(svc.price * 0.2), status: i % 2 ? 'PAID' : 'ISSUED' },
        });
        await prisma.invoiceItem.create({ data: { invoiceId: inv.id, refType: 'SERVICE', refId: svc.id, qty: 1, unitPrice: svc.price, amount: svc.price } });
        if (i % 2) {
          await prisma.payment.create({ data: { invoiceId: inv.id, amount: svc.price, method: 'CASH', receiptNo: `BL2026${seq}` } });
        }
      }

      // Lịch hẹn trực tuyến (tương lai)
      if (i % 3 === 0) {
        await prisma.appointment.create({ data: { patientId: pt.id, departmentId: dept.id, scheduledAt: new Date(Date.now() + (i + 1) * 86400000), channel: 'ONLINE', status: 'BOOKED' } });
      }
    }
    await prisma.configParam.create({ data: { key: 'demo.rich.seeded', value: new Date().toISOString(), scope: 'DEMO' } });
    console.log(`  + ${names.length} người bệnh kèm lượt khám/nội trú/đơn/hóa đơn/sinh hiệu`);
  }

  // Tài khoản người bệnh (NB) cho cổng trực tuyến — gắn với 1 patient thật
  if (!(await prisma.user.findUnique({ where: { username: 'nguoibenh' } }))) {
    const nbRole = await prisma.role.findUnique({ where: { code: 'NB' } });
    const firstPatient = await prisma.patient.findFirst({ orderBy: { code: 'asc' } });
    if (nbRole && firstPatient) {
      const u = await prisma.user.create({
        data: { username: 'nguoibenh', passwordHash: hash('nguoibenh123'), fullName: firstPatient.fullName, space: 'HOSPITAL' },
      });
      await prisma.userRole.create({ data: { userId: u.id, roleId: nbRole.id, dataScope: JSON.stringify([firstPatient.id]) } });
      // Liên kết người dùng ↔ người bệnh qua ConfigParam để cổng NB tra cứu.
      await prisma.configParam.upsert({ where: { key: `patient.link.${u.id}` }, update: { value: firstPatient.id }, create: { key: `patient.link.${u.id}`, value: firstPatient.id, scope: 'PATIENT_LINK' } });
      console.log(`  + tài khoản người bệnh nguoibenh/nguoibenh123 ↔ ${firstPatient.fullName}`);
    }
  }

  // Thông báo mẫu cho vài vai trò
  const notiTargets = ['bacsi', 'dieuduong', 'lanhdao'];
  for (const un of notiTargets) {
    const u = await prisma.user.findUnique({ where: { username: un } });
    if (u && (await prisma.notification.count({ where: { userId: u.id } })) === 0) {
      await prisma.notification.create({ data: { userId: u.id, type: 'CLINICAL', title: 'Thông báo demo', body: `Xin chào ${u.fullName}, đây là thông báo mẫu.`, severity: 'INFO' } });
      await prisma.notification.create({ data: { userId: u.id, type: 'OPS', title: 'Cảnh báo vận hành demo', body: 'Kiểm tra hệ thống định kỳ.', severity: 'WARN' } });
    }
  }

  const counts = {
    patients: await prisma.patient.count(), encounters: await prisma.encounter.count(),
    admissions: await prisma.admission.count(), prescriptions: await prisma.prescription.count(),
    invoices: await prisma.invoice.count(), vitals: await prisma.vitalSign.count(),
    notifications: await prisma.notification.count(), appointments: await prisma.appointment.count(),
  };
  console.log('  Thống kê:', JSON.stringify(counts));
  console.log('Seed demo xong.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
