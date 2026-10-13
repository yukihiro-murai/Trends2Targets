#!/usr/bin/env node
/*
 * app-ui-style.test.mjs — 入力欄と枠のボタンの枠の濃さ（提案 29。2026-10-13）。
 *   入力欄（.inp）と枠のボタン（.btn-ghost）の枠の色 --line-ctl は、白・カード・画面の地・水色の吹き出し・エラーと注意のカードの上で 3:1 以上
 *   （部品の境目の目安）。紺・灰青の系統のまま。カーソルを置いたときは薄くしない。押せないボタン・押せないプルダウン・表やカードの線は今までどおり
 * 画面の見た目の最終の確かめは、写真と寸法（ローカルの点検の仕組み）で行う。
 *
 *   node app/tests/app-ui-style.test.mjs
 */
import assert from 'node:assert/strict';
import { uiHtml } from './gas-mock.mjs';

const css = uiHtml.slice(uiHtml.indexOf('<style>'), uiHtml.indexOf('</style>'));
const root = /:root\{([\s\S]*?)\n\}/.exec(css)[1];
const vars = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const hex = (name) => { let v = vars[name]; for (let i = 0; i < 4 && /^var\(--/.test(v); i++) v = vars[/^var\(--([\w-]+)\)/.exec(v)[1]]; assert.match(v, /^#[0-9A-Fa-f]{6}$/, name + ' は 6 けたの色: ' + v); return v; };
const lum = (h) => { const c = h.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** CSS の規則（セレクタがちょうどその文字列の、最初の { } の中身） */
const rule = (sel) => { const i = css.indexOf('\n' + sel + '{'); assert.ok(i >= 0, '規則 ' + sel); const s = css.indexOf('{', i) + 1; return css.slice(s, css.indexOf('}', s)); };

const ctl = hex('line-ctl');
const grounds = { 白: '#FFFFFF', カード: hex('card'), 画面の地: hex('bg'), 面: hex('surface'), 見出し: hex('head'), 淡い水色のカード: hex('primary-soft-2'), 水色の吹き出し: hex('primary-soft'), エラーのカード: hex('error-bg'), 注意のカード: hex('warn-bg') };
for (const [k, g] of Object.entries(grounds)) assert.ok(ratio(ctl, g) >= 3, `${k}（${g}）の上で 3:1 以上: ${ratio(ctl, g).toFixed(2)}`);
assert.ok(ratio(ctl, '#FFFFFF') < 4, '濃すぎない（線としての濃さ）: ' + ratio(ctl, '#FFFFFF').toFixed(2));
// 前の色は 3:1 に届かなかった（入力欄 1.29・枠のボタン 1.47）
assert.ok(ratio(hex('line'), '#FFFFFF') < 1.5 && ratio(hex('line-strong'), '#FFFFFF') < 1.5);
// 紺・灰青の系統（青みの灰: 青が一番強く、赤が一番弱い）
const [r, g, b] = ctl.slice(1).match(/../g).map((x) => parseInt(x, 16));
assert.ok(b > g && g > r && b - r < 64, '灰青: ' + ctl);
assert.ok(ratio(hex('line-ctl-hover'), '#FFFFFF') >= ratio(ctl, '#FFFFFF'), 'カーソルを置くと濃く（薄くしない）');

assert.match(rule('.inp'), /border:1\.5px solid var\(--line-ctl\)/, '入力欄の枠');
assert.match(rule('.inp:hover'), /border-color:var\(--line-ctl-hover\)/);
assert.match(rule('.btn-ghost'), /border:1\.5px solid var\(--line-ctl\)/, '枠のボタンの枠');
assert.match(rule('.btn-ghost:hover:not(:disabled)'), /border-color:var\(--primary\)/, 'カーソルを置くと水色の枠（淡い水色の線にしない）');
assert.ok(ratio(hex('primary'), hex('primary-soft-2')) > ratio(hex('primary-line'), hex('primary-soft-2')) + 1);
// 押せない部品の見た目は今までどおり
assert.match(rule('.btn-ghost:disabled'), /^border-color:var\(--line-strong\)$/, '押せない枠のボタンは前の淡い枠');
assert.match(rule('.btn:disabled'), /opacity:\.5/);
assert.match(rule('select.inp:disabled'), /border-color:var\(--line\)/, '押せないプルダウンは前の淡い枠');
// ほかの線は変えない（表・カード・タブ・丸い札の切り替え）
assert.match(rule('.card'), /border:1px solid var\(--line\)/);
assert.match(rule('.tbl th'), /border-bottom:1px solid var\(--line\)/);
assert.match(rule('.tbl td'), /border-bottom:1px solid var\(--line-soft\)/);
assert.match(rule('.tbl tr.total td'), /border-top:1\.5px solid var\(--line-strong\)/);
assert.match(rule('.tabs'), /border-bottom:1px solid var\(--line\)/);
assert.match(rule('.tabs.sub .tab'), /border:1\.5px solid var\(--line\)/);
assert.equal((css.match(/var\(--line-ctl\)/g) || []).length, 2, '濃い枠は入力欄と枠のボタンだけ');

console.log('app-ui-style: ok');
