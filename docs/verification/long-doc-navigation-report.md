# long-doc-navigation —— 长文档导航普查（族报告）

- 时间：2026-10-10T02:40:47.735Z
- 被测产物：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe` sha16=`addc36f96863f29c` bytes=188784128 mtime=2026-10-10T02:40:31.446Z
- 夹具：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-run\long-doc-navigation-fixture.md`（引擎口径 1221 行）/ 53 个标题 / sha256_16=`39cfc651f7a5d367`
- 输入通道：page.keyboard（CDP Input.dispatchKeyEvent）+ page.mouse（真实点击工具栏与大纲条目）+ page.mouse.wheel
- 焦点仿真：否（窗口本身有焦点，hasFocus=true）

## 判据（35 项，3 项变红）

| id | 判据 | 结果 | 读数 |
| --- | --- | --- | --- |
| A0 | 被测产物 sha16 与运行期一致（读数归属该产物） | 通过 | `{"sha16":"addc36f96863f29c","bytes":188784128}` |
| A1 | 长文（≥1000 行）真的载入引擎，且不是默认回退值（行数/首行/末行全对） | 通过 | `{"got":{"lines":1221,"len":35146,"first":"# 长文导航普查夹具","last":"","rendered":45,"title":"long-doc-navigation-fixture.md · 35146 字 — MarkPilot"},"want":{"lines":1221,"len":35146,"first":"# 长文导航普查夹具","last":"(空行：文件尾换行)"}}` |
| A2 | 键盘类读数前置：焦点真在编辑器里（hasFocus + activeElement 是 contentDOM） | 通过 | `{"steps":[{"step":"bringToFront+click","hasFocus":true,"viewHasFocus":true,"activeIsContent":true,"activeCls":"cm-content cm-lineWrapping"}]}` |
| A3 | 长文内容指纹与夹具一致（FNV-1a：哈希/行数/长度三项都对） | 通过 | `{"got":{"hash":2923889103,"lines":1221,"len":35146},"want":{"hash":2923889103,"lines":1221,"len":35146}}` |
| K1 | 每个按键的 keydown 都命中编辑面（target ∈ .cm-content） | 通过 | `{"miss":[]}` |
| K2 | 每个按键后焦点仍在编辑器（hasFocus + activeElement = contentDOM） | 通过 | `{"bad":[]}` |
| K3 | Ctrl+End ×5：每次都落到文末（head=len、末行） | 通过 | `{"end":[{"line":1221,"of":1221,"caretY":667.4},{"line":1221,"of":1221,"caretY":667.4},{"line":1221,"of":1221,"caretY":667.4},{"line":1221,"of":1221,"caretY":667.4},{"line":1221,"of":1221,"caretY":667.4}]}` |
| K4 | Ctrl+Home ×5：每次都回到文首（head=0、第 1 行） | 通过 | `{"home":[{"line":1,"head":0,"top":8.6},{"line":1,"head":0,"top":8.6},{"line":1,"head":0,"top":8.6},{"line":1,"head":0,"top":8.6},{"line":1,"head":0,"top":8.6}]}` |
| K5 | PageDown ×5：每次都向下推进（行号严格递增；除非已到文末） | 通过 | `{"steps":[{"from":1,"to":26,"dTop":670.3},{"from":26,"to":52,"dTop":661.7},{"from":52,"to":78,"dTop":661.7},{"from":78,"to":103,"dTop":652},{"from":103,"to":129,"dTop":656}]}` |
| K6 | PageUp ×5：每次都向上推进（行号严格递减；除非已到文首） | 通过 | `{"steps":[{"from":129,"to":103,"dTop":-656.6},{"from":103,"to":78,"dTop":-652.6},{"from":78,"to":53,"dTop":-637.1},{"from":53,"to":28,"dTop":-637.1},{"from":28,"to":3,"dTop":-650.3}]}` |
| K7 | 每个按键的 keydown 都被编辑器消费（defaultPrevented=true） | 通过 | `{"notPrevented":[]}` |
| K9 | PageDown/PageUp 竖移保住目标列（4 次翻页后列与起点一致；到文首/文末钳住不算） | **不符** | `{"down":[{"from":[1,0],"to":[26,0],"lineLen":0},{"from":[26,0],"to":[52,0],"lineLen":0},{"from":[52,0],"to":[78,0],"lineLen":0},{"from":[78,0],"to":[103,0],"lineLen":60},{"from":[103,0],"to":[129,4],"lineLen":10}],"up":[{"from":[129,4],"to":[103,60],"lineLen":60},{"from":[103,60],"to":[78,0],"lineLen":0},{"from":[78,0],"to":[53,60],"lineLen":60},{"from":[53,60],"to":[28,0],"lineLen":0},{"from":[28,0],"to":[3,38],"lineLen":38}]}` |
| C1 | 滚动位置与光标位置一致：20 次跳转后光标几何都落在滚动可视区内 | 通过 | `{"bad":[]}` |
| C2 | 尺子①（CM6 API）：block.top + documentTop 落在光标所在行的块的范围内（光标确实在自己那一行） | 通过 | `{"deltaRange":[4,6.9],"n":20}` |
| C2b | 尺子②（DOM 行矩形 vs CM6 API）：同一条可见行的屏上位置两把尺子一致（|Δ|≤2px） | 通过 | `{"maxAbs":0.5,"sample":[{"line":1194,"domTop":-18,"apiTop":-17.5,"delta":0.5},{"line":1194,"domTop":-18,"apiTop":-17.5,"delta":0.5},{"line":1194,"domTop":-18,"apiTop":-17.5,"delta":0.5}]}` |
| C3 | 第三把尺子（.cm-cursor DOM rect）与 coordsAtPos 一致（|Δ|≤2px） | 通过 | `{"bad":[]}` |
| C4 | 光标 DOM 元素（.cm-cursor）每次读数都存在 | 通过 | `{"missing":[]}` |
| C5 | 光标位置上最上层元素不是工具栏（光标不被顶部浮岛压住） | 通过 | `{"coveredCount":0,"of":20,"sample":[]}` |
| K8 | Ctrl+Home 后文档第一行（# 标题）在工具栏下方可见（不是被压在浮岛后面 / 也不是滚过头） | 通过 | `{"rows":[{"tag":"CtrlHome-1-post","firstLineTop":41.4,"barBottom":37.1,"firstVisibleLine":1,"scrollTop":8.6,"caretY":48.3},{"tag":"CtrlHome-2-post","firstLineTop":41.4,"barBottom":37.1,"firstVisibleLine":1,"scrollTop":8.6,"caretY":48.3},{"tag":"CtrlHome-3-post","firstLineTop":41.4,"barBottom":37.1,"firstVisibleLine":1,"scrollTop":8.6,"caretY":48.3},{"tag":"CtrlHome-4-post","firstLineTop":41.4,"barBottom":37.1,"firstVisibleLine":1,"scrollTop":8.6,"caretY":4` |
| M1 | 对照臂（视口中部起步）：PageDown / PageUp 都保住目标列（±1 列内）且光标停在视口中部（不被浮岛压住） | 通过 | `[{"key":"PageDown","from":{"line":14,"col":0},"to":{"line":40,"col":0,"lineLen":0},"caretY":348.8,"covered":false,"viewport":[63,2011],"targetBlockTop":1032.5},{"key":"PageUp","from":{"line":11,"col":36},"to":{"line":1,"col":0,"lineLen":10},"caretY":56.9,"covered":false,"viewport":[0,1192],"targetBlockTop":0}]` |
| O0 | 工具栏上真有「大纲」按钮（真实点击前先断言存在，不用合成 .click()） | 通过 | `{"x":148,"y":22,"w":26,"h":24,"title":"大纲"}` |
| O1 | 真实点工具栏「大纲」后浮层出现，条目数与文档标题数一致（代码块里的 # 行不算） | 通过 | `{"got":53,"want":53,"first4":["mp-outline-item h1 active\|长文导航普查夹具","mp-outline-item h2\|第1章 缘起","mp-outline-item h3\|1.1 小节","mp-outline-item h3\|1.2 小节"]}` |
| O2 | 点击大纲条目：光标落在该标题所在行（源行号逐项对上，列在行首） | 通过 | `[{"from":"docEnd","text":"长文导航普查夹具","wantLine":1,"gotLine":1,"col":0},{"from":"docEnd","text":"6.3 小节","wantLine":540,"gotLine":540,"col":0},{"from":"docStart","text":"13.3 小节","wantLine":1190,"gotLine":1190,"col":0},{"from":"stateC","text":"6.3 小节","wantLine":540,"gotLine":540,"col":0}]` |
| O3 | 点击大纲条目后光标在滚动可视区内（滚动位置跟着光标走）——本条是本族核心判据 | **不符** | `[{"from":"docEnd","text":"长文导航普查夹具","visible":false,"coordsTop":-30144.3,"scrTop":0,"scrBottom":716,"viewport":[33731,35146],"scrollTop":30201.1,"firstVisibleLine":1194,"scrollLog":[{"t":14518,"top":30201}]},{"from":"docEnd","text":"6.3 小节","visible":true,"coordsTop":119.8,"scrTop":0,"scrBottom":716,"viewport":[14077,16099],"scrollTop":13642.3,"firstVisibleLine":539,"scrollLog":[{"t":16191,"top":13642}]},{"from":"docStart","text":"13.3 小节","visible":true,"` |
| O4 | 引擎跳转算路：lineBlockAt(pos).top 与「滚动后实测」一致（目标未渲染时 coordsAtPos 为 null＝预期，改看点击后实测块顶的漂移） | 通过 | `[{"from":"docEnd","line":1,"coordsAtPos为null":true,"lineBlockAtTop":0,"trueTop":null,"delta":null,"engineTarget":0,"correctTarget":null,"scrollTop":30201.1,"viewport":[33731,35146],"点击后实测块顶":0,"估算漂移":0},{"from":"docEnd","line":540,"coordsAtPos为null":true,"lineBlockAtTop":13648.1,"trueTop":null,"delta":null,"engineTarget":13600.1,"correctTarget":null,"scrollTop":30201.1,"viewport":[33731,35146],"点击后实测块顶":13706.3,"估算漂移":58.2},{"from":"docStart","line":1190,"` |
| O5 | 点击大纲条目后**焦点仍在编辑器**（document.hasFocus() 且 activeElement 在编辑面内） | 通过 | `[{"from":"docEnd","hasFocus":true,"cls":"cm-content cm-lineWrapping","inOutline":false},{"from":"docEnd","hasFocus":true,"cls":"cm-content cm-lineWrapping","inOutline":false},{"from":"docStart","hasFocus":true,"cls":"cm-content cm-lineWrapping","inOutline":false},{"from":"stateC","hasFocus":true,"cls":"cm-content cm-lineWrapping","inOutline":false}]` |
| O6 | 点击大纲条目后按键仍进编辑器（真实 ArrowRight 使光标动） | 通过 | `[{"from":"docEnd","colBefore":0,"colAfter":1,"inContent":true},{"from":"docEnd","colBefore":0,"colAfter":1,"inContent":true},{"from":"docStart","colBefore":0,"colAfter":1,"inContent":true},{"from":"stateC","colBefore":0,"colAfter":1,"inContent":true}]` |
| O7 | 点击后该条目被标成 active（面板与光标同步） | 通过 | `[{"from":"docEnd","clicked":"长文导航普查夹具","active":"长文导航普查夹具"},{"from":"docEnd","clicked":"6.3 小节","active":"6.3 小节"},{"from":"docStart","clicked":"13.3 小节","active":"13.3 小节"},{"from":"stateC","clicked":"6.3 小节","active":"6.3 小节"}]` |
| O8 | 点击大纲条目期间文档没被改动 | 通过 | `[{"from":"docEnd","len":35146},{"from":"docEnd","len":35146},{"from":"docStart","len":35146},{"from":"stateC","len":35146}]` |
| O9 | 大纲点第一条（回文首）：文档第一行在工具栏下方可见（与 Ctrl+Home 对照） | **不符** | `{"firstLineTop":-30151.1,"barBottom":37.1,"firstVisibleLine":1194,"scrollTop":30201.1,"covered":false,"expectScrollTop":0}` |
| O10 | 再点工具栏「大纲」关闭面板：浮层消失 + 焦点仍在编辑器 | 通过 | `{"beforeOpen":true,"afterOpen":false,"hasFocus":true,"cls":"cm-content cm-lineWrapping"}` |
| O11 | 停靠态大纲（靠右停靠）：条目点击同样「滚到目标 + 光标落标题 + 焦点在编辑器」 | 通过 | `{"dock":{"kind":"mp-outline-dock","count":53,"panel":{"x":936,"y":40,"w":232,"h":668,"scrollTop":11,"scrollHeight":1448,"clientHeight":667}},"click":{"text":"8.1 小节","wantLine":664,"gotLine":664,"col":0,"visible":true,"hasFocus":true,"activeIsContent":true,"keyReached":true,"scrollTop":16791.4,"covered":false},"radio":{"x":641,"y":558,"t":550,"b":565,"w":76,"checked":false,"onScreen":true},"radioScroll":{"steps":2,"first":{"x":641,"y":798,"t":790,"b":805,"` |
| Z1 | 整轮普查后文档内容未被改动（指纹与基线一致） | 通过 | `{"hashNow":2923889103,"hashBase":2923889103,"lenNow":35146,"lenBase":35146}` |
| Z2 | 无 pageerror / console.error | 通过 | `[]` |
| Z3 | 主进程事实：跑完时进程仍活着（不是渲染侧超时反推） | 通过 | `{"pid":107928,"aliveBeforeKill":true,"tasklist":"\"MarkPilot.exe\",\"107928\",\"Console\",\"1\",\"106,784 K\""}` |

