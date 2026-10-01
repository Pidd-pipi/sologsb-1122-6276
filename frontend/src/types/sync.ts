/**
 * 离线交接合并相关的通用字段与结构。
 * 几台平板断网各自编录，回驻地通过交接包（JSON 文件）做三方合并。
 */

/** 记录来源（由哪台设备、哪位地质员产生） */
export interface RecordProvenance {
  /** 首录设备 id */
  sourceDeviceId?: string;
  /** 首录设备名称（冗余存档，便于直接阅读） */
  sourceDeviceName?: string;
  /** 设备内单调递增序号，用于保留现场录入顺序 */
  seq?: number;
  /** 最近修改时间 ms */
  updatedAt?: number;
}

/** 交接包格式版本 */
export const HANDOVER_BUNDLE_VERSION = 1;

/** 素描线段（含来源），结构与 SketchCanvas.SketchSegment 保持一致 */
export interface SketchSegmentPayload {
  id: string;
  x: number;
  y: number;
  dipAngle: number;
  dipDirection: number;
  length: number;
  label: string;
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  seq?: number;
}

/** 导出的设备身份 */
export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  geologist: string;
}

/** 离线交接包：一台平板上一次导出的全部编录 */
export interface HandoverBundle {
  format: 'gbtunnelface-handover';
  bundleVersion: number;
  deviceId: string;
  deviceName: string;
  geologist: string;
  exportedAt: number;
  faces: import('./face').TunnelFace[];
  joints: import('./joint').JointSet[];
  waters: import('./water').WaterInflow[];
  grades: import('./grade').RockMassGrade[];
  /** faceId（导包设备侧）→ 素描线段（按现场绘制顺序） */
  sketches: Record<string, SketchSegmentPayload[]>;
}

/** 归档类型 */
export type ArchiveKind =
  | 'conflict-losers' // 冲突中未被选为主版本的一方
  | 'superseded-grade' // 关联重算后被替换的旧围岩判定
  | 'sketch-dropped'; // 素描冲突中落选的线段集合

export interface ArchiveEntry {
  id: string;
  kind: ArchiveKind;
  /** 稳定认领键（掌子面编号） */
  faceNo: string;
  faceId: string;
  /** 对象表：faces/joints/waters/grades/sketches */
  entityTable: string;
  /** 对象 id（素描为 faceId） */
  entityId: string;
  /** 合并会话 id */
  sessionId: string;
  deviceId: string;
  deviceName: string;
  archivedAt: number;
  note: string;
  /** 落选/被替换时的完整快照（素描为 SketchSegmentPayload[]） */
  payload: unknown;
}

/** 合并会话状态 */
export type MergeSessionStatus = 'success' | 'failed';

export interface MergeSession {
  id: string;
  status: MergeSessionStatus;
  startedAt: number;
  finishedAt: number;
  /** 导包设备 */
  peerDeviceId: string;
  peerDeviceName: string;
  /** 认领的掌子面编号列表 */
  faceNos: string[];
  summary: string;
  errorMessage?: string;
  /** 失败时保留：原交接包 + 地质员已做的选择，便于恢复重试 */
  bundle?: HandoverBundle;
  resolutions?: Record<string, 'local' | 'incoming'>;
}

/** 同步基线：两台设备之间，每个掌子面上次成功合并时的快照 */
export interface MergeBase {
  /** `${faceNo}::${peerDeviceId}` */
  id: string;
  faceNo: string;
  peerDeviceId: string;
  updatedAt: number;
  faces: Record<string, unknown>;
  joints: Record<string, unknown>;
  waters: Record<string, unknown>;
  grades: Record<string, unknown>;
  /** 素描线段 id 的有序列表 + 内容签名 */
  sketches: Record<string, { ids: string[]; signature: string }>;
}
