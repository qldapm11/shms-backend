// Seed dữ liệu QUY MÔ LỚN cho SHMS. Tạo ~300 người bệnh với lượt khám, nội trú,
// đơn thuốc, hóa đơn, thanh toán, sinh hiệu, lịch hẹn, thông báo. Idempotent qua marker.
// Chạy: npx tsx prisma/seed-bulk.ts  (có thể đặt COUNT qua env PATIENTS).
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PATIENTS = Number(process.env.PATIENTS || 300);

const HO = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý'];
const DEM = ['Văn', 'Thị', 'Hữu', 'Đức', 'Công', 'Thanh', 'Quang', 'Minh', 'Ngọc', 'Gia', 'Khánh', 'Hải'];
const TEN = ['An', 'Bình', 'Cường', 'Dũng', 'Hà', 'Hoa', 'Hùng', 'Lan', 'Linh', 'Mai', 'Nam', 'Nga', 'Phúc', 'Quân', 'Sơn', 'Tâm', 'Thảo', 'Trang', 'Tuấn', 'Vân', 'Yến', 'Đạt', 'Hương', 'Khoa', 'Loan', 'Nhung', 'Phương', 'Tùng'];

// PRNG tất định để lần chạy nào cũng ra dữ liệu như nhau.
let _s = 12345;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const ri = (n: number) => Math.floor(rnd() * n);
const pick = <T,>(a: T[]) => a[ri(a.length)];

