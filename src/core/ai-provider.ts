// SHMS — Nhà cung cấp AI (abstraction).
//
// LƯU Ý (Q002): 9router HIỆN CHƯA có tài liệu/khóa API chính thức. Vì vậy mặc
// định toàn hệ thống dùng MockAiProvider — trả kết quả tất định, KHÔNG gọi mạng.
// KHÔNG bịa endpoint/giao thức của 9router ở đây. Khi có tài liệu + khóa thật,
// thêm `class NineRouterProvider implements AiProvider` (cùng interface) rồi đổi
// biến `aiProvider` để trỏ sang nó — phần router không phải sửa.
//
// Mọi kết quả đều gắn field `source: 'MOCK'` và chỉ mang tính GỢI Ý: cần nhân
// viên y tế xác nhận, KHÔNG auto-apply.

export const AI_DISCLAIMER = 'GỢI Ý AI — cần nhân viên y tế xác nhận';

// ---------- Kiểu dữ liệu đầu vào/đầu ra ----------
export interface TriageInput {
  symptoms: string; // mô tả triệu chứng (free text / từ khóa)
  age?: number;
  note?: string;
}
export interface TriageResult {
  source: 'MOCK';
  disclaimer: string;
  priority: 'EMERGENCY' | 'URGENT' | 'STANDARD' | 'NON_URGENT';
  level: number; // 1=khẩn cấp nhất .. 4
  suggestedDepartment: string;
  matchedKeywords: string[];
  rationale: string;
}

export interface VitalsSnapshot {
  hr?: number | null;
  spo2?: number | null;
  temp?: number | null;
  bpSys?: number | null;
  bpDia?: number | null;
}
export interface EarlyWarningInput {
  vitals: VitalsSnapshot;
  admissionId?: string;
}
export interface EarlyWarningResult {
  source: 'MOCK';
  disclaimer: string;
  score: number; // kiểu NEWS đơn giản hóa
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  flags: string[];
  recommendation: string;
}

export interface BedForecastInput {
  departmentId?: string;
  horizonHours?: number;
}
export interface BedForecastResult {
  source: 'MOCK';
  disclaimer: string;
  horizonHours: number;
  expectedAdmissions: number;
  expectedDischarges: number;
  projectedOccupancyPct: number;
  note: string;
}

export interface DrugInteractionInput {
  drugs: string[]; // danh sách tên/mã thuốc
}
export interface DrugInteractionPair {
  pair: [string, string];
  severity: 'MINOR' | 'MODERATE' | 'MAJOR';
  description: string;
}
export interface DrugInteractionResult {
  source: 'MOCK';
  disclaimer: string;
  interactions: DrugInteractionPair[];
  checkedPairs: number;
}

export interface AiProvider {
  triage(input: TriageInput): Promise<TriageResult>;
  earlyWarning(input: EarlyWarningInput): Promise<EarlyWarningResult>;
  bedForecast(input: BedForecastInput): Promise<BedForecastResult>;
  drugInteraction(input: DrugInteractionInput): Promise<DrugInteractionResult>;
}

// ---------- Mock tất định ----------

// Từ khóa triệu chứng → mức ưu tiên + khoa gợi ý. Thứ tự ưu tiên giảm dần.
const TRIAGE_RULES: {
  level: number;
  priority: TriageResult['priority'];
  dept: string;
  keywords: string[];
}[] = [
  {
    level: 1,
    priority: 'EMERGENCY',
    dept: 'Khoa Cấp cứu',
    keywords: ['ngừng thở', 'bất tỉnh', 'co giật', 'đau ngực', 'khó thở', 'xuất huyết', 'ngất', 'tím tái'],
  },
  {
    level: 2,
    priority: 'URGENT',
    dept: 'Khoa Nội',
    keywords: ['sốt cao', 'nôn', 'đau bụng dữ dội', 'khó thở nhẹ', 'chóng mặt', 'mất nước'],
  },
  {
    level: 3,
    priority: 'STANDARD',
    dept: 'Khoa Nội',
    keywords: ['sốt', 'ho', 'đau đầu', 'đau họng', 'tiêu chảy', 'đau bụng'],
  },
  {
    level: 4,
    priority: 'NON_URGENT',
    dept: 'Khoa Khám bệnh',
    keywords: ['mệt', 'sổ mũi', 'khám định kỳ', 'tư vấn', 'cấp thuốc'],
  },
];

