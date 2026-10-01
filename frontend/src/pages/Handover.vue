<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  buildMergePlan,
  createBundle,
  executeMerge,
  MergeValidationError,
  parseBundle,
  retryFailedSession,
  type MergeOutcome,
  type MergePlan,
  type ResolutionSide,
  type Resolutions,
} from '../utils/handover';
import { getDeviceId, getDeviceName, getGeologist, setDeviceName, setGeologist } from '../utils/device';
import { db } from '../utils/db';
import { createDemoPeerBundle } from '../utils/demoPeer';
import type { ArchiveEntry, MergeSession } from '../types/sync';

const deviceId = ref(getDeviceId());
const deviceName = ref(getDeviceName());
const geologist = ref(getGeologist());

const fileInput = ref<HTMLInputElement | null>(null);
const plan = ref<MergePlan | null>(null);
const resolutions = ref<Resolutions>({});
const merging = ref(false);
const lastOutcome = ref<MergeOutcome | null>(null);
const sessions = ref<MergeSession[]>([]);
const archives = ref<ArchiveEntry[]>([]);
const archiveDetail = ref<ArchiveEntry | null>(null);
const viewTab = ref('merge');

function saveDevice() {
  setDeviceName(deviceName.value.trim() || '驻地平板');
  setGeologist(geologist.value.trim());
  deviceName.value = getDeviceName();
  ElMessage.success('本机设备信息已保存，后续编录将带该来源');
}

async function exportBundle() {
  const bundle = await createBundle();
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `handover_${deviceName.value}_${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success(`已导出交接包：${bundle.faces.length} 个掌子面，请拷贝到驻地机导入`);
}

function pickFile() {
  fileInput.value?.click();
}

/** 单机演练：直接构造另一台平板的交接包并进入预检，不经过文件 */
async function loadDemo() {
  try {
    const bundle = await createDemoPeerBundle();
    plan.value = await buildMergePlan(bundle);
    resolutions.value = {};
    lastOutcome.value = null;
    viewTab.value = 'merge';
    ElMessage.info('已载入演练交接包：同一掌子面两边都改 + 新增股状涌水 + 一个新掌子面认领');
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function onFileChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const bundle = parseBundle(text);
    plan.value = await buildMergePlan(bundle);
    resolutions.value = {};
    lastOutcome.value = null;
    viewTab.value = 'merge';
    if (plan.value.conflictCount === 0 && plan.value.addCount === 0 && plan.value.faces.every((f) => f.sketch.status === 'none' && !f.faceTakeIncoming && f.incomingUpdates.length === 0)) {
      ElMessage.info('交接包内容与本机一致，没有需要并入的改动');
    } else {
      ElMessage.success(`已解析 ${bundle.deviceName} 的交接包：${plan.value.conflictCount} 处冲突待选择`);
    }
  } catch (err) {
    plan.value = null;
    const msg = err instanceof MergeValidationError ? err.message : `读取交接包失败：${(err as Error).message}`;
    ElMessage.error(msg);
  }
}

const conflictList = computed(() => {
  if (!plan.value) return [];
  return plan.value.faces.flatMap((fp) =>
    fp.conflicts.map((c) => ({ fp, conflict: c })),
  );
});

function resolutionOf(key: string): ResolutionSide | '' {
  return resolutions.value[key] ?? '';
}

function choose(key: string, side: ResolutionSide) {
  resolutions.value = { ...resolutions.value, [key]: side };
}

function autoChoose(side: ResolutionSide) {
  if (!plan.value) return;
  const next: Resolutions = { ...resolutions.value };
  for (const item of conflictList.value) {
    if (!next[item.conflict.key]) next[item.conflict.key] = side;
  }
  resolutions.value = next;
}

const unresolvedCount = computed(() =>
  conflictList.value.filter((item) => !resolutions.value[item.conflict.key]).length,
);

const recomputeFaces = computed(() =>
  plan.value ? plan.value.faces.filter((f) => f.recomputeNeeded).map((f) => f.faceNo) : [],
);

async function runMerge() {
  if (!plan.value) return;
  if (unresolvedCount.value > 0) {
    ElMessage.warning(`还有 ${unresolvedCount.value} 处冲突未选择主版本`);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将按当前选择执行合并。节理/涌水有并入的 ${recomputeFaces.value.length} 个掌子面会自动重算围岩判定（旧判定留存可查）。继续？`,
      '确认执行合并',
      { type: 'warning', confirmButtonText: '执行合并', cancelButtonText: '再看看' },
    );
  } catch {
    return;
  }
  merging.value = true;
  try {
    const outcome = await executeMerge(plan.value, resolutions.value);
    lastOutcome.value = outcome;
    if (outcome.ok) {
      ElMessage.success(outcome.summary);
      plan.value = null;
      resolutions.value = {};
      viewTab.value = 'sessions';
    } else {
      ElMessage.error(`合并失败已回滚：${outcome.errorMessage}。可在「交接记录」里重试`);
      plan.value = null;
      viewTab.value = 'sessions';
    }
    await loadHistory();
  } finally {
    merging.value = false;
  }
}

