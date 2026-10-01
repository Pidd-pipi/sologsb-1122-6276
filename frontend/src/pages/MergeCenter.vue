<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useMergeStore } from '../stores/mergeStore';
import type { ConflictItem, PlanItem } from '../utils/merge';
import type { ArchivedVersion } from '../types/merge';

const store = useMergeStore();

const deviceName = ref('');
const importRef = ref<{ clearFiles: () => void } | null>(null);
const archiveDialogVisible = ref(false);
const viewingArchive = ref<ArchivedVersion | null>(null);

onMounted(async () => {
  await store.init();
  deviceName.value = store.device.name;
});

function saveDeviceName() {
  store.renameDevice(deviceName.value);
  ElMessage.success(`本机名称已改为「${store.device.name}」`);
}

async function onExport() {
  await store.exportBundle();
  ElMessage.success('交接文件已导出，可发到其他平板');
}

async function onImportChange(uploadFile: { raw?: File }) {
  const file = uploadFile.raw;
  if (!file) return;
  await store.importFile(file);
  if (store.plan) {
    ElMessage.success(`已解析来自「${store.plan.sourceDevice.name}」的交接文件，请确认合并计划`);
  } else if (store.error) {
    ElMessage.error(store.error);
  }
  importRef.value?.clearFiles();
}

const hasPlan = computed(() => !!store.plan);

const addedGroups = computed(() => {
  if (!store.plan) return [];
  const groups: Record<string, PlanItem[]> = { face: [], joint: [], water: [], grade: [] };
  for (const it of store.plan.added) groups[it.entityType].push(it);
  return [
    { key: 'face', label: '掌子面', items: groups.face },
    { key: 'joint', label: '节理组', items: groups.joint },
    { key: 'water', label: '涌水记录', items: groups.water },
    { key: 'grade', label: '围岩判定', items: groups.grade },
  ].filter((g) => g.items.length > 0);
});

function entityLabel(t: string): string {
  return { face: '掌子面', joint: '节理组', water: '涌水记录', grade: '围岩判定' }[t] ?? t;
}

/** 冲突字段差异（基准 / 本地 / 导入） */
function diffRows(c: ConflictItem) {
  const keys = new Set<string>([
    ...Object.keys(c.local ?? {}),
    ...Object.keys(c.incoming ?? {}),
  ]);
  const rows: { field: string; base: string; local: string; incoming: string; localChanged: boolean; incomingChanged: boolean }[] = [];
  for (const k of keys) {
    if (k === 'meta' || k === 'faceNo') continue;
    const b = fmt(c.base?.[k]);
    const l = fmt(c.local?.[k]);
    const i = fmt(c.incoming?.[k]);
    if (l === i) continue;
    rows.push({
      field: k,
      base: b,
      local: l,
      incoming: i,
      localChanged: b !== l,
      incomingChanged: b !== i,
    });
  }
  return rows;
}

