const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseOutline} = require('../extension-src/out/common/outline-view.cjs');
test('IDE outline parses ATX headings with nesting, ignoring fenced code', () => {
  const text=['# 一','','## 子甲','','正文 ### 非标题','','```md','# 围栏里的假标题','```','','### 孙','','#### 孙孙 ','','   ## 缩进子乙 ##','','# 尾 #',''].join('\n');
  const {roots,flat}=parseOutline(text);
  assert.deepEqual(flat.map(h=>[h.level,h.text]),[[1,'一'],[2,'子甲'],[3,'孙'],[4,'孙孙'],[2,'缩进子乙'],[1,'尾']]);
  const one=roots[0];
  assert.deepEqual(one.children.map(h=>h.text),['子甲','缩进子乙']);
  assert.deepEqual(one.children[0].children.map(h=>h.text),['孙']);
  assert.deepEqual(one.children[0].children[0].children.map(h=>h.text),['孙孙']);
  assert.equal(flat[0].line,0);assert.equal(flat[2].line,10);assert.equal(flat[4].line,14);
  for(let i=0;i<flat.length;i++)assert.equal(flat[i].index,i);
});
test('IDE outline: empty headings, fences with tildes, CRLF and markers', () => {
  const crlf='# 标题A\r\n\r\n~~~\r\n# 假\r\n~~~\r\n\r\n##   \r\n\r\n## **加粗** 标题 `B`\r\n';
  const {flat}=parseOutline(crlf);
  assert.deepEqual(flat.map(h=>[h.level,h.text]),[[1,'标题A'],[2,'(无标题)'],[2,'加粗 标题 B']]);
  const empty=parseOutline('正文没有标题\n');
  assert.equal(empty.flat.length,0);assert.equal(empty.roots.length,0);
  const unclosed=parseOutline('# 有\n\n```\n# 假一\n');
  assert.deepEqual(parseOutline('# 有\n\n```\n# 假一\n').flat.map(h=>h.text),['有']);
  assert.equal(unclosed.flat.length,1);
});
