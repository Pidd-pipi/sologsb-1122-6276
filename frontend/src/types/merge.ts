/** 跨设备认领用的元信息：稳定 uid + 来源设备 + 设备内录入顺序 */
export interface MergeMeta {
  /** 全局稳定唯一标识（记录在不同设备间迁移时保持不变） */
  uid: string;
  /** 来源设备标识（设备名称，如「平板-岑柏川」；种子数据为 seed） */
  source: string;
  /** 来源设备内的录入顺序号（保留现场录入先后次序） */
  seq: number;
}

/** 归档版本：冲突中未被选为主版本的备选记录，仍可随时查阅/恢复 */
export interface ArchivedVersion {
  id: string;
  entityType: 'face' | 'joint' | 'grade' | 'water';
  entityUid: string;
  /** 便于人读的对象名称，如「ZK-102 J3 节理组」 */
  entityLabel: string;
  source: string;
  /** 完整记录快照 */
  data: unknown;
  archivedAt: number;
  reason: 'conflict-alternative' | 'superseded';
  /** 所属合并批次号 */
  mergeId: string;
}

/** 合并历史条目 */
export interface MergeHistoryEntry {
  mergeId: string;
  sourceDevice: string;
  importedAt: number;
  added: number;
  conflicts: number;
  autoUpdated: number;
  recomputed: number;
  archived: number;
  status: 'success' | 'failed';
  error?: string;
}

/** 冲突主版本选择 */
export type ConflictPick = 'local' | 'incoming';