function fmt(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function pickConflict(c: ConflictItem, pick: 'local' | 'incoming') {
  store.setPick(c.key, c.entityType, pick);
}

async function onApply() {
  await store.apply();
  if (store.lastResult) {
    ElMessage.success(
      `合并完成：新增 ${store.lastResult.added} 项，冲突 ${store.lastResult.conflicts} 项已选主版本，重算围岩判定 ${store.lastResult.recomputed} 项，归档备选 ${store.lastResult.archived} 项`,
    );
  }
}

async function onRetry() {
  await store.retry();
  if (store.lastResult) ElMessage.success('重试成功，合并已完成');
}

function viewArchive(arch: ArchivedVersion) {
  viewingArchive.value = arch;
  archiveDialogVisible.value = true;
}

async function onRestore(arch: ArchivedVersion) {
  await store.restoreArchive(arch);
  if (store.error) ElMessage.error(store.error);
  else ElMessage.success(`已恢复「${arch.entityLabel}」为活跃版本`);
}
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>离线交接合并</h2>
      <el-tag type="info" effect="plain">按掌子面稳定编号认领 · 三包合并 · 冲突选主 · 失败可重试</el-tag>
    </div>

    <el-alert
      type="info"
      :closable="false"
      title="多台平板断网后分别编录同一掌子面，回驻地用本功能导入交接文件：新增内容保留来源与顺序，同一对象两边都改时由您选主版本，未选版本归档可查；节理组/涌水改动后关联围岩判定自动重算。"
    />

    <!-- 本机身份 -->
    <el-card shadow="never">
      <template #header><strong>本机身份</strong></template>
      <div class="device-row">
        <span class="muted">本机名称（随交接文件带给其他平板）：</span>
        <el-input v-model="deviceName" style="width: 240px" placeholder="如 平板-岑柏川" @keyup.enter="saveDeviceName" />
        <el-button @click="saveDeviceName">保存名称</el-button>
        <span class="muted">设备 ID：{{ store.device.id }}</span>
      </div>
    </el-card>

    <!-- 导出 / 导入 -->
    <el-card shadow="never">
      <template #header><strong>交接文件</strong></template>
      <div class="io-row">
        <el-button type="primary" @click="onExport">导出本机交接文件</el-button>
        <el-upload
          ref="importRef"
          :auto-upload="false"
          :show-file-list="false"
          :on-change="onImportChange"
          accept=".json,application/json"
        >
          <el-button>导入其他平板的交接文件</el-button>
        </el-upload>
        <span class="muted">导出为 JSON，可通过微信/U盘/网线带到其他设备；导入后先预览合并计划，不会直接覆盖。</span>
      </div>
    </el-card>

    <!-- 错误提示 + 重试 -->
    <el-alert
      v-if="store.error"
      type="error"
      :closable="false"
      show-icon
      :title="store.error"
      style="margin-bottom: 12px"
    >
      <div class="retry-row">
        <el-button type="primary" size="small" :loading="store.busy" @click="onRetry">恢复重试</el-button>
        <span class="muted">重试沿用已选主版本，原记录未被改动</span>
      </div>
    </el-alert>

    <!-- 合并计划 -->
    <el-card v-if="hasPlan && store.plan" shadow="never">
      <template #header>
        <div class="plan-head">
          <strong>合并计划</strong>
          <el-tag type="info">来自 {{ store.plan.sourceDevice.name }}</el-tag>
          <span class="muted">导出时间 {{ new Date(store.plan.exportedAt).toLocaleString('zh-CN') }}</span>
        </div>
      </template>

      <el-alert
        type="warning"
        :closable="false"
        :title="`新增 ${store.plan.counts.added} 项 · 冲突 ${store.plan.counts.conflicts} 项 · 自动合并 ${store.plan.counts.autoUpdated} 项 · 无变化 ${store.plan.counts.unchanged} 项 · 将重算围岩判定 ${store.plan.counts.recomputed} 项`"
        style="margin-bottom: 12px"
      />

      <el-tabs>
        <el-tab-pane :label="`新增 ${store.plan.counts.added}`">
          <div v-for="g in addedGroups" :key="g.key" class="added-group">
            <h4>{{ g.label }}（{{ g.items.length }}）</h4>
            <el-table :data="g.items" size="small" border>
              <el-table-column label="对象" min-width="220">
                <template #default="{ row }">{{ row.label }}</template>
              </el-table-column>
              <el-table-column label="来源设备" width="160">
                <template #default="{ row }">
                  <el-tag size="small" type="success">{{ row.source }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="录入顺序" width="100">
                <template #default="{ row }">#{{ row.seq }}</template>
              </el-table-column>
            </el-table>
          </div>
          <el-empty v-if="addedGroups.length === 0" description="无新增内容" :image-size="50" />
        </el-tab-pane>

        <el-tab-pane :label="`冲突 ${store.plan.counts.conflicts}`">
          <el-alert
            v-if="store.plan.conflicts.length > 0"
            type="error"
            :closable="false"
            title="以下对象两边都做了修改，请逐个选定主版本；未选版本会归档保留，仍可查阅恢复。"
            style="margin-bottom: 10px"
          />
          <div v-for="c in store.plan.conflicts" :key="`${c.entityType}-${c.key}`" class="conflict-card">
            <div class="conflict-head">
              <el-tag size="small" type="danger">{{ entityLabel(c.entityType) }}</el-tag>
              <strong>{{ c.label }}</strong>
              <span class="muted">两边都改</span>
            </div>
            <el-table :data="diffRows(c)" size="small" border class="diff-table">
              <el-table-column label="字段" prop="field" width="140" />
              <el-table-column label="基准（上次同步）" min-width="160">
                <template #default="{ row }">
                  <span :class="{ 'diff-old': row.localChanged || row.incomingChanged }">{{ row.base }}</span>
                </template>
              </el-table-column>
              <el-table-column label="本地版本" min-width="160">
                <template #default="{ row }">
                  <span :class="{ 'diff-side': row.localChanged }">{{ row.local }}</span>
                </template>
              </el-table-column>
              <el-table-column label="导入版本" min-width="160">
                <template #default="{ row }">
                  <span :class="{ 'diff-side': row.incomingChanged }">{{ row.incoming }}</span>
                </template>
              </el-table-column>
            </el-table>
            <el-radio-group
              :model-value="c.pick"
              class="pick-group"
              @update:model-value="(v: 'local' | 'incoming') => pickConflict(c, v)"
            >
              <el-radio value="incoming">选导入版本</el-radio>
              <el-radio value="local">选本地版本</el-radio>
            </el-radio-group>
          </div>
          <el-empty v-if="store.plan.conflicts.length === 0" description="无冲突" :image-size="50" />
        </el-tab-pane>

        <el-tab-pane :label="`自动合并 ${store.plan.counts.autoUpdated}`">
          <h4>仅导入方改动（已采用导入方版本，{{ store.plan.autoIncoming.length }}）</h4>
          <el-table :data="store.plan.autoIncoming" size="small" border>
            <el-table-column label="对象" min-width="220">
              <template #default="{ row }">{{ row.label }}</template>
            </el-table-column>
            <el-table-column label="来源设备" width="160">
              <template #default="{ row }"><el-tag size="small" type="success">{{ row.source }}</el-tag></template>
            </el-table-column>
            <el-table-column label="录入顺序" width="100">
              <template #default="{ row }">#{{ row.seq }}</template>
            </el-table-column>
          </el-table>
          <h4 style="margin-top: 14px">仅本地改动（已保留本地版本，{{ store.plan.autoLocal.length }}）</h4>
          <el-table :data="store.plan.autoLocal" size="small" border>
            <el-table-column label="对象" min-width="220">
              <template #default="{ row }">{{ row.label }}</template>
            </el-table-column>
            <el-table-column label="来源设备" width="160">
              <template #default="{ row }"><el-tag size="small">{{ row.source }}</el-tag></template>
            </el-table-column>
            <el-table-column label="录入顺序" width="100">
              <template #default="{ row }">#{{ row.seq }}</template>
            </el-table-column>
          </el-table>
          <el-empty v-if="store.plan.autoCount === 0" description="无自动合并" :image-size="50" />
        </el-tab-pane>

        <el-tab-pane :label="`重算 ${store.plan.counts.recomputed}`">
          <el-alert
            type="warning"
            :closable="false"
            title="合并提交时，以下掌子面的围岩判定会依据最新节理组与涌水记录自动重算并追加新结论，不沿用旧判定。"
            style="margin-bottom: 10px"
          />
          <el-table :data="store.plan.recomputations" size="small" border>
            <el-table-column label="掌子面编号" prop="faceNo" width="160" />
            <el-table-column label="重算原因" prop="reason" min-width="260" />
          </el-table>
          <el-empty v-if="store.plan.recomputations.length === 0" description="无需重算" :image-size="50" />
        </el-tab-pane>
      </el-tabs>

      <template #footer>
        <el-button @click="store.cancelPlan">取消</el-button>
        <el-button type="primary" :loading="store.busy" @click="onApply">确认合并（事务提交）</el-button>
      </template>
    </el-card>

    <!-- 合并结果 -->
    <el-alert
      v-if="store.lastResult"
      type="success"
      :closable="false"
      show-icon
      :title="`合并完成：新增 ${store.lastResult.added} · 冲突已选主 ${store.lastResult.conflicts} · 自动合并 ${store.lastResult.autoUpdated} · 重算围岩判定 ${store.lastResult.recomputed} · 归档备选 ${store.lastResult.archived}`"
    />

    <!-- 归档版本 + 历史 -->
    <el-card shadow="never">
      <template #header><strong>归档版本与合并历史</strong></template>
      <el-tabs>
        <el-tab-pane label="归档版本（未选版本仍可查）">
          <el-table :data="store.archives" size="small" border>
            <el-table-column label="归档时间" width="170">
              <template #default="{ row }">{{ new Date(row.archivedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column label="类型" width="100">
              <template #default="{ row }">{{ entityLabel(row.entityType) }}</template>
            </el-table-column>
            <el-table-column label="对象" min-width="220">
              <template #default="{ row }">{{ row.entityLabel }}</template>
            </el-table-column>
            <el-table-column label="来源" width="140">
              <template #default="{ row }"><el-tag size="small" type="info">{{ row.source }}</el-tag></template>
            </el-table-column>
            <el-table-column label="操作" width="200">
              <template #default="{ row }">
                <el-button size="small" @click="viewArchive(row)">查看</el-button>
                <el-button size="small" type="primary" @click="onRestore(row)">恢复为主版本</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="store.archives.length === 0" description="暂无归档版本" :image-size="50" />
        </el-tab-pane>
        <el-tab-pane label="合并历史">
          <el-table :data="store.history" size="small" border>
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ new Date(row.importedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column label="来源设备" width="160">
              <template #default="{ row }">{{ row.sourceDevice }}</template>
            </el-table-column>
            <el-table-column label="结果" width="100">
              <template #default="{ row }">
                <el-tag v-if="row.status === 'success'" size="small" type="success">成功</el-tag>
                <el-tag v-else size="small" type="danger">失败</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="新增" prop="added" width="70" />
            <el-table-column label="冲突" prop="conflicts" width="70" />
            <el-table-column label="重算" prop="recomputed" width="70" />
            <el-table-column label="归档" prop="archived" width="70" />
            <el-table-column label="说明" min-width="180">
              <template #default="{ row }">
                <span v-if="row.status === 'failed'" class="err-msg">{{ row.error }}</span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="store.history.length === 0" description="暂无合并历史" :image-size="50" />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 归档查看对话框 -->
    <el-dialog v-model="archiveDialogVisible" :title="viewingArchive?.entityLabel ?? '归档版本'" width="640px">
      <el-descriptions :column="1" border size="small" v-if="viewingArchive">
        <el-descriptions-item label="类型">{{ entityLabel(viewingArchive.entityType) }}</el-descriptions-item>
        <el-descriptions-item label="来源设备">{{ viewingArchive.source }}</el-descriptions-item>
        <el-descriptions-item label="归档时间">{{ new Date(viewingArchive.archivedAt).toLocaleString('zh-CN') }}</el-descriptions-item>
        <el-descriptions-item label="完整数据快照">
          <pre class="archive-pre">{{ JSON.stringify(viewingArchive.data, null, 2) }}</pre>
        </el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="archiveDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.device-row,
.io-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.plan-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.retry-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.added-group {
  margin-bottom: 16px;
}
.added-group h4 {
  margin: 8px 0;
}
.conflict-card {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 14px;
}
.conflict-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.diff-table {
  margin-bottom: 10px;
}
.diff-old {
  color: #b0a189;
  text-decoration: line-through;
}
.diff-side {
  color: #d3542f;
  font-weight: 600;
}
.pick-group {
  display: flex;
  gap: 18px;
}
.err-msg {
  color: #d3542f;
  font-size: 12px;
}
.archive-pre {
  margin: 0;
  max-height: 360px;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  background: #f5f6f8;
  padding: 8px;
  border-radius: 4px;
}
</style>
