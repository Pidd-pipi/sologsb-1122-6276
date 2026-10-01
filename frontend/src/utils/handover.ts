/**
 * 离线交接合并引擎。
 *
 * 模型：
 * - 掌子面按稳定业务编号 faceNo「认领」（跨平板 id 可能不同，不能按 id 对齐）。
 * - 节理/涌水/判定记录按 id 对齐；素描线段按 id 对齐、顺序合并。
 * - 每个掌子面与每台对端设备之间维护一份「同步基线」（上次成功合并时的快照），
 *   据此做三方判定：只一边改 → 直接采用；两边都改 → 列为冲突由地质员选主版本；
 *   落选内容写入 archives 归档表，仍可在「交接记录」里查看。
 * - 节理组或涌水记录发生并入变化后，关联掌子面的围岩判定必须按新数据重算，
 *   旧判定留存并标记被哪条新判定替换，不允许沿用旧结论。
 * - 合并在单个 Dexie 事务内完成；IndexedDB 由事务回滚，localStorage 素描先备份，
 *   失败时恢复，并把失败会话（含原包与已做选择）落库，原记录不动，可重试。
 */
import { db, toPlain } from './db';
import { newId } from './id';
import { getDeviceId, getDeviceName, getGeologist, stampProvenance } from './device';
import { loadAllSketches, loadSketch, saveSketch, sketchSignature } from './sketchStore';
import { estimateJv } from './geoMath';
import { GROUNDWATER_K1, gradeFromBq, spanK2 } from '../hooks/useGradeCalc';
import { GRADE_SUPPORT, type Groundwater, type RockMassGrade } from '../types/grade';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { WaterInflow } from '../types/water';
import {
  HANDOVER_BUNDLE_VERSION,
  type ArchiveEntry,
  type HandoverBundle,
  type MergeBase,
  type MergeSession,
  type SketchSegmentPayload,
} from '../types/sync';

type TableName = 'faces' | 'joints' | 'waters' | 'grades';

/** 合并完成后通知各页面刷新内存 store */
export const MERGE_EVENT = 'gbtunnelface:merged';

export class MergeValidationError extends Error {}

// ---------------------------------------------------------------------------
// 交接包：导出 / 解析
// ---------------------------------------------------------------------------

