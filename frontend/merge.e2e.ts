// 端到端合并测试：在 Node 中用 fake-indexeddb + localStorage 垫片真实执行合并引擎。
// 由 test:bundle.mjs 通过 esbuild 打包后运行。
import assert from 'node:assert';
import { db } from './src/utils/db';
import {
  buildMergePlan,
  createBundle,
  executeMerge,
  parseBundle,
  recomputeGrade,
  retryFailedSession,
} from './src/utils/handover';
import { saveSketch } from './src/utils/sketchStore';
import { getDeviceId, setDeviceName } from './src/utils/device';
import { kvFromJv } from './src/utils/handover';
import { createDemoPeerBundle } from './src/utils/demoPeer';

function jitter() {}

async function resetDb() {
  await db.transaction('rw', db.faces, db.joints, db.waters, db.grades, db.archives, db.mergeBases, db.mergeSessions, async () => {
    await Promise.all([
      db.faces.clear(),
      db.joints.clear(),
      db.waters.clear(),
      db.grades.clear(),
      db.archives.clear(),
      db.mergeBases.clear(),
      db.mergeSessions.clear(),
    ]);
  });
}

const now = Date.now();

// 公共祖先（两台平板同步过的状态）
const FACE_ID = 'face_shared_1';
const JOINT_ID = 'joint_shared_1';
const WATER_BASE_ID = 'water_shared_1';
const GRADE_ID = 'grade_shared_1';
const PEER = 'dev_peer_tablet_B';

function baseFace(over = {}) {
  return {
    id: FACE_ID,
    faceNo: 'ZK-200',
    chainage: 12000,
    mileageRange: [12000, 12003],
    excavationMethod: '台阶法',
    faceSize: '12.6×9.8',
    lithology: '砂岩',
    weathering: '弱风化',
    rockStrength: 60,
    attitude: { strike: 40, dipDirection: 130, dipAngle: 30 },
    recordedAt: now - 100000,
    geologist: '甲',
    ...over,
  };
}

async function seedLocal() {
  await resetDb();
  const localFace = baseFace();
  // 本机：改了同一节理组（间距 42 → 30），新增一条涌水；素描新增 1 条
  await db.faces.put(localFace);
  await db.joints.put({
    id: JOINT_ID, faceId: FACE_ID, setNo: 1, dipDirection: 130, dipAngle: 50,
    spacing: 30, persistence: 3, aperture: 1, fillMaterial: '无', roughness: '粗糙',
    waterWet: '潮湿', jointCount: 8,
  });
  await db.waters.put({
    id: WATER_BASE_ID, faceId: FACE_ID, position: '拱顶', type: '渗水', estimatedFlow: 2,
    waterTemp: 14, waterPressure: 0.05, changeTrend: '稳定', measuredAt: now - 90000, chainage: 12000,
  });
  await db.waters.put({
    id: 'water_local_new', faceId: FACE_ID, position: '左拱腰', type: '滴水', estimatedFlow: 7,
    waterTemp: 14, waterPressure: 0.1, changeTrend: '稳定', measuredAt: now - 1000, chainage: 12001,
    provenance: { sourceDeviceId: getDeviceId(), sourceDeviceName: '本机', seq: 1, updatedAt: now },
  });
  await db.grades.put({
    id: GRADE_ID, faceId: FACE_ID, grade: 'Ⅲ', bqValue: 420, rqd: 70, jv: 2.38, kv: 0.6,
    groundwater: '潮湿', spanWidth: 12.6, correction: 0.11, correctedBq: 409,
    supportSuggestion: '旧建议', manualAdjusted: false, judgedAt: now - 80000,
  });
  saveSketch(FACE_ID, [
    { id: 'seg_base_1', x: 100, y: 100, dipAngle: 30, dipDirection: 130, length: 56, label: 'J1' },
    { id: 'seg_local_1', x: 120, y: 110, dipAngle: 30, dipDirection: 130, length: 56, label: 'J2' },
  ]);
  // 同步基线：节理间距还是 50、涌水只有 1 条、素描只有 seg_base_1
  await db.mergeBases.put({
    id: `ZK-200::${PEER}`,
    faceNo: 'ZK-200',
    peerDeviceId: PEER,
    updatedAt: now - 50000,
    faces: { [FACE_ID]: baseFace() },
    joints: {
      [JOINT_ID]: {
        id: JOINT_ID, faceId: FACE_ID, setNo: 1, dipDirection: 130, dipAngle: 50,
        spacing: 50, persistence: 3, aperture: 1, fillMaterial: '无', roughness: '粗糙',
        waterWet: '潮湿', jointCount: 8,
      },
    },
    waters: {
      [WATER_BASE_ID]: {
        id: WATER_BASE_ID, faceId: FACE_ID, position: '拱顶', type: '渗水', estimatedFlow: 2,
        waterTemp: 14, waterPressure: 0.05, changeTrend: '稳定', measuredAt: now - 90000, chainage: 12000,
      },
    },
    grades: {
      [GRADE_ID]: {
        id: GRADE_ID, faceId: FACE_ID, grade: 'Ⅲ', bqValue: 420, rqd: 70, jv: 2, kv: 0.6,
        groundwater: '潮湿', spanWidth: 12.6, correction: 0.11, correctedBq: 409,
        supportSuggestion: '旧建议', manualAdjusted: false, judgedAt: now - 80000,
      },
    },
    sketches: { [FACE_ID]: { ids: ['seg_base_1'], signature: 'x' } },
  });
}

