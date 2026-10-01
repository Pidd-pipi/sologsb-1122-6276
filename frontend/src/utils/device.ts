/**
 * 本机设备身份与记录来源戳记。
 * 断网编录时每条记录都带上 sourceDevice 与设备内自增 seq，
 * 回驻地合并时据此保留来源与现场录入顺序。
 */
import type { RecordProvenance } from '../types/sync';

const DEVICE_ID_KEY = 'gbtunnelface:device-id';
const DEVICE_NAME_KEY = 'gbtunnelface:device-name';
const GEOLOGIST_KEY = 'gbtunnelface:geologist';
const SEQ_KEY = 'gbtunnelface:seq';

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** 设备 id 首次自动生成，可在交接页修改设备名称与地质员 */
export function getDeviceId(): string {
  try {
    let id = window.localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = `dev_${Date.now().toString(36)}${randomSuffix()}`;
      window.localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return `dev_${randomSuffix()}`;
  }
}

export function getDeviceName(): string {
  try {
    return window.localStorage.getItem(DEVICE_NAME_KEY) ?? '驻地平板';
  } catch {
    return '驻地平板';
  }
}

export function setDeviceName(name: string): void {
  try {
    window.localStorage.setItem(DEVICE_NAME_KEY, name);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function getGeologist(): string {
  try {
    return window.localStorage.getItem(GEOLOGIST_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setGeologist(name: string): void {
  try {
    window.localStorage.setItem(GEOLOGIST_KEY, name);
  } catch {
    /* 忽略 */
  }
}

function nextSeq(): number {
  try {
    const current = Number(window.localStorage.getItem(SEQ_KEY) ?? '0');
    const next = Number.isFinite(current) ? current + 1 : 1;
    window.localStorage.setItem(SEQ_KEY, String(next));
    return next;
  } catch {
    return Date.now();
  }
}

/** 新增记录时盖来源戳 */
export function stampProvenance(): RecordProvenance {
  return {
    sourceDeviceId: getDeviceId(),
    sourceDeviceName: getDeviceName(),
    seq: nextSeq(),
    updatedAt: Date.now(),
  };
}

/** 本机修改记录时刷新 updatedAt（来源保持首录设备不变） */
export function touchProvenance(existing?: RecordProvenance): RecordProvenance {
  return {
    sourceDeviceId: existing?.sourceDeviceId ?? getDeviceId(),
    sourceDeviceName: existing?.sourceDeviceName ?? getDeviceName(),
    seq: existing?.seq ?? nextSeq(),
    updatedAt: Date.now(),
  };
}