## 键盘组逐次读数

| 组 | 次 | 行 | 列 | 滚动 top | 光标屏上 y | 命中元素 | 被浮岛压住 | 首可见行 | 焦点 | keydown 进编辑面/被消费 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ctrl+End | 1 | 5→1221 | 9→0 | 0→30158.3 | 667.4 | cm-line cm-activeLine | false | 1194 | true/true | true/true |
| Ctrl+End | 2 | 1221→1221 | 0→0 | 30158.3→30158.3 | 667.4 | cm-line cm-activeLine | false | 1194 | true/true | true/true |
| Ctrl+End | 3 | 1221→1221 | 0→0 | 30158.3→30158.3 | 667.4 | cm-line cm-activeLine | false | 1194 | true/true | true/true |
| Ctrl+End | 4 | 1221→1221 | 0→0 | 30158.3→30158.3 | 667.4 | cm-line cm-activeLine | false | 1194 | true/true | true/true |
| Ctrl+End | 5 | 1221→1221 | 0→0 | 30158.3→30158.3 | 667.4 | cm-line cm-activeLine | false | 1194 | true/true | true/true |
| Ctrl+Home | 1 | 1221→1 | 0→0 | 30158.3→8.6 | 48.3 | ͼv | false | 1 | true/true | true/true |
| Ctrl+Home | 2 | 1→1 | 0→0 | 8.6→8.6 | 48.3 | ͼv | false | 1 | true/true | true/true |
| Ctrl+Home | 3 | 1→1 | 0→0 | 8.6→8.6 | 48.3 | ͼv | false | 1 | true/true | true/true |
| Ctrl+Home | 4 | 1→1 | 0→0 | 8.6→8.6 | 48.3 | ͼv | false | 1 | true/true | true/true |
| Ctrl+Home | 5 | 1→1 | 0→0 | 8.6→8.6 | 48.3 | ͼv | false | 1 | true/true | true/true |
| PageDown | 1 | 1→26 | 0→0 | 8.6→678.9 | 48.7 | cm-line cm-activeLine | false | 24 | true/true | true/true |
| PageDown | 2 | 26→52 | 0→0 | 678.9→1340.6 | 48.8 | cm-line cm-activeLine | false | 50 | true/true | true/true |
| PageDown | 3 | 52→78 | 0→0 | 1340.6→2002.3 | 49 | cm-line cm-activeLine | false | 76 | true/true | true/true |
| PageDown | 4 | 78→103 | 0→0 | 2002.3→2654.3 | 49.1 | cm-line cm-activeLine | false | 101 | true/true | true/true |
| PageDown | 5 | 103→129 | 0→4 | 2654.3→3310.3 | 49.4 | cm-line cm-activeLine mp-h3 | false | 127 | true/true | true/true |
| PageUp | 1 | 129→103 | 4→60 | 3310.3→2653.7 | 49.7 | cm-line cm-activeLine | false | 101 | true/true | true/true |
| PageUp | 2 | 103→78 | 60→0 | 2653.7→2001.1 | 50.2 | cm-line cm-activeLine | false | 76 | true/true | true/true |
| PageUp | 3 | 78→53 | 0→60 | 2001.1→1364 | 50.6 | cm-line cm-activeLine | false | 51 | true/true | true/true |
| PageUp | 4 | 53→28 | 60→0 | 1364→726.9 | 51 | cm-line cm-activeLine | false | 26 | true/true | true/true |
| PageUp | 5 | 28→3 | 0→38 | 726.9→76.6 | 51.2 | cm-line cm-activeLine mp-quote mp-quote-d1 | false | 1 | true/true | true/true |

