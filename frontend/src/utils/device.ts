import { newId } from './id';
import type { MergeMeta } from '../types/merge';

const DEVICE_KEY = 'gbtunnelface:device';
const SEQ_KEY = 'gbtunnelface:seq';

export interface DeviceInfo {
  id: string;
  name: string;
}

const DEFAULT_NAME = '本机';

/** 读取本机设备身份（没有则创建一个） */
export function getDevice(): DeviceInfo {
  try {
    const raw = window.localStorage.getItem(DEVICE_KEY);
    if (raw) {
      const d = JSON.parse(raw) as DeviceInfo;
      if (d && typeof d.id === 'string' && typeof d.name === 'string') return d;
    }
  } catch {
    /* 忽略解析失败 */
  }
  const d: DeviceInfo = { id: newId('dev'), name: DEFAULT_NAME };
  try {
    window.localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
  } catch {
    /* 忽略写入失败 */
  }
  return d;
}

/** 设置本机设备名称 */
export function setDeviceName(name: string): DeviceInfo {
  const d = getDevice();
  d.name = name.trim() || DEFAULT_NAME;
  try {
    window.localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
  } catch {
    /* 忽略写入失败 */
  }
  return d;
}

/** 某类记录在本设备内的下一个顺序号（保留录入先后次序） */
export function nextSeq(entityType: 'face' | 'joint' | 'grade' | 'water' | 'sketch'): number {
  try {
    const raw = window.localStorage.getItem(SEQ_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    map[entityType] = (map[entityType] ?? 0) + 1;
    window.localStorage.setItem(SEQ_KEY, JSON.stringify(map));
    return map[entityType];
  } catch {
    return 0;
  }
}

/** 新建记录时附带跨设备认领元信息 */
export function makeMeta(entityType: 'face' | 'joint' | 'grade' | 'water' | 'sketch'): MergeMeta {
  const d = getDevice();
  return { uid: newId('uid'), source: d.name, seq: nextSeq(entityType) };
}

/** 种子数据的元信息（所有设备从同一种子灌入时保持一致，便于互相认领） */
export function seedMeta(table: 'face' | 'joint' | 'grade' | 'water', n: number): MergeMeta {
  return { uid: `seed-${table}-${n}`, source: 'seed', seq: 0 };
}