async function retrySession(session: MergeSession) {
  try {
    const { plan: rebuilt, resolutions: preset } = await retryFailedSession(session);
    plan.value = rebuilt;
    resolutions.value = preset;
    viewTab.value = 'merge';
    ElMessage.info(`已恢复失败会话（${session.peerDeviceName}），保留了上次 ${Object.keys(preset).length} 处选择，确认后可重新执行`);
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function clearSession(session: MergeSession) {
  await db.mergeSessions.delete(session.id);
  await loadHistory();
}

async function loadHistory() {
  sessions.value = await db.mergeSessions.orderBy('finishedAt').reverse().limit(30).toArray();
  archives.value = await db.archives.orderBy('archivedAt').reverse().limit(60).toArray();
}

onMounted(loadHistory);

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN');
}
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>离线交接合并</h2>
      <el-tag type="info" effect="plain">断网各编各的，回驻地按掌子面编号认领、三方合并</el-tag>
    </div>

    <el-tabs v-model="viewTab">
      <!-- 设备与导入导出 -->
      <el-tab-pane label="交接合并" name="merge">
        <div class="grid">
          <el-card shadow="never">
            <template #header><strong>① 本机设备身份</strong></template>
            <el-form label-width="100px">
              <el-form-item label="设备 ID">
                <el-input :model-value="deviceId" readonly />
              </el-form-item>
              <el-form-item label="设备名称">
                <el-input v-model="deviceName" placeholder="如 进口左洞 1 号平板" />
              </el-form-item>
              <el-form-item label="当前地质员">
                <el-input v-model="geologist" placeholder="姓名，写入编录来源" />
              </el-form-item>
              <el-form-item>
                <el-button @click="saveDevice">保存设备信息</el-button>
              </el-form-item>
            </el-form>
          </el-card>

          <el-card shadow="never">
            <template #header><strong>② 导出现场交接包</strong></template>
            <p class="muted">把本机全部掌子面（含节理组、涌水、围岩判定、素描线段及来源与录入顺序）打成 JSON，用 U 盘/内网拷给驻地机。</p>
            <el-button type="primary" @click="exportBundle">导出交接包 (.json)</el-button>
          </el-card>

          <el-card shadow="never" class="span2">
            <template #header><strong>③ 导入驻地交接包并预检</strong></template>
            <p class="muted">可依次导入多台平板的交接包；系统按掌子面稳定编号认领，绝不按整份覆盖。</p>
            <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFileChosen" />
            <el-button @click="pickFile">选择交接包</el-button>
            <el-button text type="primary" @click="loadDemo">没有第二台平板？生成演练交接包</el-button>
            <el-alert
              v-if="lastOutcome && !lastOutcome.ok"
              type="error"
              :closable="false"
              show-icon
              style="margin-top: 10px"
              :title="`上次合并失败，现场记录已完整保留：${lastOutcome.errorMessage ?? ''}。请到「交接记录」页重试。`"
            />
          </el-card>
        </div>

        <!-- 预检结果 -->
        <template v-if="plan">
          <el-card shadow="never" style="margin-top: 14px">
            <template #header>
              <div class="card-head">
                <strong>预检结果 · 来自 {{ plan.peer.deviceName }}</strong>
                <el-tag>{{ plan.faces.length }} 个掌子面</el-tag>
                <el-tag type="success">新增 {{ plan.addCount }} 条</el-tag>
                <el-tag type="danger">{{ plan.conflictCount }} 处两边都改</el-tag>
                <el-tag v-if="recomputeFaces.length" type="warning">
                  {{ recomputeFaces.length }} 个掌子面需重算判定
                </el-tag>
              </div>
            </template>

            <el-table :data="plan.faces" size="small" border>
              <el-table-column prop="faceNo" label="掌子面编号" width="130" />
              <el-table-column label="认领方式" width="140">
                <template #default="{ row }">
                  <el-tag v-if="row.isNew" type="success">新认领掌子面</el-tag>
                  <el-tag v-else type="info">按编号合并</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="新增子记录" min-width="200">
                <template #default="{ row }">
                  <el-space wrap size="small">
                    <el-tag v-for="(add, i) in row.adds" :key="i" size="small" type="success">
                      {{ add.title }} · {{ add.deviceName }}
                    </el-tag>
                    <span v-if="row.adds.length === 0" class="muted">—</span>
                  </el-space>
                </template>
              </el-table-column>
              <el-table-column label="对端单边修改" min-width="140">
                <template #default="{ row }">
                  <el-tag v-for="(u, i) in row.incomingUpdates" :key="i" size="small">{{ u.table }}</el-tag>
                  <span v-if="row.incomingUpdates.length === 0" class="muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="素描" width="110">
                <template #default="{ row }">
                  <el-tag v-if="row.sketch.status === 'conflict'" size="small" type="danger">线段冲突</el-tag>
                  <el-tag v-else-if="row.sketch.status === 'clean' || row.sketch.status === 'add'" size="small" type="success">
                    并入 {{ row.sketch.mergedSegs.length }} 条
                  </el-tag>
                  <span v-else class="muted">无变化</span>
                </template>
              </el-table-column>
              <el-table-column label="判定重算" width="100">
                <template #default="{ row }">
                  <el-tag v-if="row.recomputeNeeded" size="small" type="warning">自动重算</el-tag>
                  <span v-else class="muted">—</span>
                </template>
              </el-table-column>
            </el-table>
          </el-card>

          <!-- 冲突选择 -->
          <el-card v-if="conflictList.length" shadow="never" style="margin-top: 14px">
            <template #header>
              <div class="card-head">
                <strong>冲突清单 · 两边都改过，由地质员选主版本</strong>
                <el-tag :type="unresolvedCount ? 'danger' : 'success'">
                  已选 {{ conflictList.length - unresolvedCount }} / {{ conflictList.length }}
                </el-tag>
                <div class="spacer" />
                <el-button size="small" @click="autoChoose('local')">未选项暂取本机</el-button>
                <el-button size="small" @click="autoChoose('incoming')">未选项暂取对端</el-button>
              </div>
            </template>
            <el-alert type="info" :closable="false" show-icon style="margin-bottom: 10px"
              title="未被选中的版本不会删除，会连同来源一起进入「交接记录 → 落选归档」随时可查。" />

            <div v-for="item in conflictList" :key="item.conflict.key" class="conflict">
              <div class="conflict-title">
                <el-tag>{{ item.fp.faceNo }}</el-tag>
                <strong>{{ item.conflict.title }}</strong>
                <el-tag v-if="item.conflict.table === 'sketches'" size="small" type="warning">素描线段</el-tag>
                <div class="spacer" />
                <el-radio-group
                  :model-value="resolutionOf(item.conflict.key)"
                  @update:model-value="(v: string | number | boolean) => choose(item.conflict.key, v as ResolutionSide)"
                >
                  <el-radio-button value="local">用本机版本</el-radio-button>
                  <el-radio-button value="incoming">用对端版本</el-radio-button>
                </el-radio-group>
              </div>
              <el-table
                v-if="item.conflict.table !== 'sketches'"
                :data="item.conflict.fields"
                size="small"
                border
                :row-class-name="() => 'diff-row'"
              >
                <el-table-column prop="label" label="字段" width="170" />
                <el-table-column label="本机版本">
                  <template #default="{ row }">
                    <span :class="{ picked: resolutionOf(item.conflict.key) === 'local' }">{{ row.local }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="对端版本（{{ plan.peer.deviceName }}）">
                  <template #default="{ row }">
                    <span :class="{ picked: resolutionOf(item.conflict.key) === 'incoming' }">{{ row.incoming }}</span>
                  </template>
                </el-table-column>
              </el-table>
              <div v-else class="sketch-diff">
                <div :class="{ picked: resolutionOf(item.conflict.key) === 'local' }">
                  本机 {{ item.conflict.fields[0]?.local ?? item.fp.sketch.localSegs.length }} 条线段
                  <div class="seg-tags">
                    <el-tag v-for="s in item.fp.sketch.localSegs.slice(0, 12)" :key="s.id" size="small" class="seg-tag">{{ s.label }}</el-tag>
                    <span v-if="item.fp.sketch.localSegs.length > 12" class="muted">等 {{ item.fp.sketch.localSegs.length }} 条</span>
                  </div>
                </div>
                <div :class="{ picked: resolutionOf(item.conflict.key) === 'incoming' }">
                  对端 {{ item.conflict.fields[0]?.incoming ?? item.fp.sketch.incomingSegs.length }} 条线段
                  <div class="seg-tags">
                    <el-tag v-for="s in item.fp.sketch.incomingSegs.slice(0, 12)" :key="s.id" size="small" type="success" class="seg-tag">{{ s.label }}</el-tag>
                    <span v-if="item.fp.sketch.incomingSegs.length > 12" class="muted">等 {{ item.fp.sketch.incomingSegs.length }} 条</span>
                  </div>
                </div>
              </div>
            </div>

            <el-divider />
            <el-alert
              v-if="recomputeFaces.length"
              type="warning"
              :closable="false"
              show-icon
              :title="`节理/涌水并入后，这些掌子面的围岩判定将立即重算，不沿用旧结论：${recomputeFaces.join('、')}`"
              style="margin-bottom: 10px"
            />
            <el-button type="primary" size="large" :loading="merging" @click="runMerge">
              确认选择并执行合并
            </el-button>
          </el-card>
        </template>
      </el-tab-pane>

      <!-- 交接记录 -->
      <el-tab-pane label="交接记录" name="sessions">
        <el-card shadow="never">
          <template #header><strong>合并会话（失败会话保留原包与已选内容，可直接恢复重试）</strong></template>
          <el-table :data="sessions" size="small" border>
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ fmtTime(row.finishedAt) }}</template>
            </el-table-column>
            <el-table-column prop="peerDeviceName" label="对端设备" width="150" />
            <el-table-column label="掌子面" min-width="160">
              <template #default="{ row }">{{ row.faceNos.join('、') }}</template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === 'success' ? 'success' : 'danger'">
                  {{ row.status === 'success' ? '成功' : '失败' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="summary" label="结果 / 错误" min-width="240" />
            <el-table-column label="操作" width="170">
              <template #default="{ row }">
                <el-button v-if="row.status === 'failed'" size="small" type="warning" @click="retrySession(row)">恢复并重试</el-button>
                <el-button size="small" text @click="clearSession(row)">清除记录</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="sessions.length === 0" description="还没有交接记录" :image-size="60" />
        </el-card>

        <el-card shadow="never" style="margin-top: 14px">
          <template #header><strong>落选版本 / 旧判定归档（仍可查，不参与业务统计）</strong></template>
          <el-table :data="archives" size="small" border>
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ fmtTime(row.archivedAt) }}</template>
            </el-table-column>
            <el-table-column prop="faceNo" label="掌子面" width="120" />
            <el-table-column label="类型" width="130">
              <template #default="{ row }">
                <el-tag :type="row.kind === 'superseded-grade' ? 'warning' : 'info'" size="small">
                  {{ row.kind === 'superseded-grade' ? '重算前旧判定' : row.kind === 'sketch-dropped' ? '落选素描' : '落选版本' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="entityTable" label="对象" width="90" />
            <el-table-column prop="note" label="说明" min-width="280" />
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button size="small" @click="archiveDetail = row">查看</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="archives.length === 0" description="暂无归档内容" :image-size="60" />
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="archiveDetail" title="归档快照（落选/重算前的完整内容）" width="720px">
      <el-descriptions v-if="archiveDetail" :column="1" border size="small" style="margin-bottom: 10px">
        <el-descriptions-item label="掌子面">{{ archiveDetail.faceNo }}</el-descriptions-item>
        <el-descriptions-item label="来源设备">{{ archiveDetail.deviceName }}</el-descriptions-item>
        <el-descriptions-item label="说明">{{ archiveDetail.note }}</el-descriptions-item>
      </el-descriptions>
      <pre v-if="archiveDetail" class="json-view">{{ JSON.stringify(archiveDetail.payload, null, 2) }}</pre>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.span2 {
  grid-column: 1 / -1;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.spacer {
  flex: 1;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.conflict {
  border: 1px solid #e2c4c4;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: #fffafa;
}
.conflict-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
:deep(.diff-row .picked),
.picked {
  color: #1f6f3f;
  font-weight: 700;
}
.sketch-diff {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.sketch-diff > div {
  border: 1px dashed #cfd6de;
  border-radius: 6px;
  padding: 8px;
  font-size: 13px;
}
.seg-tags {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.seg-tag {
  margin: 0;
}
.json-view {
  max-height: 420px;
  overflow: auto;
  background: #f4f6f8;
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
}
</style>