## 对照臂（视口中部起步）

- PageDown：行 14 列 0 → 行 40 列 0（行宽 0）；光标 y 348.6→348.8（被浮岛压住 false）
- PageUp：行 11 列 36 → 行 1 列 0（行宽 10）；光标 y 349.6→56.9（被浮岛压住 false）

## 大纲跳转（四个状态）

### docEnd → #0

- 跳转算路复刻：lineBlockAt.top=0，coordsAtPos 反推的真实 top=null（差 null）；引擎算出的滚动目标=0，正确目标=null；实际 scrollTop=30201.1（渲染视口 [33731,35146]）
- 点击「长文导航普查夹具」→ 期望第 1 行 / 实到第 1 行（列 0）；scrollTop=30201.1（max 30201）；**光标在可视区=false**（coordsTop=-30144.3，滚动区 0~716，首可见行=1194）；焦点 hasFocus=true activeElement=cm-content cm-lineWrapping 在编辑面=true；active 项=「长文导航普查夹具」；按键右移 0→1；滚动事件轨迹=[{"t":14518,"top":30201}]
### docEnd → #24（第 540 行）

- 跳转算路复刻：lineBlockAt.top=13648.1，coordsAtPos 反推的真实 top=null（差 null）；引擎算出的滚动目标=13600.1，正确目标=null；实际 scrollTop=30201.1（渲染视口 [33731,35146]）
- 点击「6.3 小节」→ 期望第 540 行 / 实到第 540 行（列 0）；scrollTop=13642.3（max 30266）；**光标在可视区=true**（coordsTop=119.8，滚动区 0~716，首可见行=539）；焦点 hasFocus=true activeElement=cm-content cm-lineWrapping 在编辑面=true；active 项=「6.3 小节」；按键右移 0→1；滚动事件轨迹=[{"t":16191,"top":13642}]
### docStart → #52（第 1190 行）

