/** family=file-ops-real：从探针 JSON 里挑字段打印（只读；避免 PS 处理中文键的转义问题） */
'use strict';
const fs = require('node:fs');
const file = process.argv[2];
const paths = process.argv.slice(3);
const J = JSON.parse(fs.readFileSync(file, 'utf8'));
const get = (p) => p.split('.').reduce((o, k) => (o === undefined || o === null ? o : o[k]), J);
if (!paths.length) { console.log(JSON.stringify(J.readings, null, 1)); }
else for (const p of paths) console.log('### ' + p + ' = ' + JSON.stringify(get(p), null, 1));
