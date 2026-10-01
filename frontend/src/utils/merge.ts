import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { RockMassGrade, Groundwater } from '../types/grade';
import type { WaterInflow, InflowType } from '../types/water';
import type { SketchSegment } from '../types/sketch';
import type { ArchivedVersion, ConflictPick, MergeMeta } from '../types/merge';
import { db, toPlain } from './db';
import { getDevice, type DeviceInfo } from './device';
import { newId, round } from './id';
import { estimateJv } from './geoMath';
import { GRADE_SUPPORT } from '../types/grade';
import { GROUNDWATER_K1, gradeFromBq, spanK2 } from '../hooks/useGradeCalc';

/** 交接文件（离线交接包） */
export interface MergeBundle {
  app: 'gbtunnelface';
  formatVersion: 1;
  device: DeviceInfo;
  exportedAt: number;
  faces: TunnelFace[];
  joints: Array<JointSet & { faceNo: string }>;
  grades: Array<RockMassGrade & { faceNo: string }>;
  waters: Array<WaterInflow & { faceNo: string }>;
  sketches: Record<string, SketchSegment[]>;
}

/** 本地数据（子记录已按 faceNo 认领，便于跨设备比对） */
export interface LocalData {
  faces: TunnelFace[];
  joints: Array<JointSet & { faceNo: string }>;
  grades: Array<RockMassGrade & { faceNo: string }>;
  waters: Array<WaterInflow & { faceNo: string }>;
  sketches: Record<string, SketchSegment[]>;
}

export type EntityType = 'face' | 'joint' | 'grade' | 'water';

/** 新增条目（保留来源与顺序） */
export interface PlanItem {
  entityType: EntityType;
  entityUid: string;
  faceNo: string;
  label: string;
  source: string;
  seq: number;
  data: unknown;
}

/** 冲突条目：同一对象两边都改 */
export interface ConflictItem {
  key: string;
  entityType: EntityType;
  faceNo: string;
  label: string;
  local: any;
  incoming: any;
  base?: any;
  pick: ConflictPick;
}

/** 重算计划 */
export interface RecomputeItem {
  faceNo: string;
  reason: string;
}

/** 合并计划（预览用，尚未写入） */
export interface MergePlan {
  mergeId: string;
  sourceDevice: DeviceInfo;
  exportedAt: number;
  added: PlanItem[];
  conflicts: ConflictItem[];
  /** 仅导入方改动、自动采用导入方版本 */
  autoIncoming: PlanItem[];
  /** 仅本地改动、自动保留本地版本 */
  autoLocal: PlanItem[];
  autoCount: number;
  unchangedCount: number;
  recomputations: RecomputeItem[];
  counts: { added: number; conflicts: number; autoUpdated: number; unchanged: number; recomputed: number };
}

export interface ApplyResult {
  added: number;
  conflicts: number;
  autoUpdated: number;
  recomputed: number;
  archived: number;
  mergeId: string;
}

const BASE_KEY = 'gbtunnelface:merge-base';
const SKETCH_PREFIX = 'gbtunnelface:sketch:';

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emptyLocal(): LocalData {
  return { faces: [], joints: [], grades: [], waters: [], sketches: {} };
}

/* ---------------- 包的构建与解析 ---------------- */

export function buildBundle(local: LocalData, device: DeviceInfo = getDevice()): MergeBundle {
  return {
    app: 'gbtunnelface',
    formatVersion: 1,
    device,
    exportedAt: Date.now(),
    faces: toPlain(local.faces),
    joints: toPlain(local.joints),
    grades: toPlain(local.grades),
    waters: toPlain(local.waters),
    sketches: local.sketches,
  };
}