- 跳转算路复刻：lineBlockAt.top=30090.8，coordsAtPos 反推的真实 top=null（差 null）；引擎算出的滚动目标=30042.8，正确目标=null；实际 scrollTop=8.6（渲染视口 [0,1254]）
- 点击「13.3 小节」→ 期望第 1190 行 / 实到第 1190 行（列 0）；scrollTop=30044.6（max 30266）；**光标在可视区=true**（coordsTop=102，滚动区 0~716，首可见行=1186）；焦点 hasFocus=true activeElement=cm-content cm-lineWrapping 在编辑面=true；active 项=「13.3 小节」；按键右移 0→1；滚动事件轨迹=[{"t":18675,"top":30045}]
### stateC → #24（第 540 行）

- 跳转算路复刻：lineBlockAt.top=13706.3，coordsAtPos 反推的真实 top=null（差 null）；引擎算出的滚动目标=13658.3，正确目标=null；实际 scrollTop=30044.6（渲染视口 [33479,35146]）
- 点击「6.3 小节」→ 期望第 540 行 / 实到第 540 行（列 0）；scrollTop=13660（max 30266）；**光标在可视区=true**（coordsTop=102，滚动区 0~716，首可见行=539）；焦点 hasFocus=true activeElement=cm-content cm-lineWrapping 在编辑面=true；active 项=「6.3 小节」；按键右移 0→1；滚动事件轨迹=[{"t":20084,"top":13660}]

