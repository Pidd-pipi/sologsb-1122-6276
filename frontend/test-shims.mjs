// 全局垫片：必须在任何业务模块导入前执行（Dexie 构造时探测 indexedDB）
import * as fakeIDB from 'fake-indexeddb';

class MemoryStorage {
  store = new Map();
  getItem(k) {
    return this.store.has(k) ? this.store.get(k) : null;
  }
  setItem(k, v) {
    this.store.set(k, String(v));
  }
  removeItem(k) {
    this.store.delete(k);
  }
  key(i) {
    return [...this.store.keys()][i] ?? null;
  }
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
}
const memoryLS = new MemoryStorage();
globalThis.localStorage = memoryLS;
globalThis.indexedDB = fakeIDB.indexedDB;
globalThis.IDBKeyRange = fakeIDB.IDBKeyRange;
class CustomEventShim {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}
globalThis.CustomEvent = CustomEventShim;
globalThis.window = {
  localStorage: memoryLS,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return true;
  },
};