export function parseBundle(text: string): { ok: true; bundle: MergeBundle } | { ok: false; error: string } {
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是有效的 JSON，可能在拷贝中损坏' };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '交接文件内容无效' };
  if (obj.app !== 'gbtunnelface') return { ok: false, error: '不是本系统的交接文件（缺少 gbtunnelface 标识）' };
  if (obj.formatVersion !== 1) return { ok: false, error: `不支持的交接文件版本 v${obj.formatVersion}（当前 v1）` };
  if (!obj.device || typeof obj.device.id !== 'string' || typeof obj.device.name !== 'string') {
    return { ok: false, error: '交接文件缺少设备信息' };
  }
  if (!Array.isArray(obj.faces) || !Array.isArray(obj.joints) || !Array.isArray(obj.grades) || !Array.isArray(obj.waters)) {
    return { ok: false, error: '交接文件缺少必要的数据段（faces/joints/grades/waters）' };
  }
  const sections: Array<[string, any[]]> = [
    ['faces', obj.faces],
    ['joints', obj.joints],
    ['grades', obj.grades],
    ['waters', obj.waters],
  ];
  for (const [name, arr] of sections) {
    for (const r of arr) {
      if (!r || typeof r !== 'object' || !r.id || !r.meta || typeof r.meta.uid !== 'string') {
        return { ok: false, error: `${name} 段中存在无效记录（缺少 id 或 meta.uid），文件可能已损坏` };
      }
    }
  }
  if (!obj.sketches || typeof obj.sketches !== 'object') obj.sketches = {};
  return { ok: true, bundle: obj as MergeBundle };
}