## 停靠态大纲

```json
{
 "steps": [
  {
   "step": "开浮层",
   "s": {
    "ls": null,
    "ds": "",
    "dlg": false,
    "pop": false,
    "floatEl": true,
    "dockEl": false,
    "hostFlex": false,
    "items": 53
   }
  },
  {
   "step": "开设置",
   "s": {
    "ls": null,
    "ds": "",
    "dlg": true,
    "pop": false,
    "floatEl": true,
    "dockEl": false,
    "hostFlex": false,
    "items": 53
   }
  },
  {
   "step": "选靠右停靠",
   "s": {
    "ls": "right",
    "ds": "right",
    "dlg": true,
    "pop": false,
    "floatEl": false,
    "dockEl": false,
    "hostFlex": false,
    "items": 0
   }
  },
  {
   "step": "关设置",
   "s": {
    "ls": "right",
    "ds": "right",
    "dlg": false,
    "pop": false,
    "floatEl": false,
    "dockEl": false,
    "hostFlex": false,
    "items": 0
   }
  },
  {
   "step": "开大纲(停靠态)",
   "s": {
    "ls": "right",
    "ds": "right",
    "dlg": false,
    "pop": false,
    "floatEl": false,
    "dockEl": true,
    "hostFlex": true,
    "items": 53
   }
  }
 ],
 "moreBtn": {
  "x": 1001,
  "y": 22
 },
 "popItems": [
  "导出…PDF / HTM",
  "设置",
  "重新加载从磁盘重读当前文",
  "从浏览器打开…按网址取图",
  "内联全部图片本地路径 →",
  "抽出到 assetsda",
  "整体不透明度65%",
  "%",
  "跟随主题当前",
  "米色纸张",
  "柔和淡绿",
  "进入阅读模式阅读态会隐藏",
  "帮助",
  "关于"
 ],
 "dlgBox": {
  "x": 588,
  "y": 358,
  "t": 69,
  "b": 647,
  "h": 577,
  "vh": 716
 },
 "radio": {
  "x": 641,
  "y": 558,
  "t": 550,
  "b": 565,
  "w": 76,
  "checked": false,
  "onScreen": true
 },
 "radioScroll": {
  "steps": 2,
  "first": {
   "x": 641,
   "y": 798,
   "t": 790,
   "b": 805,
   "w": 76,
   "checked": false,
   "onScreen": false
  },
  "last": {
   "x": 641,
   "y": 558,
   "t": 550,
   "b": 565,
   "w": 76,
   "checked": false,
   "onScreen": true
  }
 },
 "closeBtn": true,
 "dock": {
  "kind": "mp-outline-dock",
  "count": 53,
  "panel": {
   "x": 936,
   "y": 40,
   "w": 232,
   "h": 668,
   "scrollTop": 11,
   "scrollHeight": 1448,
   "clientHeight": 667
  }
 },
 "click": {
  "text": "8.1 小节",
  "wantLine": 664,
  "gotLine": 664,
  "col": 0,
  "visible": true,
  "hasFocus": true,
  "activeIsContent": true,
  "keyReached": true,
  "scrollTop": 16791.4,
  "covered": false
 }
}
```

