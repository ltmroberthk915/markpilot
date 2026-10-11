/** 小补丁：probe-qoff 每次跑用全新 profile 目录（固定目录被残留进程占住 ⇒ Chromium 起不出窗口）。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-qoff.cjs');
let t = fs.readFileSync(p, 'utf8');
const oldLine = "const PROFILE = path.join(DIR, 'accept', 'profile-qoff');";
const newLine = "/* 每次跑用**全新** profile：固定目录若被上一次残留进程占住，Chromium 会起不出窗口（实测：CDP 连得上但 ctx.pages() 恒空） */\nconst PROFILE = path.join(DIR, 'accept', 'profile-qoff-' + Date.now());";
if (t.includes(newLine)) console.log('· 已打过补丁');
else if (t.includes(oldLine)) { t = t.replace(oldLine, newLine); fs.writeFileSync(p, t, 'utf8'); console.log('✓ 已改为每次全新 profile'); }
else console.log('✗ 没找到 PROFILE 定义行');