async function main() {
  console.log(`Seed quy mô lớn: ${PATIENTS} người bệnh...`);
  if (await prisma.configParam.findUnique({ where: { key: 'demo.bulk.seeded' } })) {
    console.log('  Đã seed bulk (marker). Để chạy lại, xóa ConfigParam demo.bulk.seeded.');
    return;
  }

  const depts = await prisma.department.findMany();
  const bs = await prisma.user.findUnique({ where: { username: 'bacsi' } });
  const dd = await prisma.user.findUnique({ where: { username: 'dieuduong' } });
  const drugs = await prisma.drug.findMany();
  const services = await prisma.service.findMany();
  const icds = await prisma.icd10.findMany();
  if (!depts.length || !drugs.length || !services.length || !icds.length) {
    console.error('  Thiếu danh mục nền (chạy seed.ts trước).');
    process.exit(1);
  }

  // Xác định số thứ tự bắt đầu cho mã PID số thuần.
  const existing = await prisma.patient.findMany({ where: { code: { startsWith: 'PID2026' } }, select: { code: true } });
  let maxSeq = 0;
  for (const e of existing) { const t = e.code.slice(7); if (/^\d+$/.test(t)) maxSeq = Math.max(maxSeq, Number(t)); }

  const statuses = ['WAITING', 'IN_EXAM', 'DONE', 'DONE', 'ADMITTED', 'DISCHARGED'];
  let nAdm = 0, nRx = 0, nInv = 0, nVit = 0, nAppt = 0, nPay = 0;
  const now = Date.now();

  for (let i = 0; i < PATIENTS; i++) {
    maxSeq++;
    const seq = String(maxSeq).padStart(6, '0');
    const gender = rnd() < 0.5 ? 'Nam' : 'Nữ';
    const dem = gender === 'Nữ' ? 'Thị' : pick(DEM);
    const fullName = `${pick(HO)} ${dem} ${pick(TEN)}`;
    const dept = pick(depts);
    const createdAt = new Date(now - ri(90) * 86400000 - ri(86400000)); // rải 90 ngày

    const pt = await prisma.patient.create({
      data: {
        code: `PID2026${seq}`, fullName, gender,
        dob: new Date(1945 + ri(70), ri(12), 1 + ri(27)),
        phone: `09${String(10000000 + ri(89999999))}`,
        address: `${1 + ri(200)} đường ${pick(TEN)}, Quận ${1 + ri(12)}`,
        cccd: rnd() < 0.8 ? String(10 ** 11 + ri(9 * 10 ** 11)) : null,
        bhytCardNo: rnd() < 0.6 ? `DN4${String(10 ** 12 + ri(9 * 10 ** 11))}` : null,
        createdAt,
      },
    });

    const st = pick(statuses);
    const type = st === 'ADMITTED' || st === 'DISCHARGED' ? 'INPATIENT' : 'OUTPATIENT';
    const enc = await prisma.encounter.create({
      data: { patientId: pt.id, type, departmentId: dept.id, doctorId: bs?.id, queueNo: (i % 50) + 1, status: st, createdAt },
    });

    // Lịch hẹn cho ~30%
    if (rnd() < 0.3) {
      await prisma.appointment.create({ data: { patientId: pt.id, departmentId: dept.id, scheduledAt: new Date(now + ri(30) * 86400000), channel: rnd() < 0.5 ? 'ONLINE' : 'COUNTER', status: 'BOOKED' } });
      nAppt++;
    }

    // Đã khám trở lên: chẩn đoán + đơn + bệnh án
    if (['IN_EXAM', 'DONE', 'ADMITTED', 'DISCHARGED'].includes(st)) {
      const nDx = 1 + ri(2);
      for (let k = 0; k < nDx; k++) {
        await prisma.diagnosis.create({ data: { encounterId: enc.id, icd10Code: pick(icds).code, type: k === 0 ? 'PRIMARY' : 'SECONDARY', note: 'Chẩn đoán' } });
      }
      const signed = st !== 'IN_EXAM';
      const rx = await prisma.prescription.create({ data: { encounterId: enc.id, doctorId: bs?.id, status: signed ? 'SIGNED' : 'DRAFT', signedAt: signed ? createdAt : null, createdAt } });
      nRx++;
      const nItems = 1 + ri(3);
      for (let k = 0; k < nItems; k++) {
        await prisma.prescriptionItem.create({ data: { prescriptionId: rx.id, drugId: pick(drugs).id, dose: `${1 + ri(2)} viên`, frequency: `${1 + ri(3)} lần/ngày`, durationDays: 3 + ri(7), quantity: 10 + ri(20) } });
      }
      await prisma.medicalRecord.create({ data: { patientId: pt.id, encounterId: enc.id, summary: `Bệnh án ${fullName}: theo dõi và điều trị tại ${dept.name}.`, status: signed ? 'SIGNED' : 'OPEN', signedBy: signed ? bs?.id : null, signedAt: signed ? createdAt : null, createdAt } });
    }

    // Nội trú: giường + sinh hiệu + y lệnh
    if (st === 'ADMITTED' || st === 'DISCHARGED') {
      const bed = await prisma.bed.findFirst({ where: { status: 'EMPTY' } });
      const discharged = st === 'DISCHARGED';
      const adm = await prisma.admission.create({
        data: { encounterId: enc.id, bedId: bed?.id || null, admitAt: createdAt, dischargeAt: discharged ? new Date(createdAt.getTime() + (1 + ri(10)) * 86400000) : null, status: discharged ? 'DISCHARGED' : 'ADMITTED' },
      });
      nAdm++;
      if (bed && !discharged) await prisma.bed.update({ where: { id: bed.id }, data: { status: 'OCCUPIED' } });
      const nV = 3 + ri(6);
      for (let h = 0; h < nV; h++) {
        await prisma.vitalSign.create({ data: { admissionId: adm.id, bedId: bed?.id || null, measuredAt: new Date(createdAt.getTime() + h * 3600000), hr: 60 + ri(40), spo2: 92 + ri(8), temp: 36 + rnd() * 2.5, bpSys: 100 + ri(50), bpDia: 60 + ri(30), source: rnd() < 0.7 ? 'IOT' : 'MANUAL' } });
        nVit++;
      }
      await prisma.careTask.create({ data: { admissionId: adm.id, nurseId: dd?.id, type: pick(['Đo sinh hiệu', 'Thay băng', 'Cho uống thuốc', 'Vệ sinh cá nhân']), scheduledAt: createdAt, doneAt: rnd() < 0.6 ? createdAt : null } });
    }

    // Hóa đơn cho lượt DONE/DISCHARGED
    if (st === 'DONE' || st === 'DISCHARGED') {
      const nSvc = 1 + ri(3);
      let total = 0;
      const items: { refId: string; price: number }[] = [];
      for (let k = 0; k < nSvc; k++) { const s = pick(services); items.push({ refId: s.id, price: s.price }); total += s.price; }
      const paid = rnd() < 0.7;
      const inv = await prisma.invoice.create({
        data: { encounterId: enc.id, total, bhytPart: Math.round(total * 0.8), patientPart: Math.round(total * 0.2), status: paid ? 'PAID' : 'ISSUED', createdAt },
      });
      nInv++;
      for (const it of items) await prisma.invoiceItem.create({ data: { invoiceId: inv.id, refType: 'SERVICE', refId: it.refId, qty: 1, unitPrice: it.price, amount: it.price } });
      if (paid) { await prisma.payment.create({ data: { invoiceId: inv.id, amount: total, method: rnd() < 0.7 ? 'CASH' : 'CARD', receiptNo: `BL2026${seq}`, paidAt: createdAt } }); nPay++; }
    }

    if ((i + 1) % 50 === 0) console.log(`  ...${i + 1}/${PATIENTS}`);
  }

  // Thông báo cho nhân viên
  for (const un of ['bacsi', 'dieuduong', 'lanhdao', 'ketoan', 'duocsi']) {
    const u = await prisma.user.findUnique({ where: { username: un } });
    if (!u) continue;
    for (let k = 0; k < 5; k++) {
      await prisma.notification.create({ data: { userId: u.id, type: pick(['CLINICAL', 'OPS', 'REMINDER']), title: pick(['Nhắc lịch trực', 'Cảnh báo sinh hiệu', 'Đơn chờ duyệt', 'Báo cáo tuần', 'Bảo trì hệ thống']), body: 'Nội dung thông báo demo.', severity: pick(['INFO', 'WARN', 'CRITICAL']), readAt: rnd() < 0.5 ? new Date() : null } });
    }
  }

  await prisma.configParam.create({ data: { key: 'demo.bulk.seeded', value: new Date().toISOString(), scope: 'DEMO' } });

  const c = {
    patients: await prisma.patient.count(), encounters: await prisma.encounter.count(),
    admissions: await prisma.admission.count(), prescriptions: await prisma.prescription.count(),
    prescriptionItems: await prisma.prescriptionItem.count(), invoices: await prisma.invoice.count(),
    payments: await prisma.payment.count(), vitals: await prisma.vitalSign.count(),
    appointments: await prisma.appointment.count(), diagnoses: await prisma.diagnosis.count(),
    notifications: await prisma.notification.count(),
  };
  console.log('Thống kê:', JSON.stringify(c, null, 0));
  console.log(`Tạo thêm: ${nAdm} nội trú, ${nRx} đơn, ${nInv} hóa đơn, ${nPay} thanh toán, ${nVit} sinh hiệu, ${nAppt} lịch hẹn.`);
  console.log('Seed bulk xong.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