## 崩溃 / pageerror

- 无

## 未反应 / 不符预期

- **K9** PageDown/PageUp 竖移保住目标列（4 次翻页后列与起点一致；到文首/文末钳住不算） :: `{"down":[{"from":[1,0],"to":[26,0],"lineLen":0},{"from":[26,0],"to":[52,0],"lineLen":0},{"from":[52,0],"to":[78,0],"lineLen":0},{"from":[78,0],"to":[103,0],"lineLen":60},{"from":[103,0],"to":[129,4],"lineLen":10}],"up":[{"from":[129,4],"to":[103,60],"lineLen":60},{"from":[103,60],"to":[78,0],"lineLen":0},{"from":[78,0],"to":[53,60],"lineL`
- **O3** 点击大纲条目后光标在滚动可视区内（滚动位置跟着光标走）——本条是本族核心判据 :: `[{"from":"docEnd","text":"长文导航普查夹具","visible":false,"coordsTop":-30144.3,"scrTop":0,"scrBottom":716,"viewport":[33731,35146],"scrollTop":30201.1,"firstVisibleLine":1194,"scrollLog":[{"t":14518,"top":30201}]},{"from":"docEnd","text":"6.3 小节","visible":true,"coordsTop":119.8,"scrTop":0,"scrBottom":716,"viewport":[14077,16099],"scrollTop":13`
- **O9** 大纲点第一条（回文首）：文档第一行在工具栏下方可见（与 Ctrl+Home 对照） :: `{"firstLineTop":-30151.1,"barBottom":37.1,"firstVisibleLine":1194,"scrollTop":30201.1,"covered":false,"expectScrollTop":0}`