/** 构造对端平板的交接包（直接按导包 JSON 结构拼，模拟另一台设备） */
function peerBundle() {
  return {
    format: 'gbtunnelface-handover',
    bundleVersion: 1,
    deviceId: PEER,
    deviceName: '进口右洞 2 号平板',
    geologist: '乙',
    exportedAt: now - 500,
    faces: [baseFace({ geologist: '甲' })],
    joints: [{
      id: JOINT_ID, faceId: FACE_ID, setNo: 1, dipDirection: 130, dipAngle: 50,
      spacing: 18, persistence: 3, aperture: 1, fillMaterial: '无', roughness: '粗糙',
      waterWet: '线流', jointCount: 8,
      provenance: { sourceDeviceId: PEER, seq: 9, updatedAt: now - 200 },
    }],
    waters: [
      {
        id: WATER_BASE_ID, faceId: FACE_ID, position: '拱顶', type: '渗水', estimatedFlow: 2,
        waterTemp: 14, waterPressure: 0.05, changeTrend: '稳定', measuredAt: now - 90000, chainage: 12000,
      },
      {
        id: 'water_peer_new', faceId: FACE_ID, position: '右拱脚', type: '股状', estimatedFlow: 80,
        waterTemp: 15, waterPressure: 0.6, changeTrend: '突增', measuredAt: now - 300, chainage: 12002,
        provenance: { sourceDeviceId: PEER, sourceDeviceName: '进口右洞 2 号平板', seq: 3 },
      },
    ],
    grades: [],
    // 对端把基线线段删了，另画 2 条 → 删除 vs 本机新增，应判素描冲突
    sketches: {
      [FACE_ID]: [
        { id: 'seg_peer_1', x: 200, y: 200, dipAngle: 30, dipDirection: 130, length: 56, label: 'JP1', sourceDeviceName: '进口右洞 2 号平板' },
        { id: 'seg_peer_2', x: 210, y: 210, dipAngle: 30, dipDirection: 130, length: 56, label: 'JP2', sourceDeviceName: '进口右洞 2 号平板' },
      ],
    },
  };
}

