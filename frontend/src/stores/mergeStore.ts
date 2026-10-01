import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { getDevice, setDeviceName, type DeviceInfo } from '../utils/device';
import {
  applyMerge,
  buildBundle,
  computeMergePlan,
  downloadBundle,
  loadBase,
  loadLocalData,
  parseBundle,
  type ApplyResult,
  type ConflictItem,
  type LocalData,
  type MergeBundle,
  type MergePlan,
} from '../utils/merge';
import type { ArchivedVersion, ConflictPick, MergeHistoryEntry } from '../types/merge';

const HISTORY_KEY = 'gbtunnelface:merge-history';

interface MergeState {
  device: DeviceInfo;
  base: LocalData | null;
  plan: MergePlan | null;
  incoming: MergeBundle | null;
  local: LocalData | null;
  archives: ArchivedVersion[];
  history: MergeHistoryEntry[];
  busy: boolean;
  error: string | null;
  lastResult: ApplyResult | null;
}

function loadHistory(): MergeHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as MergeHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(history: MergeHistoryEntry[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  } catch {
    /* ignore */
  }
}

export const useMergeStore = defineStore('merge', {
  state: (): MergeState => ({
    device: getDevice(),
    base: null,
    plan: null,
    incoming: null,
    local: null,
    archives: [],
    history: [],
    busy: false,
    error: null,
    lastResult: null,
  }),
  getters: {
    pendingConflicts: (state) => state.plan?.conflicts ?? [],
  },
  actions: {
    async init() {
      this.device = getDevice();
      this.base = loadBase();
      this.history = loadHistory();
      await this.loadArchives();
    },
    renameDevice(name: string) {
      this.device = setDeviceName(name);
    },
    /** 导出交接文件（本机全部编录数据） */
    async exportBundle() {
      const local = await loadLocalData();
      const bundle = buildBundle(local, this.device);
      downloadBundle(bundle);
    },
    /** 导入交接文件：解析并生成合并计划（不写入） */
    async importFile(file: File) {
      this.error = null;
      const text = await file.text();
      const parsed = parseBundle(text);
      if (!parsed.ok) {
        this.error = parsed.error;
        return;
      }
      const local = await loadLocalData();
      this.local = local;
      this.incoming = parsed.bundle;
      this.base = loadBase();
      this.plan = computeMergePlan(local, parsed.bundle, this.base);
      this.lastResult = null;
    },
    /** 选择冲突主版本 */
    setPick(conflictKey: string, entityType: string, pick: ConflictPick) {
      if (!this.plan) return;
      const c = this.plan.conflicts.find((p) => p.key === conflictKey && p.entityType === entityType);
      if (c) c.pick = pick;
    },
    /** 应用合并（事务提交）；失败则原样保留，可重试 */
    async apply() {
      if (!this.plan || !this.local || !this.incoming) return;
      const plan = this.plan;
      const incoming = this.incoming;
      this.busy = true;
      this.error = null;
      try {
        const result = await applyMerge(plan, this.local, incoming, this.base);
        this.lastResult = result;
        this.history = [
          {
            mergeId: result.mergeId,
            sourceDevice: incoming.device.name,
            importedAt: Date.now(),
            added: result.added,
            conflicts: result.conflicts,
            autoUpdated: result.autoUpdated,
            recomputed: result.recomputed,
            archived: result.archived,
            status: 'success',
          },
          ...this.history,
        ];
        saveHistory(this.history);
        // 重新加载基准与归档
        this.base = loadBase();
        await this.loadArchives();
        this.plan = null;
        this.incoming = null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.error = `合并失败，原记录已保留未改动：${msg}。请修正后重试。`;
        this.history = [
          {
            mergeId: plan.mergeId,
            sourceDevice: incoming.device.name,
            importedAt: Date.now(),
            added: 0,
            conflicts: plan.counts.conflicts,
            autoUpdated: 0,
            recomputed: 0,
            archived: 0,
            status: 'failed',
            error: msg,
          },
          ...this.history,
        ];
        saveHistory(this.history);
      } finally {
        this.busy = false;
      }
    },
    /** 失败后重试（沿用已选主版本） */
    async retry() {
      if (!this.plan) return;
      await this.apply();
    },
    cancelPlan() {
      this.plan = null;
      this.incoming = null;
      this.error = null;
    },
    async loadArchives() {
      try {
        this.archives = await db.archive.orderBy('archivedAt').reverse().toArray();
      } catch {
        this.archives = [];
      }
    },
    /** 恢复归档版本为活跃记录（当前活跃版本转入归档） */
    async restoreArchive(arch: ArchivedVersion) {
      this.busy = true;
      this.error = null;
      try {
        const data = toPlain(arch.data) as any;
        const entityType = arch.entityType;
        // 找到当前活跃版本
        let table: any;
        if (entityType === 'face') table = db.faces;
        else if (entityType === 'joint') table = db.joints;
        else if (entityType === 'grade') table = db.grades;
        else table = db.waters;
        const current = await table.get(data.id);
        await db.transaction('rw', db.faces, db.joints, db.grades, db.waters, db.archive, async () => {
          await table.put(toPlain(data));
          if (current) {
            await db.archive.add({
              id: `arch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              entityType,
              entityUid: current.meta?.uid ?? arch.entityUid,
              entityLabel: arch.entityLabel,
              source: current.meta?.source ?? 'unknown',
              data: toPlain(current),
              archivedAt: Date.now(),
              reason: 'superseded',
              mergeId: 'restore',
            });
          }
          await db.archive.delete(arch.id);
        });
        await this.loadArchives();
      } catch (e) {
        this.error = `恢复失败，原记录已保留：${e instanceof Error ? e.message : String(e)}`;
      } finally {
        this.busy = false;
      }
    },
    async deleteArchive(id: string) {
      await db.archive.delete(id);
      await this.loadArchives();
    },
  },
});
