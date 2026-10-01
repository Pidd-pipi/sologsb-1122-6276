// 用 esbuild 把 TS 合并引擎打成单文件（Node 平台），垫片先于业务模块执行。
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

mkdirSync('node_modules/.tmp', { recursive: true });
const shimUrl = pathToFileURL(`${process.cwd()}/test-shims.mjs`).href;
// 垫片先执行；再用全局赋值为 bundle 内裸 indexedDB / localStorage 等名字提供绑定
const preamble = `import ${JSON.stringify(shimUrl)};
var indexedDB = globalThis.indexedDB;
var IDBKeyRange = globalThis.IDBKeyRange;
var localStorage = globalThis.localStorage;
var window = globalThis.window;
var CustomEvent = globalThis.CustomEvent;
var document = globalThis.document;`;
await build({
  entryPoints: ['merge.e2e.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  external: ['node:*'],
  banner: { js: preamble },
  outfile: 'node_modules/.tmp/merge.e2e.mjs',
  logLevel: 'info',
  absWorkingDir: process.cwd(),
});

await import('./node_modules/.tmp/merge.e2e.mjs');
