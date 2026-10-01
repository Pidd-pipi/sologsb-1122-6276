/**
 * 素描线段的 localStorage 存取助手。
 * 线段历史上按 faceId 存在 localStorage['gbtunnelface:sketch:<faceId>']，
 * 离线合并需要整体读出、备份并按顺序合并，因此集中在此管理。
 */
import type { SketchSegmentPayload } from '../types/sync';

export const SKETCH_KEY_PREFIX = 'gbtunnelface:sketch:';

export function sketchStorageKey(faceId: string): string {
  return `${SKETCH_KEY_PREFIX}${faceId}`;
}

export function loadSketch(faceId: string): SketchSegmentPayload[] {
  try {
    const raw = window.localStorage.getItem(sketchStorageKey(faceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SketchSegmentPayload[]) : [];
  } catch {
    return [];
  }
}

export function saveSketch(faceId: string, segments: SketchSegmentPayload[]): void {
  window.localStorage.setItem(sketchStorageKey(faceId), JSON.stringify(segments));
}

/** 读出全部掌子面的素描（导出交接包用），返回 faceId → 线段 */
export function loadAllSketches(): Record<string, SketchSegmentPayload[]> {
  const result: Record<string, SketchSegmentPayload[]> = {};
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(SKETCH_KEY_PREFIX)) {
        const faceId = key.slice(SKETCH_KEY_PREFIX.length);
        const segments = loadSketch(faceId);
        if (segments.length > 0) result[faceId] = segments;
      }
    }
  } catch {
    /* localStorage 不可用时返回已收集部分 */
  }
  return result;
}

/** 内容签名：用于判断两边素描是否各自改过（线段顺序也参与签名） */
export function sketchSignature(segments: SketchSegmentPayload[]): string {
  const basis = segments
    .map((s) => `${s.id}:${s.x},${s.y},${s.dipDirection},${s.dipAngle},${s.length},${s.label}`)
    .join('|');
  let hash = 0;
  for (let i = 0; i < basis.length; i += 1) {
    hash = (hash << 5) - hash + basis.charCodeAt(i);
    hash |= 0;
  }
  return `${segments.length}:${hash.toString(36)}`;
}