export async function createBundle(): Promise<HandoverBundle> {
  const [faces, joints, waters, grades] = await Promise.all([
    db.faces.toArray(),
    db.joints.toArray(),
    db.waters.toArray(),
    db.grades.toArray(),
  ]);
  // 子记录按设备内录入顺序（seq）导出，缺 seq 的老记录回退到业务顺序
  const bySeq = <T extends { provenance?: { seq?: number } }>(a: T, b: T) => (a.provenance?.seq ?? 0) - (b.provenance?.seq ?? 0);
  return {
    format: 'gbtunnelface-handover',
    bundleVersion: HANDOVER_BUNDLE_VERSION,
    deviceId: getDeviceId(),
    deviceName: getDeviceName(),
    geologist: getGeologist(),
    exportedAt: Date.now(),
    faces: toPlain([...faces].sort((a, b) => a.recordedAt - b.recordedAt)),
    joints: toPlain([...joints].sort(bySeq)),
    waters: toPlain([...waters].sort(bySeq)),
    grades: toPlain([...grades].sort((a, b) => a.judgedAt - b.judgedAt)),
    sketches: toPlain(loadAllSketches()),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 解析并做最小结构校验；同机自导包直接拒绝 */
export function parseBundle(text: string): HandoverBundle {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new MergeValidationError(`交接包不是合法 JSON：${(e as Error).message}`);
  }
  if (!isObject(data) || data.format !== 'gbtunnelface-handover') {
    throw new MergeValidationError('缺少交接包标识（format=gbtunnelface-handover），文件可能不是本系统导出的');
  }
  const b = data as unknown as HandoverBundle;
  if (!b.deviceId || !Array.isArray(b.faces)) {
    throw new MergeValidationError('交接包缺少设备标识或掌子面数据');
  }
  if (b.deviceId === getDeviceId()) {
    throw new MergeValidationError('这是本机导出的交接包，无需导回本机');
  }
  for (const key of ['joints', 'waters', 'grades'] as const) {
    if (!Array.isArray(b[key])) throw new MergeValidationError(`交接包 ${key} 字段损坏`);
  }
  const faceNos = new Set(b.faces.map((f) => f.faceNo));
  if (faceNos.size !== b.faces.length) {
    throw new MergeValidationError('交接包内掌子面编号重复，无法按稳定编号认领');
  }
  if (!b.sketches || typeof b.sketches !== 'object') b.sketches = {};
  return b;
}

// ---------------------------------------------------------------------------
// 字段差异展示
// ---------------------------------------------------------------------------

interface FieldLabel {
  field: string;
  label: string;
}

const FIELD_LABELS: Record<TableName, FieldLabel[]> = {
  faces: [
    { field: 'chainage', label: '里程桩号' },
    { field: 'mileageRange', label: '里程区间' },
    { field: 'excavationMethod', label: '开挖方式' },
    { field: 'faceSize', label: '断面尺寸' },
    { field: 'lithology', label: '岩性' },
    { field: 'weathering', label: '风化程度' },
    { field: 'rockStrength', label: '饱和抗压强度' },
    { field: 'attitude', label: '岩层产状' },
    { field: 'geologist', label: '地质员' },
  ],
  joints: [
    { field: 'setNo', label: '组号' },
    { field: 'dipDirection', label: '倾向' },
    { field: 'dipAngle', label: '倾角' },
    { field: 'spacing', label: '间距 cm' },
    { field: 'persistence', label: '延伸 m' },
    { field: 'aperture', label: '张开度 mm' },
    { field: 'fillMaterial', label: '充填物' },
    { field: 'roughness', label: '粗糙度' },
    { field: 'waterWet', label: '渗水状态' },
    { field: 'jointCount', label: '条数' },
  ],
  waters: [
    { field: 'position', label: '出水部位' },
    { field: 'type', label: '出水类型' },
    { field: 'estimatedFlow', label: '涌水量 L/min' },
    { field: 'waterTemp', label: '水温 ℃' },
    { field: 'waterPressure', label: '水压 MPa' },
    { field: 'changeTrend', label: '变化趋势' },
    { field: 'chainage', label: '里程位置' },
  ],
  grades: [
    { field: 'grade', label: '围岩级别' },
    { field: 'bqValue', label: 'BQ' },
    { field: 'correctedBq', label: '[BQ]' },
    { field: 'rqd', label: 'RQD %' },
    { field: 'jv', label: 'Jv' },
    { field: 'kv', label: 'Kv' },
    { field: 'groundwater', label: '出水状态' },
    { field: 'spanWidth', label: '洞跨 m' },
    { field: 'correction', label: '修正系数' },
    { field: 'manualAdjusted', label: '人工修正' },
    { field: 'supportSuggestion', label: '支护建议' },
  ],
};

function fieldValue(table: TableName, field: string, record: Record<string, unknown>): unknown {
  if (field === 'attitude' && isObject(record.attitude)) {
    const a = record.attitude as { strike?: number; dipDirection?: number; dipAngle?: number };
    return `${a.strike ?? '?'}/${a.dipDirection ?? '?'}∠${a.dipAngle ?? '?'}`;
  }
  if (field === 'mileageRange' && Array.isArray(record.mileageRange)) {
    return `${record.mileageRange[0]} ~ ${record.mileageRange[1]}`;
  }
  if (field === 'manualAdjusted') return record.manualAdjusted ? '是' : '否';
  return record[field];
}

export interface FieldDiff {
  label: string;
  local: unknown;
  incoming: unknown;
}

function diffRecords(table: TableName, local: Record<string, unknown>, incoming: Record<string, unknown>): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const { field, label } of FIELD_LABELS[table]) {
    const lv = fieldValue(table, field, local);
    const iv = fieldValue(table, field, incoming);
    if (JSON.stringify(lv) !== JSON.stringify(iv)) {
      diffs.push({ label, local: lv ?? '—', incoming: iv ?? '—' });
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// 合并计划
// ---------------------------------------------------------------------------

export type ResolutionSide = 'local' | 'incoming';
export type Resolutions = Record<string, ResolutionSide>;

export interface ConflictRecord {
  /** 地质员选择用的键 */
  key: string;
  faceNo: string;
  table: TableName | 'sketches';
  entityId: string;
  /** 冲突标题，如「节理组 J2」 */
  title: string;
  local: unknown;
  incoming: unknown;
  fields: FieldDiff[];
}

export interface PendingAdd {
  table: TableName;
  record: Record<string, unknown>;
  title: string;
  deviceName: string;
}

export type SketchStatus = 'none' | 'add' | 'clean' | 'conflict';

export interface FaceMergePlan {
  faceNo: string;
  /** 本机不存在、整份新认领 */
  isNew: boolean;
  /** 本机侧掌子面 id（认领后的规范 id） */
  localFaceId?: string;
  /** 导包侧掌子面 id */
  incomingFaceId: string;
  incomingFace: TunnelFace;
  localFace?: TunnelFace;
  faceConflict?: ConflictRecord;
  /** 对端单边改过的掌子面基本信息（无冲突直接采用） */
  faceTakeIncoming: boolean;
  adds: PendingAdd[];
  /** 对端单边改过的子记录 id 列表 */
  incomingUpdates: { table: TableName; id: string }[];
  conflicts: ConflictRecord[];
  sketch: {
    status: SketchStatus;
    localSegs: SketchSegmentPayload[];
    incomingSegs: SketchSegmentPayload[];
    /** status=clean 时的合并结果 */
    mergedSegs: SketchSegmentPayload[];
    conflict?: ConflictRecord;
  };
  /** 节理或涌水在本次有并入变化，需要重算围岩判定 */
  recomputeNeeded: boolean;
}

export interface MergePlan {
  bundle: HandoverBundle;
  peer: { deviceId: string; deviceName: string };
  faces: FaceMergePlan[];
  conflictCount: number;
  addCount: number;
}

function recordTitle(table: TableName, record: Record<string, unknown>): string {
  if (table === 'faces') return `掌子面 ${String(record.faceNo)}`;
  if (table === 'joints') return `节理组 J${String(record.setNo)}`;
  if (table === 'waters') return `涌水·${String(record.position ?? '')}（${String(record.type ?? '')}）`;
  return `围岩判定 ${String(record.grade ?? '')} 级`;
}

interface SnapshotMaps {
  faces: Map<string, Record<string, unknown>>;
  joints: Map<string, Record<string, unknown>>;
  waters: Map<string, Record<string, unknown>>;
  grades: Map<string, Record<string, unknown>>;
}

/** 三方分类：返回 add / take-incoming / conflict，其余（未变或只本机改）无动作 */
function classify(
  table: TableName,
  local: Record<string, unknown>,
  incoming: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
  ctx: { faceNo: string; keyId: string },
): Omit<ConflictRecord, 'key'> & { action: 'none' | 'take-incoming' | 'conflict' } {
  const title = recordTitle(table, incoming);
  const fields = diffRecords(table, local, incoming);
  if (fields.length === 0) return { action: 'none', faceNo: ctx.faceNo, table, entityId: ctx.keyId, title, local, incoming, fields: [] };

  const localChanged = base ? JSON.stringify(stripForCompare(local)) !== JSON.stringify(stripForCompare(base)) : true;
  const incomingChanged = base ? JSON.stringify(stripForCompare(incoming)) !== JSON.stringify(stripForCompare(base)) : true;

  if (base && incomingChanged && !localChanged) {
    return { action: 'take-incoming', faceNo: ctx.faceNo, table, entityId: ctx.keyId, title, local, incoming, fields };
  }
  // 无基线无法证明只有一边改过：保守地全部列为冲突，绝不静默覆盖现场记录
  if (base && localChanged && !incomingChanged) {
    return { action: 'none', faceNo: ctx.faceNo, table, entityId: ctx.keyId, title, local, incoming, fields };
  }
  return { action: 'conflict', faceNo: ctx.faceNo, table, entityId: ctx.keyId, title, local, incoming, fields };
}

/** 比较时忽略合并戳记（updatedAt 等不构成业务差异） */
function stripForCompare(record: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...record };
  delete clone.provenance;
  delete clone.recomputedAfterMerge;
  delete clone.supersedesGradeIds;
  return clone;
}

export async function buildMergePlan(bundle: HandoverBundle): Promise<MergePlan> {
  const [localFaces, localJoints, localWaters, localGrades, bases] = await Promise.all([
    db.faces.toArray(),
    db.joints.toArray(),
    db.waters.toArray(),
    db.grades.toArray(),
    db.mergeBases.where('peerDeviceId').equals(bundle.deviceId).toArray(),
  ]);

  const localFaceByNo = new Map(localFaces.map((f) => [f.faceNo, f]));
  const baseByFaceNo = new Map(bases.map((b) => [b.faceNo, b]));

  const plans: FaceMergePlan[] = [];

  for (const incomingFace of bundle.faces) {
    const faceNo = incomingFace.faceNo;
    const localFace = localFaceByNo.get(faceNo);
    const base = baseByFaceNo.get(faceNo);
    const isNew = !localFace;
    const canonicalId = localFace?.id ?? incomingFace.id;

    const localChildren: SnapshotMaps = {
      faces: new Map(),
      joints: new Map(localJoints.filter((j) => j.faceId === canonicalId).map((j) => [j.id, j as unknown as Record<string, unknown>])),
      waters: new Map(localWaters.filter((w) => w.faceId === canonicalId).map((w) => [w.id, w as unknown as Record<string, unknown>])),
      grades: new Map(localGrades.filter((g) => g.faceId === canonicalId).map((g) => [g.id, g as unknown as Record<string, unknown>])),
    };
    const incomingChildren = {
      joints: bundle.joints.filter((j) => j.faceId === incomingFace.id),
      waters: bundle.waters.filter((w) => w.faceId === incomingFace.id),
      grades: bundle.grades.filter((g) => g.faceId === incomingFace.id),
    };

    const adds: PendingAdd[] = [];
    const incomingUpdates: FaceMergePlan['incomingUpdates'] = [];
    const conflicts: ConflictRecord[] = [];
    let recomputeNeeded = false;

    const baseMaps: SnapshotMaps = {
      faces: new Map(Object.entries(base?.faces ?? {})) as Map<string, Record<string, unknown>>,
      joints: new Map(Object.entries(base?.joints ?? {})) as Map<string, Record<string, unknown>>,
      waters: new Map(Object.entries(base?.waters ?? {})) as Map<string, Record<string, unknown>>,
      grades: new Map(Object.entries(base?.grades ?? {})) as Map<string, Record<string, unknown>>,
    };

    // 掌子面基本信息
    let faceConflict: ConflictRecord | undefined;
    let faceTakeIncoming = false;
    if (isNew) {
      adds.push({ table: 'faces', record: incomingFace as unknown as Record<string, unknown>, title: recordTitle('faces', incomingFace as unknown as Record<string, unknown>), deviceName: bundle.deviceName });
    } else {
      const r = classify(
        'faces',
        localFace as unknown as Record<string, unknown>,
        incomingFace as unknown as Record<string, unknown>,
        baseMaps.faces.get(localFace.id) as Record<string, unknown> | undefined,
        { faceNo, keyId: canonicalId },
      );
      if (r.action === 'conflict') {
        faceConflict = { ...r, key: `faces:${faceNo}` };
        conflicts.push(faceConflict);
      } else if (r.action === 'take-incoming') {
        faceTakeIncoming = true;
      }
    }

    const childTables: { table: TableName; incoming: { id: string }[]; local: Map<string, Record<string, unknown>> }[] = [
      { table: 'joints', incoming: incomingChildren.joints, local: localChildren.joints },
      { table: 'waters', incoming: incomingChildren.waters, local: localChildren.waters },
      { table: 'grades', incoming: incomingChildren.grades, local: localChildren.grades },
    ];

    for (const { table, incoming, local } of childTables) {
      for (const incRecord of incoming) {
        const inc = incRecord as unknown as Record<string, unknown>;
        const localRecord = local.get(String(inc.id));
        if (!localRecord) {
          if (!isNew) {
            adds.push({ table, record: inc, title: recordTitle(table, inc), deviceName: bundle.deviceName });
            if (table === 'joints' || table === 'waters') recomputeNeeded = true;
          }
          continue;
        }
        const r = classify(table, localRecord, inc, baseMaps[table].get(String(inc.id)) as Record<string, unknown> | undefined, {
          faceNo,
          keyId: String(inc.id),
        });
        if (r.action === 'take-incoming') {
          incomingUpdates.push({ table, id: String(inc.id) });
          if (table === 'joints' || table === 'waters') recomputeNeeded = true;
        } else if (r.action === 'conflict') {
          const conflict = { ...r, key: `${table}:${String(inc.id)}` };
          conflicts.push(conflict);
          if (table === 'joints' || table === 'waters') recomputeNeeded = true;
        }
      }
    }

    // 新掌子面的子记录全部算新增
    if (isNew) {
      for (const j of incomingChildren.joints) {
        adds.push({ table: 'joints', record: j as unknown as Record<string, unknown>, title: recordTitle('joints', j as unknown as Record<string, unknown>), deviceName: bundle.deviceName });
      }
      for (const w of incomingChildren.waters) {
        adds.push({ table: 'waters', record: w as unknown as Record<string, unknown>, title: recordTitle('waters', w as unknown as Record<string, unknown>), deviceName: bundle.deviceName });
      }
      for (const g of incomingChildren.grades) {
        adds.push({ table: 'grades', record: g as unknown as Record<string, unknown>, title: recordTitle('grades', g as unknown as Record<string, unknown>), deviceName: bundle.deviceName });
      }
    }

    // 素描线段（localStorage，按规范 id 读）
    const localSegs = isNew ? [] : loadSketch(canonicalId);
    const incomingSegs = (bundle.sketches[incomingFace.id] ?? []).map((s) => ({ ...s }));
    const sketch = planSketch(faceNo, canonicalId, localSegs, incomingSegs, base?.sketches[canonicalId] ?? base?.sketches[incomingFace.id]);
    if (sketch.status === 'conflict' && sketch.conflict) conflicts.push(sketch.conflict);

    plans.push({
      faceNo,
      isNew,
      localFaceId: localFace?.id,
      incomingFaceId: incomingFace.id,
      incomingFace,
      localFace,
      faceConflict,
      faceTakeIncoming,
      adds,
      incomingUpdates,
      conflicts,
      sketch,
      recomputeNeeded,
    });
  }

  return {
    bundle,
    peer: { deviceId: bundle.deviceId, deviceName: bundle.deviceName },
    faces: plans,
    conflictCount: plans.reduce((s, p) => s + p.conflicts.length, 0),
    addCount: plans.reduce((s, p) => s + p.adds.length, 0),
  };
}

/**
 * 素描三方合并：
 * - 两边都只新增（含各自新增互不重叠）→ 按「基线 → 本机新增 → 对端新增」保序并集。
 * - 一边删/清空、另一边新增或改动 → 冲突，地质员选主版本，落选线段归档可查。
 * - 仅一边增删 → 采用该边结果。
 */
function planSketch(
  faceNo: string,
  canonicalId: string,
  localSegs: SketchSegmentPayload[],
  incomingSegs: SketchSegmentPayload[],
  baseSketch: { ids: string[]; signature: string } | undefined,
): FaceMergePlan['sketch'] {
  if (localSegs.length === 0 && incomingSegs.length === 0) {
    return { status: 'none', localSegs, incomingSegs, mergedSegs: [] };
  }
  if (localSegs.length === 0) {
    return { status: 'add', localSegs, incomingSegs, mergedSegs: dedupeSegments([], incomingSegs) };
  }

  const localById = new Map(localSegs.map((s) => [s.id, s]));
  const incomingById = new Map(incomingSegs.map((s) => [s.id, s]));
  const baseIds = new Set(baseSketch?.ids ?? []);
  const hasBase = Boolean(baseSketch);

  const addedLocal = localSegs.filter((s) => !baseIds.has(s.id));
  const addedIncoming = incomingSegs.filter((s) => !baseIds.has(s.id));
  const removedLocal = [...baseIds].filter((id) => !localById.has(id));
  const removedIncoming = [...baseIds].filter((id) => !incomingById.has(id));
  const localChanged = hasBase ? sketchSignature(localSegs) !== baseSketch!.signature : true;
  const incomingChanged = hasBase ? sketchSignature(incomingSegs) !== baseSketch!.signature : true;

  const bothTouched = localChanged && incomingChanged;
  const deletionsVsAdditions =
    (removedLocal.length > 0 && addedIncoming.length > 0) || (removedIncoming.length > 0 && addedLocal.length > 0);
  const divergentDeletions =
    removedLocal.length > 0 && removedIncoming.length > 0 && JSON.stringify(removedLocal.sort()) !== JSON.stringify(removedIncoming.sort());

  if (hasBase && bothTouched && (deletionsVsAdditions || divergentDeletions)) {
    const conflict: ConflictRecord = {
      key: `sketches:${faceNo}`,
      faceNo,
      table: 'sketches',
      entityId: canonicalId,
      title: `素描线段（本机 ${localSegs.length} 条 / 对端 ${incomingSegs.length} 条）`,
      local: localSegs,
      incoming: incomingSegs,
      fields: [
        { label: '线段数量', local: localSegs.length, incoming: incomingSegs.length },
        { label: '情形', local: `删除 ${removedLocal.length} 条 / 新增 ${addedLocal.length} 条`, incoming: `删除 ${removedIncoming.length} 条 / 新增 ${addedIncoming.length} 条` },
      ],
    };
    return { status: 'conflict', localSegs, incomingSegs, mergedSegs: [], conflict };
  }

  if (!hasBase && sketchSignature(localSegs) !== sketchSignature(incomingSegs)) {
    // 没有基线又对不上：两边线段 id 互不重叠时视为各自新增，可保序并集；否则才冲突
    const overlap = incomingSegs.some((s) => localById.has(s.id));
    if (!overlap) {
      return { status: 'clean', localSegs, incomingSegs, mergedSegs: dedupeSegments(localSegs, incomingSegs) };
    }
    const conflict: ConflictRecord = {
      key: `sketches:${faceNo}`,
      faceNo,
      table: 'sketches',
      entityId: canonicalId,
      title: `素描线段（无同步基线，两边不一致）`,
      local: localSegs,
      incoming: incomingSegs,
      fields: [{ label: '线段数量', local: localSegs.length, incoming: incomingSegs.length }],
    };
    return { status: 'conflict', localSegs, incomingSegs, mergedSegs: [], conflict };
  }

  const merged = dedupeSegments(localSegs, addedIncoming);
  const changed = merged.length !== localSegs.length || sketchSignature(merged) !== sketchSignature(localSegs);
  return { status: changed ? 'clean' : 'none', localSegs, incomingSegs, mergedSegs: merged };
}

/** 对端新增线段并入本机：内容完全相同的去重，id 撞车但内容不同的换新 id */
function dedupeSegments(localSegs: SketchSegmentPayload[], incomingAdds: SketchSegmentPayload[]): SketchSegmentPayload[] {
  const merged = localSegs.map((s) => ({ ...s }));
  const existingSig = new Set(merged.map((s) => sketchSignature([s])));
  const existingIds = new Set(merged.map((s) => s.id));
  incomingAdds.forEach((seg, index) => {
    const sig = sketchSignature([seg]);
    if (existingSig.has(sig)) return;
    let id = seg.id;
    if (existingIds.has(id)) id = `seg_m_${Date.now().toString(36)}_${index}`;
    existingIds.add(id);
    existingSig.add(sig);
    merged.push({ ...seg, id });
  });
  return merged;
}

// ---------------------------------------------------------------------------
// 围岩判定重算
// ---------------------------------------------------------------------------

const WATER_GROUNDWATER_RANK: { type: string; groundwater: Groundwater; rank: number }[] = [
  { type: '渗水', groundwater: '潮湿', rank: 1 },
  { type: '滴水', groundwater: '点滴状出水', rank: 2 },
  { type: '线流', groundwater: '线状出水', rank: 3 },
  { type: '股状', groundwater: '涌流状出水', rank: 4 },
];

/** Jv → Kv 的简化映射（无历史判定可沿用 Kv 时使用，对应岩体完整性分级） */
export function kvFromJv(jv: number): number {
  if (jv <= 0) return 0.75;
  if (jv < 3) return 0.85;
  if (jv < 10) return 0.75 - ((jv - 3) / 7) * 0.2;
  if (jv < 20) return 0.55 - ((jv - 10) / 10) * 0.2;
  if (jv < 35) return 0.35 - ((jv - 20) / 15) * 0.2;
  return 0.1;
}

export interface RecomputeOutcome {
  record: RockMassGrade;
  changed: boolean;
  reasons: string[];
}

/**
 * 按合并后的节理/涌水重算围岩判定。
 * RQD/洞跨等未在本次编录里改动的输入沿用最近一次判定，但 BQ、[BQ]、级别、
 * 地下水修正一律重算——结论本身绝不沿用。
 */
export function recomputeGrade(
  face: TunnelFace,
  joints: JointSet[],
  waters: WaterInflow[],
  previous: RockMassGrade | undefined,
): RecomputeOutcome {
  const reasons: string[] = [];
  const jv = estimateJv(joints);
  const kv = previous?.kv && previous.kv > 0 ? previous.kv : kvFromJv(jv);
  const rqd = previous?.rqd ?? 75;
  const spanWidth = previous?.spanWidth ?? (Number(face.faceSize.split('×')[0]) || 12);
  const rockStrength = face.rockStrength;

  let groundwater: Groundwater = previous?.groundwater ?? '干燥';
  const worst = waters.reduce<number>((max, w) => {
    const hit = WATER_GROUNDWATER_RANK.find((x) => x.type === w.type);
    return hit ? Math.max(max, hit.rank) : max;
  }, 0);
  const hit = WATER_GROUNDWATER_RANK.find((x) => x.rank === worst);
  if (hit) {
    groundwater = hit.groundwater;
    reasons.push(`涌水最严重为「${hit.groundwater}」，K1 取 ${GROUNDWATER_K1[groundwater]}`);
  }

  const priorExtra = previous
    ? Math.max(0, Number((previous.correction - (GROUNDWATER_K1[previous.groundwater] ?? 0) - spanK2(previous.spanWidth)).toFixed(3)))
    : 0;
  const k1 = GROUNDWATER_K1[groundwater] ?? 0;
  const k2 = spanK2(spanWidth);
  const correction = Number((k1 + k2 + priorExtra).toFixed(3));
  const bq = Math.round((90 + 3 * rockStrength + 250 * kv) * 10) / 10;
  const correctedBq = Math.round((bq - 100 * correction) * 10) / 10;
  const grade = gradeFromBq(correctedBq);
  reasons.push(`按合并后 ${joints.length} 组节理估算 Jv=${jv}，BQ=${bq}，[BQ]=${correctedBq}`);

  const changed =
    !previous ||
    previous.grade !== grade ||
    Number(previous.correctedBq) !== correctedBq ||
    previous.groundwater !== groundwater ||
    Number(previous.jv) !== jv ||
    Number(previous.kv) !== kv;

  const record: RockMassGrade = {
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
    provenance: stampProvenance(),
    recomputedAfterMerge: true,
    supersedesGradeIds: previous ? [previous.id] : [],
  };
  return { record, changed, reasons };
}

// ---------------------------------------------------------------------------
// 执行合并
// ---------------------------------------------------------------------------

export interface MergeOutcome {
  ok: boolean;
  sessionId: string;
  summary: string;
  errorMessage?: string;
  recomputed: { faceNo: string; grade: string; changed: boolean }[];
}

function assertAllResolved(plan: MergePlan, resolutions: Resolutions): void {
  const missing: string[] = [];
  for (const fp of plan.faces) {
    for (const c of fp.conflicts) {
      if (!resolutions[c.key]) missing.push(`${fp.faceNo} · ${c.title}`);
    }
  }
  if (missing.length > 0) {
    throw new MergeValidationError(`还有 ${missing.length} 处冲突未选择主版本：${missing.slice(0, 3).join('；')}${missing.length > 3 ? ' 等' : ''}`);
  }
}

export async function executeMerge(plan: MergePlan, resolutions: Resolutions): Promise<MergeOutcome> {
  assertAllResolved(plan, resolutions);
  const sessionId = newId('msess');
  const { bundle } = plan;

  // 先备份本机将触碰的素描（localStorage 无法随 IndexedDB 事务回滚）
  const sketchBackup = new Map<string, string | null>();
  for (const fp of plan.faces) {
    if (fp.localFaceId) {
      const key = `gbtunnelface:sketch:${fp.localFaceId}`;
      sketchBackup.set(fp.localFaceId, window.localStorage.getItem(key));
    }
  }

  const recomputed: MergeOutcome['recomputed'] = [];
  const counts = { faces: 0, joints: 0, waters: 0, grades: 0, segments: 0, conflictsResolved: 0, archived: 0 };

  try {
    await db.transaction(
      'rw',
      [
        db.faces,
        db.joints,
        db.waters,
        db.grades,
        db.archives,
        db.mergeBases,
        db.mergeSessions,
      ],
      async () => {
        // 执行期重新读取，保证拿到的是事务内最新数据
        const allLocal = {
          faces: await db.faces.toArray(),
          joints: await db.joints.toArray(),
          waters: await db.waters.toArray(),
          grades: await db.grades.toArray(),
        };

        for (const fp of plan.faces) {
          const canonicalId = fp.localFaceId ?? fp.incomingFaceId;
          const archive = (entry: Omit<ArchiveEntry, 'id' | 'sessionId' | 'archivedAt' | 'deviceId' | 'deviceName'>) =>
            db.archives.put({
              ...entry,
              id: newId('arch'),
              sessionId,
              archivedAt: Date.now(),
              deviceId: bundle.deviceId,
              deviceName: bundle.deviceName,
            });

          // 1) 掌子面基本信息
          if (fp.isNew) {
            await db.faces.put(toPlain(fp.incomingFace));
            counts.faces += 1;
          } else if (fp.faceConflict) {
            const side = resolutions[fp.faceConflict.key];
            const winner = side === 'incoming' ? ({ ...toPlain(fp.incomingFace), id: canonicalId } as TunnelFace) : fp.localFace!;
            const loser = side === 'incoming' ? fp.localFace! : ({ ...toPlain(fp.incomingFace), id: canonicalId } as TunnelFace);
            await db.faces.put(toPlain(winner));
            await archive({
              kind: 'conflict-losers',
              faceNo: fp.faceNo,
              faceId: canonicalId,
              entityTable: 'faces',
              entityId: canonicalId,
              note: `掌子面基本信息冲突，地质员选用${side === 'incoming' ? '对端' : '本机'}版本`,
              payload: toPlain(loser),
            });
            counts.archived += 1;
            counts.conflictsResolved += 1;
          } else if (fp.faceTakeIncoming) {
            await db.faces.put(toPlain({ ...fp.incomingFace, id: canonicalId }));
            counts.faces += 1;
          }

          // 2) 新增子记录（对端 faceId 重映射到规范 id；节理组号撞车顺延）
          const usedSetNos = new Set(allLocal.joints.filter((j) => j.faceId === canonicalId).map((j) => j.setNo));
          let maxSetNo = usedSetNos.size > 0 ? Math.max(...usedSetNos) : 0;
          for (const add of fp.adds) {
            if (add.table === 'faces') continue; // 新掌子面本体已处理
            const record = { ...toPlain(add.record), faceId: canonicalId } as Record<string, unknown>;
            if (add.table === 'joints') {
              let setNo = Number(record.setNo);
              if (usedSetNos.has(setNo)) {
                maxSetNo += 1;
                setNo = maxSetNo;
                record.setNo = setNo;
              } else {
                usedSetNos.add(setNo);
                maxSetNo = Math.max(maxSetNo, setNo);
              }
            }
            await db[add.table].put(record as never);
            counts[add.table] += 1;
            if (add.table === 'joints' || add.table === 'waters') allLocal[add.table].push(record as never);
          }

          // 3) 对端单边修改
          for (const upd of fp.incomingUpdates) {
            const inc =
              upd.table === 'joints'
                ? bundle.joints.find((j) => j.id === upd.id)
                : upd.table === 'waters'
                  ? bundle.waters.find((w) => w.id === upd.id)
                  : bundle.grades.find((g) => g.id === upd.id);
            if (inc) await db[upd.table].put(toPlain({ ...inc, faceId: canonicalId }) as never);
            counts[upd.table] += 1;
          }

          // 4) 冲突子记录：地质员选主版本，落选归档
          for (const c of fp.conflicts) {
            if (c.table === 'sketches') continue;
            const side = resolutions[c.key];
            const table = c.table as TableName;
            const winnerPayload =
              side === 'incoming'
                ? ({ ...toPlain(c.incoming as object), id: c.entityId, faceId: canonicalId } as Record<string, unknown>)
                : (toPlain(c.local as object) as Record<string, unknown>);
            await db[table].put(winnerPayload as never);
            await archive({
              kind: 'conflict-losers',
              faceNo: fp.faceNo,
              faceId: canonicalId,
              entityTable: table,
              entityId: c.entityId,
              note: `${c.title}冲突，地质员选用${side === 'incoming' ? '对端' : '本机'}版本`,
              payload: toPlain(side === 'incoming' ? c.local : c.incoming),
            });
            counts.archived += 1;
            counts.conflictsResolved += 1;
          }

          // 5) 素描
          if (fp.isNew) {
            if (fp.sketch.incomingSegs.length > 0) {
              saveSketch(canonicalId, fp.sketch.incomingSegs);
              counts.segments += fp.sketch.incomingSegs.length;
            }
          } else if (fp.sketch.status === 'conflict') {
            const side = resolutions[fp.sketch.conflict!.key];
            const winner = side === 'incoming' ? fp.sketch.incomingSegs : fp.sketch.localSegs;
            const loser = side === 'incoming' ? fp.sketch.localSegs : fp.sketch.incomingSegs;
            saveSketch(canonicalId, winner);
            counts.segments += winner.length;
            await archive({
              kind: 'sketch-dropped',
              faceNo: fp.faceNo,
              faceId: canonicalId,
              entityTable: 'sketches',
              entityId: canonicalId,
              note: `素描线段冲突，地质员选用${side === 'incoming' ? '对端' : '本机'}版本（落选 ${loser.length} 条仍可查）`,
              payload: toPlain(loser),
            });
            counts.archived += 1;
            counts.conflictsResolved += 1;
          } else if (fp.sketch.status === 'clean' || fp.sketch.status === 'add') {
            saveSketch(canonicalId, fp.sketch.mergedSegs);
            counts.segments += fp.sketch.mergedSegs.length;
          }

          // 6) 关联围岩判定重算
          if (fp.recomputeNeeded) {
            const face = (fp.localFace ? { ...fp.localFace } : { ...fp.incomingFace, id: canonicalId }) as TunnelFace;
            if (fp.faceConflict && resolutions[fp.faceConflict.key] === 'incoming') {
              Object.assign(face, { ...fp.incomingFace, id: canonicalId });
            } else if (fp.faceTakeIncoming) {
              Object.assign(face, { ...fp.incomingFace, id: canonicalId });
            }
            const mergedJoints = (await db.joints.where('faceId').equals(canonicalId).toArray()) as JointSet[];
            const mergedWaters = (await db.waters.where('faceId').equals(canonicalId).toArray()) as WaterInflow[];
            const previous = (await db.grades.where('faceId').equals(canonicalId).sortBy('judgedAt')).pop() as RockMassGrade | undefined;
            const outcome = recomputeGrade(face, mergedJoints, mergedWaters, previous);
            if (outcome.changed) {
              await db.grades.put(toPlain(outcome.record));
              counts.grades += 1;
              if (previous) {
                await archive({
                  kind: 'superseded-grade',
                  faceNo: fp.faceNo,
                  faceId: canonicalId,
                  entityTable: 'grades',
                  entityId: previous.id,
                  note: `节理/涌水并入后重算：${previous.grade} 级（[BQ] ${previous.correctedBq}）→ ${outcome.record.grade} 级（[BQ] ${outcome.record.correctedBq}）。${outcome.reasons.join('；')}`,
                  payload: toPlain(previous),
                });
                counts.archived += 1;
              }
            }
            recomputed.push({ faceNo: fp.faceNo, grade: outcome.record.grade, changed: outcome.changed });
          }

          // 7) 刷新同步基线：写入合并后的快照
          const [bj, bw, bg] = await Promise.all([
            db.joints.where('faceId').equals(canonicalId).toArray(),
            db.waters.where('faceId').equals(canonicalId).toArray(),
            db.grades.where('faceId').equals(canonicalId).toArray(),
          ]);
          const savedFace = await db.faces.get(canonicalId);
          const segs = loadSketch(canonicalId);
          const base: MergeBase = {
            id: `${fp.faceNo}::${bundle.deviceId}`,
            faceNo: fp.faceNo,
            peerDeviceId: bundle.deviceId,
            updatedAt: Date.now(),
            faces: savedFace ? { [canonicalId]: toPlain(savedFace) } : {},
            joints: Object.fromEntries(bj.map((j) => [j.id, toPlain(j)])),
            waters: Object.fromEntries(bw.map((w) => [w.id, toPlain(w)])),
            grades: Object.fromEntries(bg.map((g) => [g.id, toPlain(g)])),
            sketches: { [canonicalId]: { ids: segs.map((s) => s.id), signature: sketchSignature(segs) } },
          };
          await db.mergeBases.put(toPlain(base));
        }

        const newFaces = plan.faces.filter((f) => f.isNew).length;
        const summary =
          `认领新掌子面 ${newFaces} 个；写入节理 ${counts.joints} 条、涌水 ${counts.waters} 条、判定 ${counts.grades} 条；` +
          `素描线段 ${counts.segments} 条；解决冲突 ${counts.conflictsResolved} 处，归档落选版本/旧判定 ${counts.archived} 条；` +
          `重算围岩判定 ${recomputed.filter((r) => r.changed).length} 个掌子面。`;

        const session: MergeSession = {
          id: sessionId,
          status: 'success',
          startedAt: bundle.exportedAt,
          finishedAt: Date.now(),
          peerDeviceId: bundle.deviceId,
          peerDeviceName: bundle.deviceName,
          faceNos: plan.faces.map((f) => f.faceNo),
          summary,
        };
        await db.mergeSessions.put(session);
      },
    );

    window.dispatchEvent(new CustomEvent(MERGE_EVENT));
    return {
      ok: true,
      sessionId,
      recomputed,
      summary:
        `合并完成：新增节理 ${counts.joints}、涌水 ${counts.waters}、判定 ${counts.grades} 条，` +
        `素描线段 ${counts.segments} 条，冲突处理 ${counts.conflictsResolved} 处，归档 ${counts.archived} 条；` +
        `围岩判定重算 ${recomputed.filter((r) => r.changed).length} 个掌子面。`,
    };
  } catch (e) {
    // 回滚 localStorage 素描；IndexedDB 随事务中止自动回滚，现场原记录不动
    for (const [faceId, raw] of sketchBackup) {
      const key = `gbtunnelface:sketch:${faceId}`;
      if (raw === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, raw);
    }
    const errorMessage = e instanceof Error ? e.message : String(e);
    try {
      const failed: MergeSession = {
        id: sessionId,
        status: 'failed',
        startedAt: bundle.exportedAt,
        finishedAt: Date.now(),
        peerDeviceId: bundle.deviceId,
        peerDeviceName: bundle.deviceName,
        faceNos: plan.faces.map((f) => f.faceNo),
        summary: '合并失败，已恢复合并前的全部现场记录，可在处理问题后重试',
        errorMessage,
        bundle: toPlain(bundle),
        resolutions: { ...resolutions },
      };
      await db.mergeSessions.put(failed);
    } catch {
      /* 会话落库失败不再遮蔽原始错误 */
    }
    return { ok: false, sessionId, errorMessage, recomputed: [], summary: '合并失败，现场记录未改动' };
  }
}

/** 用失败会话里保留的交接包与已做选择重建计划，供恢复重试 */
export async function retryFailedSession(session: MergeSession): Promise<{ plan: MergePlan; resolutions: Resolutions }> {
  if (session.status !== 'failed' || !session.bundle) {
    throw new MergeValidationError('该会话不是可重试的失败会话');
  }
  const plan = await buildMergePlan(session.bundle);
  return { plan, resolutions: session.resolutions ?? {} };
}