// Cặp tương tác thuốc mẫu (chuẩn hóa chữ thường). Tất định.
const DRUG_INTERACTIONS: { a: string; b: string; severity: DrugInteractionPair['severity']; description: string }[] = [
  { a: 'warfarin', b: 'aspirin', severity: 'MAJOR', description: 'Tăng nguy cơ chảy máu nghiêm trọng.' },
  { a: 'warfarin', b: 'paracetamol', severity: 'MODERATE', description: 'Dùng kéo dài có thể tăng tác dụng chống đông.' },
  { a: 'amoxicillin', b: 'warfarin', severity: 'MODERATE', description: 'Kháng sinh có thể làm tăng INR.' },
  { a: 'omeprazole', b: 'clopidogrel', severity: 'MAJOR', description: 'Giảm hoạt hóa clopidogrel, giảm hiệu quả chống kết tập.' },
  { a: 'ibuprofen', b: 'aspirin', severity: 'MODERATE', description: 'NSAID phối hợp làm tăng nguy cơ loét/chảy máu tiêu hóa.' },
  { a: 'paracetamol', b: 'ibuprofen', severity: 'MINOR', description: 'Thường an toàn khi dùng đúng liều; theo dõi gan/thận.' },
];

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export class MockAiProvider implements AiProvider {
  async triage(input: TriageInput): Promise<TriageResult> {
    const text = norm(input.symptoms || '');
    for (const rule of TRIAGE_RULES) {
      const matched = rule.keywords.filter((k) => text.includes(k));
      if (matched.length > 0) {
        return {
          source: 'MOCK',
          disclaimer: AI_DISCLAIMER,
          priority: rule.priority,
          level: rule.level,
          suggestedDepartment: rule.dept,
          matchedKeywords: matched,
          rationale: `Khớp từ khóa (${matched.join(', ')}) → mức ${rule.level} ${rule.priority}.`,
        };
      }
    }
    // Không khớp → ưu tiên thấp, an toàn mặc định.
    return {
      source: 'MOCK',
      disclaimer: AI_DISCLAIMER,
      priority: 'STANDARD',
      level: 3,
      suggestedDepartment: 'Khoa Khám bệnh',
      matchedKeywords: [],
      rationale: 'Không khớp từ khóa khẩn cấp; phân loại mức trung bình để nhân viên đánh giá.',
    };
  }

  async earlyWarning(input: EarlyWarningInput): Promise<EarlyWarningResult> {
    const v = input.vitals || {};
    const flags: string[] = [];
    let score = 0;
    if (typeof v.spo2 === 'number') {
      if (v.spo2 < 92) { score += 3; flags.push('SpO2 thấp (<92%)'); }
      else if (v.spo2 < 95) { score += 1; flags.push('SpO2 giảm nhẹ'); }
    }
    if (typeof v.hr === 'number') {
      if (v.hr >= 130 || v.hr <= 40) { score += 3; flags.push('Nhịp tim nguy hiểm'); }
      else if (v.hr > 110 || v.hr < 50) { score += 1; flags.push('Nhịp tim bất thường'); }
    }
    if (typeof v.temp === 'number') {
      if (v.temp >= 39 || v.temp <= 35) { score += 2; flags.push('Nhiệt độ bất thường'); }
      else if (v.temp >= 38) { score += 1; flags.push('Sốt nhẹ'); }
    }
    if (typeof v.bpSys === 'number') {
      if (v.bpSys < 90 || v.bpSys >= 180) { score += 3; flags.push('Huyết áp tâm thu nguy hiểm'); }
    }
    const risk: EarlyWarningResult['risk'] = score >= 5 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW';
    const recommendation =
      risk === 'HIGH'
        ? 'Đánh giá khẩn, cân nhắc hồi sức / báo bác sĩ trực ngay.'
        : risk === 'MEDIUM'
        ? 'Theo dõi sát, đo lại dấu hiệu sinh tồn trong 1 giờ.'
        : 'Theo dõi thường quy.';
    return { source: 'MOCK', disclaimer: AI_DISCLAIMER, score, risk, flags, recommendation };
  }

  async bedForecast(input: BedForecastInput): Promise<BedForecastResult> {
    const horizonHours = input.horizonHours && input.horizonHours > 0 ? input.horizonHours : 24;
    // Tất định theo horizon (không random) để kết quả ổn định.
    const expectedAdmissions = Math.round(horizonHours / 6); // ~4/ngày
    const expectedDischarges = Math.round(horizonHours / 8); // ~3/ngày
    const projectedOccupancyPct = Math.min(100, 60 + expectedAdmissions * 4 - expectedDischarges * 3);
    return {
      source: 'MOCK',
      disclaimer: AI_DISCLAIMER,
      horizonHours,
      expectedAdmissions,
      expectedDischarges,
      projectedOccupancyPct,
      note: 'Dự báo mô phỏng tất định; chỉ để tham khảo điều phối giường.',
    };
  }

  async drugInteraction(input: DrugInteractionInput): Promise<DrugInteractionResult> {
    const drugs = (input.drugs || []).map(norm).filter(Boolean);
    const interactions: DrugInteractionPair[] = [];
    let checkedPairs = 0;
    for (let i = 0; i < drugs.length; i++) {
      for (let j = i + 1; j < drugs.length; j++) {
        checkedPairs++;
        const a = drugs[i];
        const b = drugs[j];
        const hit = DRUG_INTERACTIONS.find(
          (r) =>
            (a.includes(r.a) && b.includes(r.b)) || (a.includes(r.b) && b.includes(r.a)),
        );
        if (hit) {
          interactions.push({ pair: [drugs[i], drugs[j]], severity: hit.severity, description: hit.description });
        }
      }
    }
    return { source: 'MOCK', disclaimer: AI_DISCLAIMER, interactions, checkedPairs };
  }
}

// Mặc định hệ thống: Mock (9router chưa sẵn sàng — Q002).
export const aiProvider: AiProvider = new MockAiProvider();
