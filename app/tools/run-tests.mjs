#!/usr/bin/env node
/**
 * run-tests.mjs — テストを全部（`app/tests/*.test.mjs` と、旧来の計算の `tests/*.test.mjs`）まとめて動かす入口。
 * 1 本ずつ別の node で動かし（GAS のモックの状態を混ぜない）、通ったか・止まったかを 1 行ずつ出す。止まったテストは出力の終わりを見せる。
 * どれか 1 本でも止まれば終了コードは 1。GAS の上で動かしたことの代わりではない（模擬）。
 *
 *   node app/tools/run-tests.mjs              # 全部
 *   node app/tools/run-tests.mjs v11 landing   # ファイル名にどれかの語を含むものだけ
 *   node app/tools/run-tests.mjs --serial     # 1 本ずつ順に（既定は CPU の数だけ並べて動かす）
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIRS = ['app/tests', 'tests'];
const TAIL_LINES = 30;

async function listTests_() {
  const files = [];
  for (const dir of DIRS) {
    const names = await readdir(path.join(repoRoot, dir)).catch(() => []);
    for (const n of names.sort()) if (n.endsWith('.test.mjs')) files.push(path.join(dir, n));
  }
  return files;
}

function runOne_(rel) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [rel], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ rel, ok: code === 0, code, ms: Date.now() - started, out }));
    child.on('error', err => resolve({ rel, ok: false, code: null, ms: Date.now() - started, out: String(err && err.stack || err) }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const serial = args.includes('--serial');
  const words = args.filter(a => !a.startsWith('--'));
  const all = await listTests_();
  const files = words.length ? all.filter(f => words.some(w => path.basename(f).includes(w))) : all;
  if (!files.length) {
    console.error('動かすテストがありません' + (words.length ? '（' + words.join('・') + ' を含むファイルが無い）' : ''));
    process.exit(1);
  }
  const limit = serial ? 1 : Math.max(1, Math.min(files.length, (os.availableParallelism ? os.availableParallelism() : os.cpus().length)));
  const results = [];
  let next = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < files.length) {
      const r = await runOne_(files[next++]);
      results.push(r);
      console.log((r.ok ? '通過 ' : '失敗 ') + r.rel + '（' + (r.ms / 1000).toFixed(1) + ' 秒）');
    }
  }));
  const failed = results.filter(r => !r.ok).sort((a, b) => a.rel.localeCompare(b.rel));
  for (const r of failed) {
    const lines = r.out.trimEnd().split('\n');
    console.log('\n---- ' + r.rel + '（終了コード ' + r.code + '。出力の終わり ' + Math.min(TAIL_LINES, lines.length) + ' 行）----');
    console.log(lines.slice(-TAIL_LINES).join('\n'));
  }
  console.log('\n' + results.length + ' 本: 通過 ' + (results.length - failed.length) + '・失敗 ' + failed.length + '（' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒）');
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
