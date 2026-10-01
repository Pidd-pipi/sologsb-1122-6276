/**
 * 演练数据：在驻地单机上模拟另一台断网平板对当前库做的编录，
 * 生成一份可直接走正常导入预检流程的交接包。
 * 覆盖：同一掌子面两边改、新增涌水、新掌子面整份认领、素描各画各的。
 */
import { db, toPlain } from './db';
import { newId } from './id';
import { loadSketch } from './sketchStore';
import type { HandoverBundle } from '../types/sync';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { WaterInflow } from '../types/water';
import type { RockMassGrade } from '../types/grade';

export const DEMO_PEER_DEVICE_ID = 'dev_demo_peer';

export async function createDemoPeerBundle(): Promise<HandoverBundle> {
  const faces = await db.faces.toArray();
  const joints = await db.joints.toArray();
  const waters = await db.waters.toArray();
  const grades = await db.grades.toArray();

  const now = Date.now();
  const bundle: HandoverBundle = {
    format: 'gbtunnelface-handover',
    bundleVersion: 1,
    deviceId: DEMO_PEER_DEVICE_ID,
    deviceName: '进口左洞 2 号平板（演练）',
    geologist: '演练地质员',
    exportedAt: now,
    faces: [],
    joints: [],
    waters: [],
    grades: [],
    sketches: {},
  };

  const stamp = { sourceDeviceId: DEMO_PEER_DEVICE_ID, sourceDeviceName: bundle.deviceName, seq: 1, updatedAt: now };

  // 1) 对库中第一个掌子面：两边都改基本信息与一条节理、新增一条股状涌水，并各画两条素描
  const first = faces[0];
  if (first) {
    const changedFace: TunnelFace = {
      ...toPlain(first),
      // 与本机形成字段冲突
      weathering: first.weathering === '强风化' ? '弱风化' : '强风化',
      geologist: `${first.geologist || '值班员'}／乙班复核`,
      provenance: stamp,
    };
    bundle.faces.push(changedFace);

    const faceJoints = joints.filter((j) => j.faceId === first.id);
    faceJoints.forEach((j, i) => {
      const copy: JointSet = { ...toPlain(j) };
      if (i === 0) {
        // 第一条节理两边都改，制造冲突
        copy.spacing = Math.max(10, Math.round(copy.spacing * 0.6));
        copy.waterWet = '线流';
        copy.jointCount += 4;
      }
      copy.provenance = { ...stamp, seq: stamp.seq + i };
      bundle.joints.push(copy);
    });

    const faceWaters = waters.filter((w) => w.faceId === first.id);
    faceWaters.forEach((w) => bundle.waters.push({ ...toPlain(w) }));
    const surge: WaterInflow = {
      id: newId('water'),
      faceId: first.id,
      position: '演练：拱脚股状涌水',
      type: '股状',
      estimatedFlow: 72,
      waterTemp: 16,
      waterPressure: 0.55,
      changeTrend: '突增',
      measuredAt: now,
      chainage: first.chainage + 1,
      provenance: { ...stamp, seq: 50 },
    };
    bundle.waters.push(surge);

    grades
      .filter((g) => g.faceId === first.id)
      .forEach((g) => bundle.grades.push({ ...toPlain(g) }));

    // 素描：对端在自己视图里新画两条（id 与本机不重叠 → 无基线时保序并集，不冲突）
    const baseSegs = loadSketch(first.id);
    bundle.sketches[first.id] = [
      ...baseSegs.map((s) => ({ ...s })),
      {
        id: `seg_demo_${now}_1`,
        x: 260,
        y: 240,
        dipAngle: first.attitude.dipAngle,
        dipDirection: first.attitude.dipDirection,
        length: 56,
        label: `J${baseSegs.length + 1} 演练`,
        sourceDeviceId: DEMO_PEER_DEVICE_ID,
        sourceDeviceName: bundle.deviceName,
        seq: 60,
      },
      {
        id: `seg_demo_${now}_2`,
        x: 285,
        y: 260,
        dipAngle: first.attitude.dipAngle,
        dipDirection: first.attitude.dipDirection,
        length: 56,
        label: `J${baseSegs.length + 2} 演练`,
        sourceDeviceId: DEMO_PEER_DEVICE_ID,
        sourceDeviceName: bundle.deviceName,
        seq: 61,
      },
    ];
  }

  // 2) 整份新掌子面：演练一个本机没有的编号，带子记录与素描，走「按编号认领」
  const newFaceId = newId('face');
  const demoFaceNo = `ZK-DEMO-${String(now).slice(-4)}`;
  const newFace: TunnelFace = {
    id: newFaceId,
    faceNo: demoFaceNo,
    chainage: (faces[0]?.chainage ?? 12000) + 300,
    mileageRange: [(faces[0]?.chainage ?? 12000) + 300, (faces[0]?.chainage ?? 12000) + 303],
    excavationMethod: 'CD 法',
    faceSize: '11.8×9.2',
    lithology: '断层角砾岩',
    weathering: '强风化',
    rockStrength: 16,
    attitude: { strike: 70, dipDirection: 160, dipAngle: 62 },
    recordedAt: now,
    geologist: '演练地质员',
    provenance: stamp,
  };
  const newJoint: JointSet = {
    id: newId('joint'),
    faceId: newFaceId,
    setNo: 1,
    dipDirection: 160,
    dipAngle: 62,
    spacing: 18,
    persistence: 6.2,
    aperture: 4.5,
    fillMaterial: '泥质',
    roughness: '平直光滑',
    waterWet: '滴水',
    jointCount: 15,
    provenance: { ...stamp, seq: 2 },
  };
  const newWater: WaterInflow = {
    id: newId('water'),
    faceId: newFaceId,
    position: '演练：断层带上盘',
    type: '线流',
    estimatedFlow: 24,
    waterTemp: 15,
    waterPressure: 0.3,
    changeTrend: '增大',
    measuredAt: now,
    chainage: newFace.chainage,
    provenance: { ...stamp, seq: 3 },
  };
  const newGrade: RockMassGrade = {
    id: newId('grade'),
    faceId: newFaceId,
    grade: 'Ⅴ',
    bqValue: 238,
    rqd: 32,
    jv: 18.5,
    kv: 0.38,
    groundwater: '线状出水',
    spanWidth: 11.8,
    correction: 0.31,
    correctedBq: 207,
    supportSuggestion: '演练：超前小导管 + 钢拱架',
    manualAdjusted: false,
    judgedAt: now,
    provenance: { ...stamp, seq: 4 },
  };
  bundle.faces.push(newFace);
  bundle.joints.push(newJoint);
  bundle.waters.push(newWater);
  bundle.grades.push(newGrade);
  bundle.sketches[newFaceId] = [
    {
      id: `seg_demo_new_${now}`,
      x: 150,
      y: 180,
      dipAngle: 62,
      dipDirection: 160,
      length: 56,
      label: 'J1 演练',
      sourceDeviceId: DEMO_PEER_DEVICE_ID,
      sourceDeviceName: bundle.deviceName,
      seq: 5,
    },
  ];

  return bundle;
}