export function downloadBundle(bundle: MergeBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `gbtunnelface-交接-${bundle.device.name}-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- 本地数据读取与基准快照 ---------------- */

export function normalizeLocal(
  faces: TunnelFace[],
  joints: JointSet[],
  grades: RockMassGrade[],
  waters: WaterInflow[],
  sketches: Record<string, SketchSegment[]>,
): LocalData {
  const faceNoById = new Map(faces.map((f) => [f.id, f.faceNo]));
  const addFaceNo = <T extends { faceId: string }>(arr: T[]): Array<T & { faceNo: string }> =>
    arr.map((r) => ({ ...r, faceNo: faceNoById.get(r.faceId) ?? '' }));
  return { faces, joints: addFaceNo(joints), grades: addFaceNo(grades), waters: addFaceNo(waters), sketches };
}

export function loadLocalSketches(faces: TunnelFace[]): Record<string, SketchSegment[]> {
  const out: Record<string, SketchSegment[]> = {};
  for (const face of faces) {
    try {
      const raw = window.localStorage.getItem(`${SKETCH_PREFIX}${face.id}`);
      if (raw) out[face.faceNo] = JSON.parse(raw) as SketchSegment[];
    } catch {
      /* 忽略损坏的素描 */
    }
  }
  return out;
}

export async function loadLocalData(): Promise<LocalData> {
  const [faces, joints, grades, waters] = await Promise.all([
    db.faces.toArray(),
    db.joints.toArray(),
    db.grades.toArray(),
    db.waters.toArray(),
  ]);
  const sketches = loadLocalSketches(faces);
  return normalizeLocal(faces, joints, grades, waters, sketches);
}

export function saveBase(base: LocalData): void {
  try {
    window.localStorage.setItem(BASE_KEY, JSON.stringify(base));
  } catch {
    /* 忽略写入失败 */
  }
}

export function loadBase(): LocalData | null {
  try {
    const raw = window.localStorage.getItem(BASE_KEY);
    return raw ? (JSON.parse(raw) as LocalData) : null;
  } catch {
    return null;
  }
}

/** 首次启动（或无基准）时把当前数据存为同步基准 */
export async function ensureBaseSnapshot(): Promise<void> {
  if (loadBase()) return;
  const local = await loadLocalData();
  saveBase(local);
}

/* ---------------- 通用实体合并（三包合并） ---------------- */

interface MergeEntitiesResult<T> {
  merged: T[];
  conflicts: ConflictItem[];
  added: T[];
  autoIncoming: T[];
  autoLocal: T[];
  unchangedCount: number;
  affectedFaceNos: Set<string>;
}

function mergeEntities<T extends { meta: MergeMeta }>(
  local: T[],
  incoming: T[],
  base: T[],
  keyOf: (t: T) => string,
  ctx: { entityType: EntityType; labelOf: (t: T) => string; faceNoOf: (t: T) => string },
  pickFor: (c: ConflictItem) => ConflictPick,
): MergeEntitiesResult<T> {
  const lk = new Map(local.map((t) => [keyOf(t), t]));
  const ik = new Map(incoming.map((t) => [keyOf(t), t]));
  const bk = new Map(base.map((t) => [keyOf(t), t]));
  const keys = new Set<string>([...lk.keys(), ...ik.keys()]);
  const merged: T[] = [];
  const conflicts: ConflictItem[] = [];
  const added: T[] = [];
  const autoIncoming: T[] = [];
  const autoLocal: T[] = [];
  const affectedFaceNos = new Set<string>();
  let unchangedCount = 0;

  for (const key of keys) {
    const l = lk.get(key);
    const i = ik.get(key);
    const b = bk.get(key);
    if (l && !i) {
      merged.push(l);
      unchangedCount++;
      continue;
    }
    if (!l && i) {
      merged.push(i);
      added.push(i);
      affectedFaceNos.add(ctx.faceNoOf(i));
      continue;
    }
    if (!l || !i) continue; // key 来自并集，理论上不会走到
    if (deepEqual(l, i)) {
      merged.push(l);
      unchangedCount++;
      continue;
    }
    const lMod = b ? !deepEqual(l, b) : true;
    const iMod = b ? !deepEqual(i, b) : true;
    if (lMod && !iMod) {
      merged.push(l);
      autoLocal.push(l);
      affectedFaceNos.add(ctx.faceNoOf(l));
      continue;
    }
    if (iMod && !lMod) {
      merged.push(i);
      autoIncoming.push(i);
      affectedFaceNos.add(ctx.faceNoOf(i));
      continue;
    }
    // 两边都改（或无基准且不一致）→ 冲突，交地质员选主版本
    const conflict: ConflictItem = {
      key,
      entityType: ctx.entityType,
      faceNo: ctx.faceNoOf(i),
      label: ctx.labelOf(i),
      local: l,
      incoming: i,
      base: b,
      pick: 'incoming',
    };
    conflict.pick = pickFor(conflict);
    conflicts.push(conflict);
    merged.push(conflict.pick === 'local' ? l : i);
    affectedFaceNos.add(ctx.faceNoOf(i));
  }
  return { merged, conflicts, added, autoIncoming, autoLocal, unchangedCount, affectedFaceNos };
}

/** 素描线段按掌子面合并（只增不改，同 id 视为同一条） */
function mergeSketches(
  local: Record<string, SketchSegment[]>,
  incoming: Record<string, SketchSegment[]>,
): Record<string, SketchSegment[]> {
  const out: Record<string, SketchSegment[]> = {};
  const faceNos = new Set([...Object.keys(local), ...Object.keys(incoming)]);
  for (const no of faceNos) {
    const l = local[no] ?? [];
    const i = incoming[no] ?? [];
    const byId = new Map<string, SketchSegment>();
    for (const seg of l) byId.set(seg.id, seg);
    for (const seg of i) {
      if (!byId.has(seg.id)) byId.set(seg.id, seg);
    }
    out[no] = [...byId.values()];
  }
  return out;
}

function mergeAll(
  local: LocalData,
  incoming: MergeBundle,
  base: LocalData | null,
  pickFor: (c: ConflictItem) => ConflictPick,
) {
  const b = base ?? emptyLocal();
  const facesRes = mergeEntities(
    local.faces,
    incoming.faces,
    b.faces,
    (f) => f.faceNo,
    { entityType: 'face', labelOf: (f) => `掌子面 ${f.faceNo}`, faceNoOf: (f) => f.faceNo },
    pickFor,
  );
  const jointsRes = mergeEntities(
    local.joints,
    incoming.joints,
    b.joints,
    (j) => `${j.faceNo}|${j.setNo}`,
    { entityType: 'joint', labelOf: (j) => `${j.faceNo} J${j.setNo} 节理组`, faceNoOf: (j) => j.faceNo },
    pickFor,
  );
  const gradesRes = mergeEntities(
    local.grades,
    incoming.grades,
    b.grades,
    (g) => g.meta.uid,
    { entityType: 'grade', labelOf: (g) => `${g.faceNo} 围岩判定 ${g.grade} 级`, faceNoOf: (g) => g.faceNo },
    pickFor,
  );
  const watersRes = mergeEntities(
    local.waters,
    incoming.waters,
    b.waters,
    (w) => w.meta.uid,
    { entityType: 'water', labelOf: (w) => `${w.faceNo} 涌水 ${w.position}`, faceNoOf: (w) => w.faceNo },
    pickFor,
  );
  const sketches = mergeSketches(local.sketches, incoming.sketches);
  return {
    faces: facesRes.merged,
    joints: jointsRes.merged,
    grades: gradesRes.merged,
    waters: watersRes.merged,
    sketches,
    results: { faces: facesRes, joints: jointsRes, grades: gradesRes, waters: watersRes },
  };
}

/* ---------------- 预览：生成合并计划（不写入） ---------------- */

export function computeMergePlan(local: LocalData, incoming: MergeBundle, base: LocalData | null): MergePlan {
  const pickFor = (): ConflictPick => 'incoming';
  const all = mergeAll(local, incoming, base, pickFor);
  const conflicts: ConflictItem[] = [
    ...all.results.faces.conflicts,
    ...all.results.joints.conflicts,
    ...all.results.grades.conflicts,
    ...all.results.waters.conflicts,
  ];
  const toItem = (entityType: EntityType, d: any, label: string): PlanItem => ({
    entityType,
    entityUid: d.meta.uid,
    faceNo: d.faceNo,
    label,
    source: d.meta.source,
    seq: d.meta.seq,
    data: d,
  });
  const added: PlanItem[] = [
    ...all.results.faces.added.map((d) => toItem('face', d, `掌子面 ${d.faceNo}`)),
    ...all.results.joints.added.map((d) => toItem('joint', d, `J${d.setNo} 节理组`)),
    ...all.results.waters.added.map((d) => toItem('water', d, `涌水 ${d.position}`)),
    ...all.results.grades.added.map((d) => toItem('grade', d, `围岩判定 ${d.grade} 级`)),
  ];
  const autoIncoming: PlanItem[] = [
    ...all.results.faces.autoIncoming.map((d) => toItem('face', d, `掌子面 ${d.faceNo}`)),
    ...all.results.joints.autoIncoming.map((d) => toItem('joint', d, `J${d.setNo} 节理组`)),
    ...all.results.waters.autoIncoming.map((d) => toItem('water', d, `涌水 ${d.position}`)),
    ...all.results.grades.autoIncoming.map((d) => toItem('grade', d, `围岩判定 ${d.grade} 级`)),
  ];
  const autoLocal: PlanItem[] = [
    ...all.results.faces.autoLocal.map((d) => toItem('face', d, `掌子面 ${d.faceNo}`)),
    ...all.results.joints.autoLocal.map((d) => toItem('joint', d, `J${d.setNo} 节理组`)),
    ...all.results.waters.autoLocal.map((d) => toItem('water', d, `涌水 ${d.position}`)),
    ...all.results.grades.autoLocal.map((d) => toItem('grade', d, `围岩判定 ${d.grade} 级`)),
  ];
  const autoCount = autoIncoming.length + autoLocal.length;
  const unchangedCount =
    all.results.faces.unchangedCount +
    all.results.joints.unchangedCount +
    all.results.grades.unchangedCount +
    all.results.waters.unchangedCount;

  // 重算触发面：合并后节理组 / 涌水 / 掌子面与基准相比有变化，且该面已有围岩判定结论
  const recomputeFaceNos = recomputeFaceNosOf(all.faces, all.joints, all.waters, all.grades, base);
  const recomputations: RecomputeItem[] = recomputeFaceNos.map((no) => ({
    faceNo: no,
    reason: '节理组 / 涌水记录 / 掌子面信息有增改，围岩判定按最新数据重算',
  }));

  return {
    mergeId: newId('merge'),
    sourceDevice: incoming.device,
    exportedAt: incoming.exportedAt,
    added,
    conflicts,
    autoIncoming,
    autoLocal,
    autoCount,
    unchangedCount,
    recomputations,
    counts: {
      added: added.length,
      conflicts: conflicts.length,
      autoUpdated: autoCount,
      unchanged: unchangedCount,
      recomputed: recomputations.length,
    },
  };
}

/* ---------------- 围岩判定重算 ---------------- */

/** 合并后数据较基准有变化、且已有围岩判定结论的掌子面（需要重算） */
function recomputeFaceNosOf(
  faces: TunnelFace[],
  joints: Array<JointSet & { faceNo: string }>,
  waters: Array<WaterInflow & { faceNo: string }>,
  grades: Array<RockMassGrade & { faceNo: string }>,
  base: LocalData | null,
): string[] {
  const b = base ?? emptyLocal();
  const gradeFaceNos = new Set(grades.map((g) => g.faceNo));
  const allFaceNos = new Set<string>([...faces.map((f) => f.faceNo), ...b.faces.map((f) => f.faceNo)]);
  const out: string[] = [];
  for (const no of allFaceNos) {
    if (!gradeFaceNos.has(no)) continue;
    const mf = faces.find((f) => f.faceNo === no);
    if (!mf) continue;
    const bf = b.faces.find((f) => f.faceNo === no);
    if (!bf || !deepEqual(mf, bf)) {
      out.push(no);
      continue;
    }
    const mj = joints.filter((j) => j.faceNo === no);
    const bj = b.joints.filter((j) => j.faceNo === no);
    if (!deepEqual(mj, bj)) {
      out.push(no);
      continue;
    }
    const mw = waters.filter((w) => w.faceNo === no);
    const bw = b.waters.filter((w) => w.faceNo === no);
    if (!deepEqual(mw, bw)) out.push(no);
  }
  return out;
}

const INFLOW_TO_GROUNDWATER: Record<InflowType, Groundwater> = {
  渗水: '潮湿',
  滴水: '点滴状出水',
  线流: '线状出水',
  股状: '涌流状出水',
};

/** 依据最新掌子面 / 节理组 / 涌水记录重算围岩判定（不沿用旧结论） */
function recomputeGradeForFace(
  face: TunnelFace,
  joints: JointSet[],
  waters: WaterInflow[],
  prev: RockMassGrade | undefined,
): RockMassGrade {
  const rqd = prev?.rqd ?? 75;
  const kv = prev?.kv ?? 0.6;
  const spanWidth = prev?.spanWidth ?? (Number(face.faceSize.split('×')[0]) || 12);
  const jv = joints.length > 0 ? estimateJv(joints) : (prev?.jv ?? 0);
  const latestWater = [...waters].sort((a, b) => b.measuredAt - a.measuredAt)[0];
  const groundwater: Groundwater = latestWater ? INFLOW_TO_GROUNDWATER[latestWater.type] : (prev?.groundwater ?? '潮湿');
  const rockStrength = face.rockStrength;
  // BQ = 90 + 3σc + 250Kv
  const bq = round(90 + 3 * rockStrength + 250 * kv, 1);
  const k1 = GROUNDWATER_K1[groundwater] ?? 0;
  const k2 = spanK2(spanWidth);
  const correction = round(k1 + k2, 3);
  const correctedBq = round(bq - 100 * correction, 1);
  const grade = gradeFromBq(correctedBq);
  return {
    id: newId('grade'),
    faceId: face.id,
    grade,
    bqValue: bq,
    rqd,
    jv,
    kv,
    groundwater,
    spanWidth,
    correction,
    correctedBq,
    supportSuggestion: GRADE_SUPPORT[grade],
    manualAdjusted: false,
    judgedAt: Date.now(),
    meta: { uid: newId('uid'), source: 'merge-recompute', seq: 0 },
    recomputedByMerge: true,
  };
}

/* ---------------- 应用合并（事务提交，失败回滚） ---------------- */

export async function applyMerge(
  plan: MergePlan,
  local: LocalData,
  incoming: MergeBundle,
  base: LocalData | null,
): Promise<ApplyResult> {
  const pickFor = (c: ConflictItem): ConflictPick => {
    const found = plan.conflicts.find((p) => p.key === c.key && p.entityType === c.entityType);
    return found ? found.pick : 'incoming';
  };
  const all = mergeAll(local, incoming, base, pickFor);

  // 掌子面编号 → 合并后的掌子面 id（子记录统一认领）
  const mergedFaceIdByNo = new Map(all.faces.map((f) => [f.faceNo, f.id]));
  const remapChild = <T extends { faceId: string; faceNo: string }>(r: T): Omit<T, 'faceNo'> | null => {
    const fid = mergedFaceIdByNo.get(r.faceNo);
    if (!fid) return null; // 孤儿记录（掌子面缺失），跳过
    const { faceNo: _omit, ...rest } = r;
    return { ...rest, faceId: fid };
  };
  const mergedJoints = all.joints
    .map((r) => remapChild(r as JointSet & { faceNo: string }))
    .filter((r): r is JointSet => r !== null);
  const mergedWaters = all.waters
    .map((r) => remapChild(r as WaterInflow & { faceNo: string }))
    .filter((r): r is WaterInflow => r !== null);
  const mergedGradesBase = all.grades
    .map((r) => remapChild(r as RockMassGrade & { faceNo: string }))
    .filter((r): r is RockMassGrade => r !== null);

  // 重算关联围岩判定（依据最终合并结果较基准的变化，不沿用旧结论）
  const recomputedGrades: RockMassGrade[] = [];
  const recomputeFaceNos = recomputeFaceNosOf(all.faces, all.joints, all.waters, all.grades, base);
  for (const faceNo of recomputeFaceNos) {
    const face = all.faces.find((f) => f.faceNo === faceNo);
    if (!face) continue;
    const faceJoints = mergedJoints.filter((j) => j.faceId === face.id);
    const faceWaters = mergedWaters.filter((w) => w.faceId === face.id);
    const prev = [...mergedGradesBase]
      .filter((g) => g.faceId === face.id)
      .sort((a, b) => b.judgedAt - a.judgedAt)[0];
    const grade = recomputeGradeForFace(face, faceJoints, faceWaters, prev);
    recomputedGrades.push(grade);
  }
  const mergedGrades = [...mergedGradesBase, ...recomputedGrades];

  // 归档未选主版本（仍可查）
  const archives: ArchivedVersion[] = plan.conflicts.map((c) => {
    const alt = c.pick === 'local' ? c.incoming : c.local;
    return {
      id: newId('arch'),
      entityType: c.entityType,
      entityUid: alt?.meta?.uid ?? c.key,
      entityLabel: c.label,
      source: alt?.meta?.source ?? 'unknown',
      data: toPlain(alt),
      archivedAt: Date.now(),
      reason: 'conflict-alternative',
      mergeId: plan.mergeId,
    };
  });

  // 1) 先写素描到 localStorage（按掌子面编号认领；幂等，失败可重试）
  writeLocalSketches(all.sketches, mergedFaceIdByNo);

  // 2) 事务提交四张业务表 + 归档表；任何一步抛错整体回滚，保留原记录
  await db.transaction('rw', db.faces, db.joints, db.grades, db.waters, db.archive, async () => {
    await db.faces.clear();
    await db.faces.bulkPut(toPlain(all.faces));
    await db.joints.clear();
    await db.joints.bulkPut(toPlain(mergedJoints));
    await db.grades.clear();
    await db.grades.bulkPut(toPlain(mergedGrades));
    await db.waters.clear();
    await db.waters.bulkPut(toPlain(mergedWaters));
    await db.archive.bulkPut(toPlain(archives));
  });

  // 3) 保存新的同步基准
  const newBase = normalizeLocal(all.faces, mergedJoints, mergedGrades, mergedWaters, all.sketches);
  saveBase(newBase);

  return {
    added: plan.counts.added,
    conflicts: plan.counts.conflicts,
    autoUpdated: plan.counts.autoUpdated,
    recomputed: recomputedGrades.length,
    archived: archives.length,
    mergeId: plan.mergeId,
  };
}

function writeLocalSketches(sketches: Record<string, SketchSegment[]>, faceIdByNo: Map<string, string>): void {
  for (const [no, segs] of Object.entries(sketches)) {
    const fid = faceIdByNo.get(no);
    if (!fid) continue;
    try {
      window.localStorage.setItem(`${SKETCH_PREFIX}${fid}`, JSON.stringify(segs));
    } catch {
      /* 忽略写入失败 */
    }
  }
}