async function main() {
  setDeviceName('驻地主机');

  // ---------- 纯函数：Jv→Kv ----------
  assert.ok(kvFromJv(2) > kvFromJv(20), 'Kv 应随 Jv 增大而减小');
  const rcSample = recomputeGrade(
    baseFace(),
    [{ spacing: 40 }],
    [{ type: '股状' }],
    { id: 'g', faceId: FACE_ID, grade: 'Ⅱ', bqValue: 500, rqd: 80, jv: 2, kv: 0.7, groundwater: '干燥', spanWidth: 12.6, correction: 0.06, correctedBq: 494, supportSuggestion: '', manualAdjusted: false, judgedAt: 1 },
  );
  assert.strictEqual(rcSample.record.groundwater, '涌流状出水');
  assert.ok(rcSample.record.correctedBq < rcSample.record.bqValue);

  await seedLocal();

  // ---------- 解析校验 ----------
  assert.throws(() => parseBundle('{"x":1}'), /交接包标识/);
  const bundleText = JSON.stringify(peerBundle());

  // ---------- 构建合并计划 ----------
  const bundle = parseBundle(bundleText);
  let plan = await buildMergePlan(bundle);
  const fp = plan.faces.find((f) => f.faceNo === 'ZK-200');
  assert.ok(fp, '应按 faceNo 认领掌子面');
  assert.strictEqual(fp.isNew, false);

  // 节理两边都改 → 冲突
  const jointConflict = fp.conflicts.find((c) => c.key === `joints:${JOINT_ID}`);
  assert.ok(jointConflict, '节理组两边都改必须列冲突');
  const spacingDiff = jointConflict.fields.find((d) => d.label === '间距 cm');
  assert.strictEqual(spacingDiff.local, 30);
  assert.strictEqual(spacingDiff.incoming, 18);

  // 对端新涌水 → 新增，带来源
  const waterAdd = fp.adds.find((a) => a.table === 'waters');
  assert.ok(waterAdd && waterAdd.deviceName === '进口右洞 2 号平板');

  // 素描：基线删线 vs 本机新增 → 冲突
  assert.strictEqual(fp.sketch.status, 'conflict');
  assert.strictEqual(fp.recomputeNeeded, true);

  // 未选完冲突不允许执行（预检类错误在事务外抛出）
  await assert.rejects(() => executeMerge(plan, {}), /未选择主版本/);

  // ---------- 地质员选择：节理取对端、素描取本机 ----------
  const resolutions = {
    [jointConflict.key]: 'incoming',
    [fp.sketch.conflict.key]: 'local',
  };
  const ok = await executeMerge(plan, resolutions);
  assert.strictEqual(ok.ok, true, ok.errorMessage);

  // 节理采用对端值（spacing=18，waterWet=线流）
  const mergedJoint = await db.joints.get(JOINT_ID);
  assert.strictEqual(mergedJoint.spacing, 18);
  assert.strictEqual(mergedJoint.waterWet, '线流');

  // 涌水：两条新增都在（本机 + 对端，按来源保留），顺序稳定
  const waters = await db.waters.where('faceId').equals(FACE_ID).toArray();
  assert.strictEqual(waters.length, 3);
  assert.ok(waters.some((w) => w.id === 'water_local_new'));
  assert.ok(waters.some((w) => w.id === 'water_peer_new'));
  const peerWater = waters.find((w) => w.id === 'water_peer_new');
  assert.strictEqual(peerWater.provenance.sourceDeviceName, '进口右洞 2 号平板');

  // 素描取本机版本：对端 2 条进归档可查
  const { loadSketch } = await import('./src/utils/sketchStore');
  const segs = loadSketch(FACE_ID);
  assert.deepStrictEqual(segs.map((s) => s.id), ['seg_base_1', 'seg_local_1']);
  const sketchArch = await db.archives.where('kind').equals('sketch-dropped').first();
  assert.ok(sketchArch);
  assert.strictEqual(sketchArch.payload.length, 2);

  // 围岩判定已重算：旧的留存 + 新判定（股状 → 涌流状 K1=0.28，级别应不优于旧判定）
  const grades = await db.grades.where('faceId').equals(FACE_ID).toArray();
  const newest = grades.sort((a, b) => b.judgedAt - a.judgedAt)[0];
  assert.strictEqual(newest.recomputedAfterMerge, true);
  assert.deepStrictEqual(newest.supersedesGradeIds, [GRADE_ID]);
  assert.strictEqual(newest.groundwater, '涌流状出水');
  assert.ok(newest.judgedAt > now);
  const superseded = await db.archives.where('kind').equals('superseded-grade').first();
  assert.ok(superseded && superseded.note.includes('重算'));

  // 基线已刷新
  const base = await db.mergeBases.get(`ZK-200::${PEER}`);
  assert.ok(base.joints[JOINT_ID] && base.joints[JOINT_ID].spacing === 18);

  // 成功会话
  const session = await db.mergeSessions.where('status').equals('success').first();
  assert.ok(session);

  // ---------- 再导一次同一个包：基线对齐后不应再有冲突/新增 ----------
  const plan2 = await buildMergePlan(parseBundle(JSON.stringify(peerBundle())));
  const fp2 = plan2.faces[0];
  assert.strictEqual(fp2.conflicts.length, 0);
  assert.strictEqual(fp2.adds.length, 0);
  assert.notStrictEqual(fp2.sketch.status, 'conflict');

  // ---------- 失败恢复：人为让素描保存抛错 ----------
  await seedLocal();
  const plan3 = await buildMergePlan(parseBundle(JSON.stringify(peerBundle())));
  const fp3 = plan3.faces[0];
  const res3 = {
    [fp3.conflicts.find((c) => c.table === 'joints').key]: 'incoming',
    [fp3.sketch.conflict.key]: 'incoming',
  };
  const origSetItem = window.localStorage.setItem.bind(window.localStorage);
  let failOnce = true;
  window.localStorage.setItem = (key, value) => {
    if (failOnce && typeof key === 'string' && key.startsWith('gbtunnelface:sketch:')) {
      failOnce = false;
      throw new Error('模拟存储损坏');
    }
    return origSetItem(key, value);
  };
  const failed = await executeMerge(plan3, res3);
  window.localStorage.setItem = origSetItem;
  assert.strictEqual(failed.ok, false);
  assert.ok(failed.errorMessage.includes('模拟存储损坏'));

  // 失败后现场原记录保留：节理仍是本机的 30，涌水仍是 2 条
  const jAfterFail = await db.joints.get(JOINT_ID);
  assert.strictEqual(jAfterFail.spacing, 30);
  assert.strictEqual((await db.waters.where('faceId').equals(FACE_ID).toArray()).length, 2);
  const segsAfterFail = loadSketch(FACE_ID);
  assert.deepStrictEqual(segsAfterFail.map((s) => s.id), ['seg_base_1', 'seg_local_1'], '素描必须回滚');

  // 失败会话保留原包与已选内容
  const failedSession = await db.mergeSessions.where('status').equals('failed').first();
  assert.ok(failedSession && failedSession.bundle && failedSession.resolutions);

  // 恢复重试（此时存储正常）
  const rebuilt = await retryFailedSession(failedSession);
  assert.strictEqual(Object.keys(rebuilt.resolutions).length, 2, '上次的选择应保留');
  const retry = await executeMerge(rebuilt.plan, rebuilt.resolutions);
  assert.strictEqual(retry.ok, true, retry.errorMessage);
  const jAfterRetry = await db.joints.get(JOINT_ID);
  assert.strictEqual(jAfterRetry.spacing, 18);

  // ---------- 全新掌子面认领：本机没有 ZK-300，id 与子记录一并迁入 ----------
  const newFaceId = 'face_new_on_peer';
  const newBundle = {
    format: 'gbtunnelface-handover',
    bundleVersion: 1,
    deviceId: 'dev_peer_C',
    deviceName: '出口平板',
    geologist: '丙',
    exportedAt: now,
    faces: [{
      id: newFaceId, faceNo: 'ZK-300', chainage: 13000, mileageRange: [13000, 13003],
      excavationMethod: '全断面', faceSize: '10×8', lithology: '花岗岩', weathering: '微风化',
      rockStrength: 90, attitude: { strike: 10, dipDirection: 100, dipAngle: 45 },
      recordedAt: now, geologist: '丙',
    }],
    joints: [{
      id: 'joint_peer_only', faceId: newFaceId, setNo: 1, dipDirection: 100, dipAngle: 45,
      spacing: 80, persistence: 5, aperture: 0.5, fillMaterial: '无', roughness: '平整',
      waterWet: '干燥', jointCount: 3,
      provenance: { sourceDeviceId: 'dev_peer_C', sourceDeviceName: '出口平板', seq: 1 },
    }],
    waters: [],
    grades: [{
      id: 'grade_peer_only', faceId: newFaceId, grade: 'Ⅱ', bqValue: 510, rqd: 90, jv: 1.2, kv: 0.8,
      groundwater: '干燥', spanWidth: 10, correction: 0.03, correctedBq: 507,
      supportSuggestion: '出口建议', manualAdjusted: false, judgedAt: now,
    }],
    sketches: {
      [newFaceId]: [
        { id: 'seg_new_1', x: 50, y: 50, dipAngle: 45, dipDirection: 100, length: 56, label: 'J1' },
      ],
    },
  };
  const planNew = await buildMergePlan(parseBundle(JSON.stringify(newBundle)));
  assert.strictEqual(planNew.faces.length, 1);
  assert.strictEqual(planNew.faces[0].isNew, true);
  assert.strictEqual(planNew.conflictCount, 0);
  const resNew = await executeMerge(planNew, {});
  assert.strictEqual(resNew.ok, true, resNew.errorMessage);
  const claimed = await db.faces.where('faceNo').equals('ZK-300').first();
  assert.ok(claimed);
  const claimedJoints = await db.joints.where('faceId').equals(claimed.id).toArray();
  assert.strictEqual(claimedJoints.length, 1);
  assert.strictEqual(claimedJoints[0].id, 'joint_peer_only');
  assert.strictEqual(loadSketch(claimed.id).length, 1);
  // 新掌子面不重算（带过来的判定就是对端现场结论）
  const claimedGrades = await db.grades.where('faceId').equals(claimed.id).toArray();
  assert.strictEqual(claimedGrades.length, 1);
  assert.strictEqual(claimedGrades[0].recomputedAfterMerge, undefined);

  // ---------- 演练包生成器在当前库上必须可直接走通预检 + 合并 ----------
  const demoBundle = await createDemoPeerBundle();
  const demoPlan = await buildMergePlan(demoBundle);
  assert.ok(demoPlan.faces.some((f) => f.isNew), '演练包应包含一个新掌子面');
  const demoResolutions = {};
  for (const f of demoPlan.faces) {
    for (const c of f.conflicts) demoResolutions[c.key] = 'incoming';
  }
  const demoOutcome = await executeMerge(demoPlan, demoResolutions);
  assert.strictEqual(demoOutcome.ok, true, demoOutcome.errorMessage);
  assert.ok(demoOutcome.recomputed.length >= 1, '已有掌子面因节理/涌水并入应触发重算');

  console.log('全部断言通过 ✔');
  void jitter;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