## 证据文件

- 结果 JSON：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-result.json`
- 截图 01-ctrl-end-5：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\01-ctrl-end-5.png`
- 截图 02-ctrl-home-5：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\02-ctrl-home-5.png`
- 截图 03-pagedown-5：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\03-pagedown-5.png`
- 截图 04-pageup-5：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\04-pageup-5.png`
- 截图 05-pdmid-after：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\05-pdmid-after.png`
- 截图 06-pumid-after：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\06-pumid-after.png`
- 截图 07-outline-open：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\07-outline-open.png`
- 截图 08-outline-A-first-from-end：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\08-outline-A-first-from-end.png`
- 截图 09-outline-B-mid-from-end：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\09-outline-B-mid-from-end.png`
- 截图 10-outline-C-last-from-start：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\10-outline-C-last-from-start.png`
- 截图 11-outline-D-mid-near：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\11-outline-D-mid-near.png`
- 截图 12-outline-closed：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\12-outline-closed.png`
- 截图 13-outline-dock-open：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\13-outline-dock-open.png`
- 截图 14-outline-dock-click：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-shots\14-outline-dock-click.png`
- 壳层 trace：`E:\MarkPilot\.mp-verify\checklist\long-doc-navigation-run\profile\main-debug.log`（8445 字节，error 行 0）

## 备注

- 无