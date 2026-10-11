# outline-modes 普查报告（大纲三形态：浮层 / 左停靠 / 右停靠）

- 时间：2026-10-10T03:08:20.950Z
- 被测产物：`E:\MarkPilot\MarkPilot-CM6\dist\win-unpacked\MarkPilot.exe` sha16=`15b8a1b699a0782e` bytes=188784128
- 夹具：`E:\MarkPilot\.mp-verify\checklist\outline-modes-run\outline-modes-fixture.md` 行数=690 标题数=51 sha16=59887a49a49b3bea
- 尺子：真实键鼠（CDP Input.*）/ 真实滚轮 / 窄窗尺子=window.resizeTo(真实窗口) / 一次 evaluate 拿全一组读数

## 判据

| id | 判据 | 结果 | 关键读数 |
|---|---|---|---|
| A0 | 被测产物 sha16 与运行期一致（读数只属于这一份包） | 通过 | `{"sha16":"15b8a1b699a0782e","bytes":188784128}` |
| A1 | 长文真的载入引擎（行数/首行/空尾行逐项对上，不是默认空文档） | 通过 | `{"got":{"lines":690,"len":14189,"first":"# 大纲形态普查夹具","last":"","rendered":31,"mode":"float"},"want":{"lines":690,"first":"# 大纲形态普查夹具","last":"(空行)","mode":"float(默认)"}}` |
| A2 | 键盘/点击读数前置：焦点真在编辑器里（document.hasFocus() 且 activeElement 是 contentDOM） | 通过 | `{"steps":[{"step":"bringToFront+click","box":{"x":688,"y":7355},"hasFocus":true,"activeIsContent":true,"activeCls":"cm-content cm-lineWrapping"}]}` |
| T1 | 工具栏「大纲」按钮真实存在且命中测试可点（不是合成 .click()） | 通过 | `{"x":148,"y":22,"w":26,"h":24,"t":10,"b":34,"inViewport":true,"hittable":true,"hitCls":"[object SVGAnimatedString]","title":"大纲"}` |
| F1 | 浮层态：真实点工具栏「大纲」后面板出现，条目数=文档标题数、首条就是第一个标题（不是空面板回退） | 通过 | `{"kind":"float","count":51,"rect":{"l":135,"t":44,"r":408,"b":505,"w":273,"h":461},"scrollHeight":1383,"clientHeight":460,"first3":["大纲形态普查夹具","第1章 缘起","1.1 小节"]}` |
| F2 | 浮层「面板不遮正文」读数：面板与正文列的**重叠面积**（如实记录事实，浮层＝overlay 设计） | 通过 | `{"panelRect":[135,44,408.1,505.1,273.1,461.1],"contentRect":[148.1,16,1018.1,17489.4,870],"editorRect":[0,0,1176,716,1176],"docHash":2816633660,"len":14189,"overlapContentArea":119876.3,"overlapVisibleArea":119876.3,"overlapVisibleFrac":0.2,"visibleContentRect":[148.1,16,1018.1,716],"panelCount":51,` |
| F3 | 浮层：文末→点第2条（远距向上）——光标落该标题行首、目标行在可视区、焦点仍在编辑器、文档未变 | 通过 | `{"want":{"line":5,"text":"第1章 缘起"},"got":{"line":5,"col":0,"text":"## 第1章 缘起"},"targetVisible":true,"scrollTop":75.4,"focus":{"hasFocus":true,"activeIsContent":true,"activeCls":"cm-content cm-lineWrapping","viewHasFocus":true},"docLen":14189,"clickTrace":[{"attempt":0,"panelScrollTop":0,"itemTop":79` |
| F4 | 浮层：跳转成功后**目标标题的文字是否被浮层压住**（按文字实际范围量，不是行盒；判据＝文字零遮挡） | **不符** | `{"firstCharCoveredByPanel":true,"firstCharHitCls":"mp-outline-item h3","textRect":[172.1,102.5,155.6,27.4],"lineRect":[172.1,96.2,822,40.6],"textCoveredFrac":1,"textCoveredArea":4267.1,"panelRect":[135,44,408.1,505.1,273.1,461.1]}` |
| F5 | 浮层：跳转后当前项高亮=被点条目，且该高亮项是否进入面板可视区（面板会不会自己滚） | 通过 | `{"clicked":"第1章 缘起","activeText":"第1章 缘起","activeIdx":1,"activeVisibleInPanel":true,"panelScrollTop":0,"panelClientHeight":460,"activeRect":[141.6,79.4,250.3,26.8],"panelRect":[135,44,408.1,505.1,273.1,461.1]}` |
| F6 | 浮层：文首→点倒数第2条（远距向下，条目先靠真实滚轮滚进面板）——光标落标题、目标进可视区、文档未变 | 通过 | `{"want":{"line":653,"text":"12.2 小节"},"got":{"line":653,"col":0},"targetVisible":true,"clickTrace":[{"attempt":1,"panelScrollTop":260,"itemTop":1106,"itemBottom":1132,"fullyVisible":false,"hitIdx":-1,"hitCls":null},{"attempt":2,"panelScrollTop":520,"itemTop":846,"itemBottom":872,"fullyVisible":false` |
| F7 | 浮层：远距向下跳转后**当前项是否落在面板可视区内**（长文档 51 条，面板只有 ~62vh） | 通过 | `{"activeVisibleInPanel":true,"activeRect":[141.6,443.2,250.3,26.8],"panelRect":[135,44,408.1,505.1,273.1,461.1],"panelScrollTop":922.3}` |
| F8 | 浮层：光标移到**另一条**标题后，面板当前项高亮是否跟着变（真实鼠标点正文标题；先断言本次移动确实换了标题，否则无鉴别力） | **不符** | `{"label":"float-follow","pick":{"line":671,"x":624,"y":573,"text":"### 12.3 小节","idx":50,"rect":[172,557,822,32],"visibleHeadings":[{"n":653,"idx":49,"text":"### 12.2 小节"},{"n":671,"idx":50,"text":"### 12.3 小节"}]},"activeIdxBefore":49,"activeTextBefore":"12.2 小节","clickHitCls":"cm-line cm-activeLine` |
| F8b | 浮层：用**真实键盘**（Ctrl+Home，键日志证明确实进了编辑面）把光标挪到文首标题，面板高亮是否跟随（第二条通道） | **不符** | `{"cursorLine":1,"cursorText":"# 大纲形态普查夹具","expectIdx":0,"activeIdx":49,"activeText":"12.2 小节","panelOpen":true,"lastKey":null}` |
| F10a | 浮层：光标放文末（Ctrl+End）再打开面板——当前项高亮指向光标所在标题（不是停在第一条） | 通过 | `{"label":"float","cursor":{"lineNo":690,"lines":690,"text":""},"btnHittable":true,"expectIdx":50,"kind":"float","count":51,"activeIdx":50,"activeText":"12.3 小节","activeVisibleInPanel":false,"activeRect":[141.6,1392.3,250.3,26.8],"panelScrollTop":0,"panelClientHeight":460,"panelRect":[135,44,408.1,50` |
| F10b | 浮层：上面这一刻，当前项是否在面板可视区内（51 条、面板 ~62vh ⇒ 面板要不要自己滚） | **不符** | `{"activeIdx":50,"activeVisibleInPanel":false,"panelScrollTop":0,"panelClientHeight":460,"activeRect":[141.6,1392.3,250.3,26.8],"panelRect":[135,44,408.1,505.1,273.1,461.1]}` |
| F9 | 浮层：再点一次工具栏「大纲」收起面板，焦点回到编辑器、正文未动 | 通过 | `{"btn":{"x":148,"y":22,"w":26,"h":24,"t":10,"b":34,"inViewport":true,"hittable":true,"hitCls":"[object SVGAnimatedString]","title":"大纲"},"panelGone":true,"focus":{"hasFocus":true,"activeIsContent":true,"activeCls":"cm-content cm-lineWrapping","viewHasFocus":true}}` |
| L1 | 设置里选「靠左停靠」：模式落盘为 left、html[data-mp-dock]=left、浮层被收起（换壳） | 通过 | `{"after":{"mode":"left","checked":true,"dataDock":"left","floatEl":false,"dockEl":false,"hostFlex":false},"final":{"dlgOpen":false,"mode":"left","dataDock":"left"},"radio":{"step":"单选就位","radio":{"x":550,"y":538,"t":530,"b":545,"w":76,"checked":false,"onScreen":true,"hittable":true},"scrollSteps":2}` |
| L2 | 左停靠：面板是 .mp-outline-dock(side=left)、在 DOM 里位于 .cm-editor **之前**、宽度≈232px、与正文列**零重叠**（结构让位而非覆盖） | 通过 | `{"btn":{"x":148,"y":22,"w":26,"h":24,"t":10,"b":34,"inViewport":true,"hittable":true,"hitCls":"[object SVGAnimatedString]","title":"大纲"},"panel":{"kind":"dock","side":"left","rect":[8,40,240,708,232,668],"count":51},"editorRect":[248,0,1176,716,928],"contentRect":[272.1,-16824,1142.1,692,870],"dockD` |
| L3 | 左停靠：文末→点第2条——光标落该标题行首、目标行在可视区且**未被面板压住**、焦点在编辑器、文档未变 | 通过 | `{"want":{"line":5,"text":"第1章 缘起"},"got":{"line":5,"col":0},"target":{"visible":true,"covered":false,"overlap":0,"rect":[296.1,96.2,822,40.6]},"focus":{"hasFocus":true,"activeIsContent":true,"activeCls":"cm-content cm-lineWrapping","viewHasFocus":true},"ERR":null,"clickTrace":[{"attempt":0,"panelScr` |
| L4 | 左停靠：跳转后当前项高亮=被点条目，并自动滚进面板可视区（markActiveDock 的 scrollIntoView） | 通过 | `{"clicked":"第1章 缘起","activeText":"第1章 缘起","activeIdx":1,"activeVisibleInPanel":true,"panelScrollTop":0,"activeRect":[14.6,75.4,209.1,26.8],"panelRect":[8,40,240,708,232,668]}` |
| L5 | 左停靠：光标移到**另一条**标题后，面板当前项高亮是否跟随（真实鼠标点正文标题；含鉴别力断言） | **不符** | `{"label":"dock-left-follow","pick":{"line":7,"x":748,"y":178,"text":"### 1.1 小节","idx":2,"rect":[296,162,822,32],"visibleHeadings":[{"n":5,"idx":1,"text":"## 第1章 缘起"},{"n":7,"idx":2,"text":"### 1.1 小节"}]},"activeIdxBefore":1,"activeTextBefore":"第1章 缘起","clickHitCls":"cm-line cm-activeLine mp-h3","cu` |
| L6 | 左停靠：光标放文末再打开面板——高亮指向文末标题，且该条目被面板自己滚进可视区（markActiveDock 的 scrollIntoView） | 通过 | `{"label":"dock-left","cursor":{"lineNo":690,"lines":690,"text":""},"btnHittable":true,"expectIdx":50,"kind":"dock","count":51,"activeIdx":50,"activeText":"12.3 小节","activeVisibleInPanel":true,"activeRect":[14.6,680.9,209.1,26.8],"panelScrollTop":707.4,"panelClientHeight":667,"panelRect":[8,40,240,70` |
| R1 | 设置里选「靠右停靠」：模式落盘 right、data-mp-dock=right；切换时上一次的停靠列被摘掉（换边） | 通过 | `{"after":{"mode":"right","checked":true,"dataDock":"right","floatEl":false,"dockEl":false,"hostFlex":false},"final":{"dlgOpen":false,"mode":"right","dataDock":"right"}}` |
| R2 | 右停靠：面板在 .cm-editor **之后**、宽度≈232px、与正文列零重叠、编辑器右缘相对浮层态左移 | 通过 | `{"btn":{"x":148,"y":22,"w":26,"h":24,"t":10,"b":34,"inViewport":true,"hittable":true,"hitCls":"[object SVGAnimatedString]","title":"大纲"},"panel":{"kind":"dock","side":"right","rect":[936,40,1168,708,232,668],"count":51},"editorRect":[0,0,928,716,928],"contentRect":[24.1,-16824,894.1,692,870],"dockDo` |
| R3 | 右停靠：文首→点倒数第2条（远距向下，条目先滚进面板）——光标落标题、目标在可视区且未被压住、焦点在编辑器 | 通过 | `{"want":{"line":653,"text":"12.2 小节"},"got":{"line":653,"col":0},"target":{"visible":true,"covered":false,"overlap":0},"focus":{"hasFocus":true,"activeIsContent":true,"activeCls":"cm-content cm-lineWrapping","viewHasFocus":true},"ERR":null,"clickTrace":[{"attempt":0,"panelScrollTop":707,"itemTop":65` |
| R4 | 右停靠：跳转后当前项高亮=被点条目，并在面板可视区内 | 通过 | `{"clicked":"12.2 小节","activeText":"12.2 小节","activeVisibleInPanel":true,"panelScrollTop":707.4}` |
| R5 | 右停靠：光标移到**另一条**标题后，面板当前项高亮是否跟随（真实鼠标点正文标题；含鉴别力断言） | **不符** | `{"label":"dock-right-follow","pick":{"line":671,"x":500,"y":573,"text":"### 12.3 小节","idx":50,"rect":[48,557,822,32],"visibleHeadings":[{"n":653,"idx":49,"text":"### 12.2 小节"},{"n":671,"idx":50,"text":"### 12.3 小节"}]},"activeIdxBefore":49,"activeTextBefore":"12.2 小节","clickHitCls":"cm-line cm-active` |
| R6 | 右停靠：光标放文末再打开面板——高亮指向文末标题且自动进面板可视区 | 通过 | `{"label":"dock-right","cursor":{"lineNo":690,"lines":690,"text":""},"btnHittable":true,"expectIdx":50,"kind":"dock","count":51,"activeIdx":50,"activeText":"12.3 小节","activeVisibleInPanel":true,"activeRect":[942.6,680.9,209.1,26.8],"panelScrollTop":707.4,"panelClientHeight":667,"panelRect":[936,40,11` |
| Z1 | 真实 Ctrl+= ×10 生效（内容缩放 100%→150%，读三处：API / computed zoom / localStorage，均非默认值） | 通过 | `{"before":{"pref":100,"computed":"1"},"after":{"pref":150,"computed":"1.5","ls":"150"}}` |
| Z2 | 缩放 150% + 右停靠：条目点击仍滚到目标（光标落标题、目标在可视区且零重叠、焦点在编辑器） | 通过 | `{"want":{"line":5},"got":{"line":5,"col":0},"zoom":{"pref":150,"computed":"1.5"},"target":{"visible":true,"covered":false},"panel":{"rect":[936,40,1168,708,232,668],"overlapContent":0,"overlapEditor":0,"insideViewport":true},"editorRect":[0,0,928,716,928],"contentRect":[21.6,-180.6,891.6,27369.4,870` |
| Z3 | 真实 Ctrl+0 把缩放还原到 100%（不是停在 150%） | 通过 | `{"pref":100,"computed":"1"}` |
| N1 | 窄窗 660px（右停靠）：停靠列与正文列都还有宽度、零重叠、面板在视口内、工具栏「大纲」按钮仍可点 | 通过 | `{"how":"window.resizeTo(真实窗口)","vp":[660,713,1.75],"resizeToGot":[660,713,1.75],"resizeToReq":[673,962],"panel":{"kind":"dock","side":"right","rect":[420,65,652,705.1,232,640.1],"insideViewport":true,"overlapContentArea":0,"overlapEditorArea":0},"editorWidth":412,"contentWidth":402.3,"scrollerOverfl` |
| N2 | 窄窗 660px（右停靠）：条目点击仍滚到目标，且目标标题不被停靠列/浮层压住 | 通过 | `{"want":{"line":5},"got":{"line":5,"col":0},"target":{"visible":true,"covered":false,"rect":[24,146.2,354.3,40.6]},"panelRect":[420,65,652,705.1,232,640.1],"ERR":null}` |
| N3 | 窄窗 660px 下仍能用「更多→设置」把形态换回浮层（对话框可滚、单选可点） | 通过 | `{"after":{"mode":"float","checked":true,"dataDock":"","floatEl":false,"dockEl":false,"hostFlex":false},"final":{"dlgOpen":false,"mode":"float","dataDock":""}}` |
| N4 | 窄窗 660px（浮层）：面板整体在视口内、仍与正文列重叠（overlay 设计）——如实读数，并给出占正文面积比 | 通过 | `{"btn":{"x":39,"y":22,"w":26,"h":24,"t":10,"b":34,"inViewport":true,"hittable":true,"hitCls":"[object SVGAnimatedString]","title":"大纲"},"panel":{"kind":"float","rect":[26,44,299.1,503.3,273.1,459.3],"insideViewport":true,"overlapContentArea":100124.3,"overlapContentFrac":0,"overlapVisibleArea":10012` |
| N5 | 窄窗 660px（浮层）：条目点击后**目标标题文字是否被浮层压住**（窄窗下浮层占正文的比例更大） | **不符** | `{"want":{"line":5},"got":{"line":5},"cursorLanded":true,"firstCharCovered":true,"firstCharHitCls":"mp-outline-item h3","textRect":[105.1,152.4,155.6,27.4],"textCoveredFrac":1,"textCoveredArea":4267.1,"panelRect":[26,44,299.1,503.3,273.1,459.3],"targetLineRect":[105.1,146.2,440,40.6],"ERR":null}` |
| Z4 | 缩放 150% + 浮层：面板仍在视口内且能被真实鼠标点中（跳转前先断言按钮/条目命中测试通过） | 通过 | `{"btn":{"x":143,"y":22,"w":26,"h":24,"t":10,"b":34,"inViewport":true,"hittable":true,"hitCls":"[object SVGAnimatedString]","title":"大纲"},"zoom":{"pref":150,"computed":"1.5"},"panel":{"kind":"float","rect":[130.1,44,403.3,503.3,273.1,459.3],"insideViewport":true,"overlapVisible":118873,"overlapVisibl` |
| Z5 | 缩放 150% + 浮层：条目点击仍滚到目标（光标落标题行首），并记录文字遮挡读数的变化 | 通过 | `{"want":{"line":5},"got":{"line":5,"col":0},"zoom":{"pref":150,"computed":"1.5"},"target":{"visible":true,"textCoveredFrac":1,"textRect":[180.5,62.3,233.4,41.1],"firstCharCovered":true},"panel":{"rect":[130.1,44,403.3,503.3,273.1,459.3],"scrollTop":0},"ERR":null}` |
| Z9 | 整轮操作后文档内容零改动（指纹与基线一致；基线＝浮层臂首帧那次读数） | 通过 | `{"now":2816633660,"base":2816633660,"lenNow":14189,"lenBase":14189,"lenWant":14189}` |
| Z10 | 无 pageerror / console.error | 通过 | `[]` |
| Z11 | 主进程事实：跑完时进程仍活着（tasklist，不用渲染侧超时反推） | 通过 | `{"pid":77512,"aliveAtEnd":true}` |

## 观测（三形态逐项）

```json
{
 "floatOpen": {
  "btn": {
   "x": 148,
   "y": 22,
   "w": 26,
   "h": 24,
   "t": 10,
   "b": 34,
   "inViewport": true,
   "hittable": true,
   "hitCls": "[object SVGAnimatedString]",
   "title": "大纲"
  },
  "panel": {
   "kind": "float",
   "count": 51,
   "rect": {
    "l": 135,
    "t": 44,
    "r": 408,
    "b": 505,
    "w": 273,
    "h": 461
   },
   "scrollHeight": 1383,
   "clientHeight": 460,
   "first3": [
    "大纲形态普查夹具",
    "第1章 缘起",
    "1.1 小节"
   ]
  }
 },
 "floatBase": {
  "panelRect": [
   135,
   44,
   408.1,
   505.1,
   273.1,
   461.1
  ],
  "contentRect": [
   148.1,
   16,
   1018.1,
   17489.4,
   870
  ],
  "editorRect": [
   0,
   0,
   1176,
   716,
   1176
  ],
  "docHash": 2816633660,
  "len": 14189,
  "overlapContentArea": 119876.3,
  "overlapVisibleArea": 119876.3,
  "overlapVisibleFrac": 0.2,
  "visibleContentRect": [
   148.1,
   16,
   1018.1,
   716
  ],
  "panelCount": 51,
  "panelScrollable": false
 },
 "floatJumpUp": {
  "click": {
   "k": 1,
   "label": "float-up",
   "clicked": {
    "text": "第1章 缘起",
    "i": 1
   },
   "trace": [
    {
     "attempt": 0,
     "panelScrollTop": 0,
     "itemTop": 79,
     "itemBottom": 106,
     "fullyVisible": true,
     "hitIdx": 1,
     "hitCls": "mp-outline-item h2"
    }
   ]
  },
  "after": {
   "tag": "floatUp-after",
   "docHash": 2816633660,
   "cursor": {
    "head": 58,
    "lineNo": 5,
    "col": 0,
    "lineText": "## 第1章 缘起"
   },
   "scrollTop": 75.4,
   "len": 14189,
   "panel": {
    "kind": "float",
    "side": null,
    "rect": [
     135,
     44,
     408.1,
     505.1,
     273.1,
     461.1
    ],
    "activeIdx": 1,
    "activeText": "第1章 缘起",
    "activeVisibleInPanel": true,
    "scrollTop": 0,
    "count": 51,
    "overlapContentArea": 119876.3,
    "overlapVisibleArea": 119876.3,
    "overlapVisibleFrac": 0.2,
    "insideViewport": true
   },
   "target": {
    "line": 5,
    "text": "## 第1章 缘起",
    "rect": [
     172.1,
     96.2,
     822,
     40.6
    ],
    "textRect": [
     172.1,
     102.5,
     155.6,
     27.4
    ],
    "textCoveredArea": 4267.1,
    "textCoveredFrac": 1,
    "firstCharPoint": [
     175,
     116
    ],
    "firstCharHitCls": "mp-outline-item h3",
    "firstCharCoveredByPanel": true,
    "panelOverlapArea": 9574.9,
    "panelOverlapFrac": 0.3,
    "visibleInScroller": true
   },
   "focus": {
    "hasFocus": true,
    "activeIsContent": true,
    "activeCls": "cm-content cm-lineWrapping",
    "viewHasFocus": true
   },
   "editorRect": [
    0,
    0,
    1176,
    716,
    1176
   ],
   "contentRect": [
    148.1,
    -59.4,
    1018.1,
    17427.5,
    870
   ],
   "win": [
    1176,
    716
   ],
   "zoom": {
    "pref": 100,
    "computed": "1"
   },
   "mode": "float",
   "dataDock": "",
   "scrollerOverflow": {
    "scrollWidth": 1166,
    "clientWidth": 1166,
    "horizontal": false
   },
   "lineMaxRight": 997.1
  },
  "overlay": {
   "coveredByPanel": true,
   "hitCls": "mp-outline-item h3",
   "overlapArea": 9574.9,
   "overlapFrac": 0.3,
   "textRect": [
    172.1,
    102.5,
    155.6,
    27.4
   ],
   "textCoveredFrac": 1,
   "activeIdx": 1,
   "activeVisibleInPanel": true,
   "panelScrollTop": 0
  }
 },
 "floatJumpDown": {
  "click": {
   "k": 49,
   "label": "float-down",
   "clicked": {
    "text": "12.2 小节",
    "i": 49
   },
   "trace": [
    {
     "attempt": 1,
     "panelScrollTop": 260,
     "itemTop": 1106,
     "itemBottom": 1132,
     "fullyVisible": false,
     "hitIdx": -1,
     "hitCls": null
    },
    {
     "attempt": 2,
     "panelScrollTop": 520,
     "itemTop": 846,
     "itemBottom": 872,
     "fullyVisible": false,
     "hitIdx": -1,
     "hitCls": null
    },
    {
     "attempt": 3,
     "panelScrollTop": 780,
     "itemTop": 586,
     "itemBottom": 612,
     "fullyVisible": false,
     "hitIdx": -1,
     "hitCls": "cm-line"
    },
    {
     "attempt": 4,
     "panelScrollTop": 922,
     "itemTop": 443,
     "itemBottom": 470,
     "fullyVisible": true,
     "hitIdx": 49,
     "hitCls": "mp-outline-item h3"
    }
   ]
  },
  "after": {
   "tag": "floatDown-after",
   "docHash": 2816633660,
   "cursor": {
    "head": 13395,
    "lineNo": 653,
    "col": 0,
    "lineText": "### 12.2 小节"
   },
   "scrollTop": 16453.7,
   "len": 14189,
   "panel": {
    "kind": "float",
    "side": null,
    "rect": [
     135,
     44,
     408.1,
     505.1,
     273.1,
     461.1
    ],
    "activeIdx": 49,
    "activeText": "12.2 小节",
    "activeVisibleInPanel": true,
    "scrollTop": 922.3,
    "count": 51,
    "overlapContentArea": 119876.3,
    "overlapVisibleArea": 119876.3,
    "overlapVisibleFrac": 0.2,
    "insideViewport": true
   },
   "target": {
    "line": 653,
    "text": "### 12.2 小节",
    "rect": [
     172.1,
     96.4,
     822,
     32
    ],
    "textRect": [
     172.1,
     102.1,
     121.1,
     20.6
    ],
    "textCoveredArea": 2491.2,
    "textCoveredFrac": 1,
    "firstCharPoint": [
     175,
     112
    ],
    "firstCharHitCls": "mp-outline-item h3",
    "firstCharCoveredByPanel": true,
    "panelOverlapArea": 7552,
    "panelOverlapFrac": 0.3,
    "visibleInScroller": true
   },
   "focus": {
    "hasFocus": true,
    "activeIsContent": true,
    "activeCls": "cm-content cm-lineWrapping",
    "viewHasFocus": true
   },
   "editorRect": [
    0,
    0,
    1176,
    716,
    1176
   ],
   "contentRect": [
    148.1,
    -16437.7,
    1018.1,
    1071.4,
    870
   ],
   "win": [
    1176,
    716
   ],
   "zoom": {
    "pref": 100,
    "computed": "1"
   },
   "mode": "float",
   "dataDock": "",
   "scrollerOverflow": {
    "scrollWidth": 1166,
    "clientWidth": 1166,
    "horizontal": false
   },
   "lineMaxRight": 994.1
  }
 },
 "floatFollow": {
  "label": "float-follow",
  "pick": {
   "line": 671,
   "x": 624,
   "y": 573,
   "text": "### 12.3 小节",
   "idx": 50,
   "rect": [
    172,
    557,
    822,
    32
   ],
   "visibleHeadings": [
    {
     "n": 653,
     "idx": 49,
     "text": "### 12.2 小节"
    },
    {
     "n": 671,
     "idx": 50,
     "text": "### 12.3 小节"
    }
   ]
  },
  "activeIdxBefore": 49,
  "activeTextBefore": "12.2 小节",
  "clickHitCls": "cm-line cm-activeLine mp-h3",
  "cursorLineAfter": 671,
  "expectIdx": 50,
  "panelOpenAfter": true,
  "panelAfter": {
   "kind": "float",
   "count": 51,
   "activeIdx": 49,
   "activeText": "12.2 小节",
   "activeVisibleInPanel": true,
   "scrollTop": 922.3
  },
  "discriminating": true
 },
 "floatKeyFollow": {
  "cursorLine": 1,
  "cursorText": "# 大纲形态普查夹具",
  "expectIdx": 0,
  "activeIdx": 49,
  "activeText": "12.2 小节",
  "panelOpen": true,
  "lastKey": null
 },
 "floatDocEnd": {
  "label": "float",
  "cursor": {
   "lineNo": 690,
   "lines": 690,
   "text": ""
  },
  "btnHittable": true,
  "expectIdx": 50,
  "kind": "float",
  "count": 51,
  "activeIdx": 50,
  "activeText": "12.3 小节",
  "activeVisibleInPanel": false,
  "activeRect": [
   141.6,
   1392.3,
   250.3,
   26.8
  ],
  "panelScrollTop": 0,
  "panelClientHeight": 460,
  "panelRect": [
   135,
   44,
   408.1,
   505.1,
   273.1,
   461.1
  ],
  "scrollTopEditor": 16840
 },
 "dockLeft": {
  "btn": {
   "x": 148,
   "y": 22,
   "w": 26,
   "h": 24,
   "t": 10,
   "b": 34,
   "inViewport": true,
   "hittable": true,
   "hitCls": "[object SVGAnimatedString]",
   "title": "大纲"
  },
  "panel": {
   "kind": "dock",
   "side": "left",
   "rect": [
    8,
    40,
    240,
    708,
    232,
    668
   ],
   "count": 51
  },
  "editorRect": [
   248,
   0,
   1176,
   716,
   928
  ],
  "contentRect": [
   272.1,
   -16824,
   1142.1,
   692,
   870
  ],
  "dockDom": {
   "dockPresent": true,
   "dockBeforeEditor": true,
   "kids": [
    "mp-outline-dock",
    "cm-editor ͼ1 ͼ2 ͼ4 ͼo ͼp"
   ]
  },
  "mode": "left",
  "dataDock": "left",
  "floatEditorRect": [
   0,
   0,
   1176,
   716,
   1176
  ]
 },
 "dockLeftJump": {
  "click": {
   "k": 1,
   "label": "dock-left-up",
   "clicked": {
    "text": "第1章 缘起",
    "i": 1
   },
   "trace": [
    {
     "attempt": 0,
     "panelScrollTop": 707,
     "itemTop": -632,
     "itemBottom": -605,
     "fullyVisible": false,
     "hitIdx": -1,
     "hitCls": null
    },
    {
     "attempt": 1,
     "panelScrollTop": 447,
     "itemTop": -372,
     "itemBottom": -345,
     "fullyVisible": false,
     "hitIdx": -1,
     "hitCls": null
    },
    {
     "attempt": 2,
     "panelScrollTop": 187,
     "itemTop": -112,
     "itemBottom": -85,
     "fullyVisible": false,
     "hitIdx": -1,
     "hitCls": null
    },
    {
     "attempt": 3,
     "panelScrollTop": 0,
     "itemTop": 75,
     "itemBottom": 102,
     "fullyVisible": true,
     "hitIdx": 1,
     "hitCls": "mp-outline-item h2"
    }
   ]
  },
  "after": {
   "tag": "dock-left-after",
   "docHash": 2816633660,
   "cursor": {
    "head": 58,
    "lineNo": 5,
    "col": 0,
    "lineText": "## 第1章 缘起"
   },
   "scrollTop": 75.4,
   "len": 14189,
   "panel": {
    "kind": "dock",
    "side": "left",
    "rect": [
     8,
     40,
     240,
     708,
     232,
     668
    ],
    "activeIdx": 1,
    "activeText": "第1章 缘起",
    "activeVisibleInPanel": true,
    "scrollTop": 0,
    "count": 51,
    "overlapContentArea": 0,
    "overlapVisibleArea": 0,
    "overlapVisibleFrac": 0,
    "insideViewport": true
   },
   "target": {
    "line": 5,
    "text": "## 第1章 缘起",
    "rect": [
     296.1,
     96.2,
     822,
     40.6
    ],
    "textRect": [
     296.1,
     102.5,
     155.6,
     27.4
    ],
    "textCoveredArea": 0,
    "textCoveredFrac": 0,
    "firstCharPoint": [
     299,
     116
    ],
    "firstCharHitCls": "ͼv",
    "firstCharCoveredByPanel": false,
    "panelOverlapArea": 0,
    "panelOverlapFrac": 0,
    "visibleInScroller": true
   },
   "focus": {
    "hasFocus": true,
    "activeIsContent": true,
    "activeCls": "cm-content cm-lineWrapping",
    "viewHasFocus": true
   },
   "editorRect": [
    248,
    0,
    1176,
    716,
    928
   ],
   "contentRect": [
    272.1,
    -59.4,
    1142.1,
    17456.5,
    870
   ],
   "win": [
    1176,
    716
   ],
   "zoom": {
    "pref": 100,
    "computed": "1"
   },
   "mode": "left",
   "dataDock": "left",
   "scrollerOverflow": {
    "scrollWidth": 918,
    "clientWidth": 918,
    "horizontal": false
   },
   "lineMaxRight": 1121.1
  }
 },
 "dockLeftFollow": {
  "label": "dock-left-follow",
  "pick": {
   "line": 7,
   "x": 748,
   "y": 178,
   "text": "### 1.1 小节",
   "idx": 2,
   "rect": [
    296,
    162,
    822,
    32
   ],
   "visibleHeadings": [
    {
     "n": 5,
     "idx": 1,
     "text": "## 第1章 缘起"
    },
    {
     "n": 7,
     "idx": 2,
     "text": "### 1.1 小节"
    }
   ]
  },
  "activeIdxBefore": 1,
  "activeTextBefore": "第1章 缘起",
  "clickHitCls": "cm-line cm-activeLine mp-h3",
  "cursorLineAfter": 7,
  "expectIdx": 2,
  "panelOpenAfter": true,
  "panelAfter": {
   "kind": "dock",
   "count": 51,
   "activeIdx": 1,
   "activeText": "第1章 缘起",
   "activeVisibleInPanel": true,
   "scrollTop": 0
  },
  "discriminating": true
 },
 "dockLeftDocEnd": {
  "label": "dock-left",
  "cursor": {
   "lineNo": 690,
   "lines": 690,
   "text": ""
  },
  "btnHittable": true,
  "expectIdx": 50,
  "kind": "dock",
  "count": 51,
  "activeIdx": 50,
  "activeText": "12.3 小节",
  "activeVisibleInPanel": true,
  "activeRect": [
   14.6,
   680.9,
   209.1,
   26.8
  ],
  "panelScrollTop": 707.4,
  "panelClientHeight": 667,
  "panelRect": [
   8,
   40,
   240,
   708,
   232,
   668
  ],
  "scrollTopEditor": 16840
 },
 "dockRight": {
  "btn": {
   "x": 148,
   "y": 22,
   "w": 26,
   "h": 24,
   "t": 10,
   "b": 34,
   "inViewport": true,
   "hittable": true,
   "hitCls": "[object SVGAnimatedString]",
   "title": "大纲"
  },
  "panel": {
   "kind": "dock",
   "side": "right",
   "rect": [
    936,
    40,
    1168,
    708,
    232,
    668
   ],
   "count": 51
  },
  "editorRect": [
   0,
   0,
   928,
   716,
   928
  ],
  "contentRect": [
   24.1,
   -16824,
   894.1,
   692,
   870
  ],
  "dockDom": {
   "dockPresent": true,
   "dockBeforeEditor": false,
   "kids": [
    "cm-editor ͼ1 ͼ2 ͼ4 ͼo ͼp",
    "mp-outline-dock"
   ]
  },
  "floatEditorRect": [
   0,
   0,
   1176,
   716,
   1176
  ],
  "floatContentRect": [
   148.1,
   16,
   1018.1,
   17489.4,
   870
  ]
 },
 "dockRightJump": {
  "click": {
   "k": 49,
   "label": "dock-right-down",
   "clicked": {
    "text": "12.2 小节",
    "i": 49
   },
   "trace": [
    {
     "attempt": 0,
     "panelScrollTop": 707,
     "itemTop": 654,
     "itemBottom": 681,
     "fullyVisible": true,
     "hitIdx": 49,
     "hitCls": "mp-outline-item h3"
    }
   ]
  },
  "after": {
   "tag": "dock-right-after",
   "docHash": 2816633660,
   "cursor": {
    "head": 13395,
    "lineNo": 653,
    "col": 0,
    "lineText": "### 12.2 小节"
   },
   "scrollTop": 16460.6,
   "len": 14189,
   "panel": {
    "kind": "dock",
    "side": "right",
    "rect": [
     936,
     40,
     1168,
     708,
     232,
     668
    ],
    "activeIdx": 49,
    "activeText": "12.2 小节",
    "activeVisibleInPanel": true,
    "scrollTop": 707.4,
    "count": 51,
    "overlapContentArea": 0,
    "overlapVisibleArea": 0,
    "overlapVisibleFrac": 0,
    "insideViewport": true
   },
   "target": {
    "line": 653,
    "text": "### 12.2 小节",
    "rect": [
     48.1,
     96.3,
     822,
     32
    ],
    "textRect": [
     48.1,
     102,
     121.1,
     20.6
    ],
    "textCoveredArea": 0,
    "textCoveredFrac": 0,
    "firstCharPoint": [
     51,
     112
    ],
    "firstCharHitCls": "ͼv",
    "firstCharCoveredByPanel": false,
    "panelOverlapArea": 0,
    "panelOverlapFrac": 0,
    "visibleInScroller": true
   },
   "focus": {
    "hasFocus": true,
    "activeIsContent": true,
    "activeCls": "cm-content cm-lineWrapping",
    "viewHasFocus": true
   },
   "editorRect": [
    0,
    0,
    928,
    716,
    928
   ],
   "contentRect": [
    24.1,
    -16444.6,
    894.1,
    1071.4,
    870
   ],
   "win": [
    1176,
    716
   ],
   "zoom": {
    "pref": 100,
    "computed": "1"
   },
   "mode": "right",
   "dataDock": "right",
   "scrollerOverflow": {
    "scrollWidth": 918,
    "clientWidth": 918,
    "horizontal": false
   },
   "lineMaxRight": 870.1
  }
 },
 "dockRightFollow": {
  "label": "dock-right-follow",
  "pick": {
   "line": 671,
   "x": 500,
   "y": 573,
   "text": "### 12.3 小节",
   "idx": 50,
   "rect": [
    48,
    557,
    822,
    32
   ],
   "visibleHeadings": [
    {
     "n": 653,
     "idx": 49,
     "text": "### 12.2 小节"
    },
    {
     "n": 671,
     "idx": 50,
     "text": "### 12.3 小节"
    }
   ]
  },
  "activeIdxBefore": 49,
  "activeTextBefore": "12.2 小节",
  "clickHitCls": "cm-line cm-activeLine mp-h3",
  "cursorLineAfter": 671,
  "expectIdx": 50,
  "panelOpenAfter": true,
  "panelAfter": {
   "kind": "dock",
   "count": 51,
   "activeIdx": 49,
   "activeText": "12.2 小节",
   "activeVisibleInPanel": true,
   "scrollTop": 707.4
  },
  "discriminating": true
 },
 "dockRightDocEnd": {
  "label": "dock-right",
  "cursor": {
   "lineNo": 690,
   "lines": 690,
   "text": ""
  },
  "btnHittable": true,
  "expectIdx": 50,
  "kind": "dock",
  "count": 51,
  "activeIdx": 50,
  "activeText": "12.3 小节",
  "activeVisibleInPanel": true,
  "activeRect": [
   942.6,
   680.9,
   209.1,
   26.8
  ],
  "panelScrollTop": 707.4,
  "panelClientHeight": 667,
  "panelRect": [
   936,
   40,
   1168,
   708,
   232,
   668
  ],
  "scrollTopEditor": 16840
 },
 "keyLogTail": [
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 50320
  },
  {
   "key": "=",
   "code": "Equal",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 50321
  },
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 50428
  },
  {
   "key": "=",
   "code": "Equal",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 50429
  },
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 50537
  },
  {
   "key": "=",
   "code": "Equal",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 50538
  },
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 50647
  },
  {
   "key": "=",
   "code": "Equal",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 50648
  },
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 50756
  },
  {
   "key": "=",
   "code": "Equal",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 50757
  },
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 50866
  },
  {
   "key": "=",
   "code": "Equal",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 50867
  },
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 50974
  },
  {
   "key": "=",
   "code": "Equal",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 50975
  },
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 51083
  },
  {
   "key": "=",
   "code": "Equal",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 51084
  },
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 51192
  },
  {
   "key": "=",
   "code": "Equal",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 51193
  },
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 51300
  },
  {
   "key": "=",
   "code": "Equal",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 51301
  },
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 52907
  },
  {
   "key": "End",
   "code": "End",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 52909
  },
  {
   "key": "Control",
   "code": "ControlLeft",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": false,
   "t": 54077
  },
  {
   "key": "0",
   "code": "Digit0",
   "ctrl": true,
   "shift": false,
   "inContent": true,
   "prevented": true,
   "t": 54081
  }
 ],
 "zoom": {
  "before": {
   "pref": 100,
   "computed": "1"
  },
  "after": {
   "pref": 150,
   "computed": "1.5",
   "ls": "150"
  }
 },
 "zoomJump": {
  "click": {
   "k": 1,
   "label": "zoom-dock-up",
   "clicked": {
    "text": "第1章 缘起",
    "i": 1
   },
   "trace": [
    {
     "attempt": 0,
     "panelScrollTop": 707,
     "itemTop": -632,
     "itemBottom": -605,
     "fullyVisible": false,
     "hitIdx": -1,
     "hitCls": null
    },
    {
     "attempt": 1,
     "panelScrollTop": 447,
     "itemTop": -372,
     "itemBottom": -345,
     "fullyVisible": false,
     "hitIdx": -1,
     "hitCls": null
    },
    {
     "attempt": 2,
     "panelScrollTop": 187,
     "itemTop": -112,
     "itemBottom": -85,
     "fullyVisible": false,
     "hitIdx": -1,
     "hitCls": null
    },
    {
     "attempt": 3,
     "panelScrollTop": 0,
     "itemTop": 75,
     "itemBottom": 102,
     "fullyVisible": true,
     "hitIdx": 1,
     "hitCls": "mp-outline-item h2"
    }
   ]
  },
  "after": {
   "tag": "zoom-after",
   "docHash": 2816633660,
   "cursor": {
    "head": 58,
    "lineNo": 5,
    "col": 0,
    "lineText": "## 第1章 缘起"
   },
   "scrollTop": 136.4,
   "len": 14189,
   "panel": {
    "kind": "dock",
    "side": "right",
    "rect": [
     936,
     40,
     1168,
     708,
     232,
     668
    ],
    "activeIdx": 1,
    "activeText": "第1章 缘起",
    "activeVisibleInPanel": true,
    "scrollTop": 0,
    "count": 51,
    "overlapContentArea": 0,
    "overlapVisibleArea": 0,
    "overlapVisibleFrac": 0,
    "insideViewport": true
   },
   "target": {
    "line": 5,
    "text": "## 第1章 缘起",
    "rect": [
     57.6,
     53.2,
     798,
     61.1
    ],
    "textRect": [
     57.6,
     62.3,
     233.4,
     41.1
    ],
    "textCoveredArea": 0,
    "textCoveredFrac": 0,
    "firstCharPoint": [
     61,
     83
    ],
    "firstCharHitCls": "ͼv",
    "firstCharCoveredByPanel": false,
    "panelOverlapArea": 0,
    "panelOverlapFrac": 0,
    "visibleInScroller": true
   },
   "focus": {
    "hasFocus": true,
    "activeIsContent": true,
    "activeCls": "cm-content cm-lineWrapping",
    "viewHasFocus": true
   },
   "editorRect": [
    0,
    0,
    928,
    716,
    928
   ],
   "contentRect": [
    21.6,
    -180.6,
    891.6,
    27369.4,
    870
   ],
   "win": [
    1176,
    716
   ],
   "zoom": {
    "pref": 150,
    "computed": "1.5"
   },
   "mode": "right",
   "dataDock": "right",
   "scrollerOverflow": {
    "scrollWidth": 609,
    "clientWidth": 609,
    "horizontal": false
   },
   "lineMaxRight": 860.1
  }
 },
 "zoomLayout": {
  "panel": [
   936,
   40,
   1168,
   708,
   232,
   668
  ],
  "editorRect": [
   0,
   0,
   928,
   716,
   928
  ],
  "contentRect": [
   21.6,
   -180.6,
   891.6,
   27369.4,
   870
  ],
  "scrollerClientHeight": 477
 },
 "zoomReset": {
  "pref": 100,
  "computed": "1"
 },
 "narrowViewport": {
  "want": [
   660,
   760
  ],
  "how": "window.resizeTo(真实窗口)",
  "resizeToGot": [
   660,
   713,
   1.75
  ],
  "resizeToReq": [
   673,
   962
  ],
  "vp": [
   660,
   713,
   1.75
  ],
  "real": true,
  "heightShortfall": 47
 },
 "narrow": {
  "how": "window.resizeTo(真实窗口)",
  "vp": [
   660,
   713,
   1.75
  ],
  "win": [
   660,
   713
  ],
  "panel": {
   "kind": "dock",
   "side": "right",
   "rect": [
    420,
    65,
    652,
    705.1,
    232,
    640.1
   ],
   "insideViewport": true,
   "overlapContentArea": 0,
   "overlapEditorArea": 0
  },
  "editorRect": [
   0,
   0,
   412,
   713.1,
   412
  ],
  "contentRect": [
   0,
   -142.3,
   402.3,
   17813.9,
   402.3
  ],
  "toolbarOutlineBtn": {
   "x": 39,
   "y": 22,
   "w": 26,
   "h": 24,
   "t": 10,
   "b": 34,
   "inViewport": true,
   "hittable": true,
   "hitCls": "[object SVGAnimatedString]",
   "title": "大纲"
  }
 },
 "narrowJump": {
  "click": {
   "k": 1,
   "label": "narrow-dock-up",
   "clicked": {
    "text": "第1章 缘起",
    "i": 1
   },
   "trace": [
    {
     "attempt": 0,
     "panelScrollTop": 0,
     "itemTop": 100,
     "itemBottom": 127,
     "fullyVisible": true,
     "hitIdx": 1,
     "hitCls": "mp-outline-item h2 active"
    }
   ]
  },
  "after": {
   "tag": "narrow-after",
   "docHash": 2816633660,
   "cursor": {
    "head": 58,
    "lineNo": 5,
    "col": 0,
    "lineText": "## 第1章 缘起"
   },
   "scrollTop": 73.1,
   "len": 14189,
   "panel": {
    "kind": "dock",
    "side": "right",
    "rect": [
     420,
     65,
     652,
     705.1,
     232,
     640.1
    ],
    "activeIdx": 1,
    "activeText": "第1章 缘起",
    "activeVisibleInPanel": true,
    "scrollTop": 0,
    "count": 51,
    "overlapContentArea": 0,
    "overlapVisibleArea": 0,
    "overlapVisibleFrac": 0,
    "insideViewport": true
   },
   "target": {
    "line": 5,
    "text": "## 第1章 缘起",
    "rect": [
     24,
     146.2,
     354.3,
     40.6
    ],
    "textRect": [
     24,
     152.4,
     155.6,
     27.4
    ],
    "textCoveredArea": 0,
    "textCoveredFrac": 0,
    "firstCharPoint": [
     27,
     166
    ],
    "firstCharHitCls": "ͼv",
    "firstCharCoveredByPanel": false,
    "panelOverlapArea": 0,
    "panelOverlapFrac": 0,
    "visibleInScroller": true
   },
   "focus": {
    "hasFocus": true,
    "activeIsContent": true,
    "activeCls": "cm-content cm-lineWrapping",
    "viewHasFocus": true
   },
   "editorRect": [
    0,
    0,
    412,
    713.1,
    412
   ],
   "contentRect": [
    0,
    -57.1,
    402.3,
    18441.8,
    402.3
   ],
   "win": [
    660,
    713
   ],
   "zoom": {
    "pref": 100,
    "computed": "1"
   },
   "mode": "right",
   "dataDock": "right",
   "scrollerOverflow": {
    "scrollWidth": 402,
    "clientWidth": 402,
    "horizontal": false
   },
   "lineMaxRight": 381.3
  }
 },
 "narrowFloat": {
  "btn": {
   "x": 39,
   "y": 22,
   "w": 26,
   "h": 24,
   "t": 10,
   "b": 34,
   "inViewport": true,
   "hittable": true,
   "hitCls": "[object SVGAnimatedString]",
   "title": "大纲"
  },
  "panel": {
   "kind": "float",
   "rect": [
    26,
    44,
    299.1,
    503.3,
    273.1,
    459.3
   ],
   "insideViewport": true,
   "overlapContentArea": 100124.3,
   "overlapContentFrac": 0,
   "overlapVisibleArea": 100124.3,
   "overlapVisibleFrac": 0.3,
   "visibleContentRect": [
    81.1,
    0,
    569.1,
    713.1
   ],
   "count": 51
  },
  "contentRect": [
   81.1,
   -57.1,
   569.1,
   18441.8,
   488
  ],
  "editorRect": [
   0,
   0,
   660,
   713.1,
   660
  ],
  "win": [
   660,
   713
  ]
 },
 "narrowFloatJump": {
  "click": {
   "k": 1,
   "label": "narrow-float-up",
   "clicked": {
    "text": "第1章 缘起",
    "i": 1
   },
   "trace": [
    {
     "attempt": 0,
     "panelScrollTop": 0,
     "itemTop": 79,
     "itemBottom": 106,
     "fullyVisible": true,
     "hitIdx": 1,
     "hitCls": "mp-outline-item h2 active"
    }
   ]
  },
  "after": {
   "tag": "narrow-float-after",
   "docHash": 2816633660,
   "cursor": {
    "head": 58,
    "lineNo": 5,
    "col": 0,
    "lineText": "## 第1章 缘起"
   },
   "scrollTop": 73.1,
   "len": 14189,
   "panel": {
    "kind": "float",
    "side": null,
    "rect": [
     26,
     44,
     299.1,
     503.3,
     273.1,
     459.3
    ],
    "activeIdx": 1,
    "activeText": "第1章 缘起",
    "activeVisibleInPanel": true,
    "scrollTop": 0,
    "count": 51,
    "overlapContentArea": 100124.3,
    "overlapVisibleArea": 100124.3,
    "overlapVisibleFrac": 0.3,
    "insideViewport": true
   },
   "target": {
    "line": 5,
    "text": "## 第1章 缘起",
    "rect": [
     105.1,
     146.2,
     440,
     40.6
    ],
    "textRect": [
     105.1,
     152.4,
     155.6,
     27.4
    ],
    "textCoveredArea": 4267.1,
    "textCoveredFrac": 1,
    "firstCharPoint": [
     108,
     166
    ],
    "firstCharHitCls": "mp-outline-item h3",
    "firstCharCoveredByPanel": true,
    "panelOverlapArea": 7870.9,
    "panelOverlapFrac": 0.4,
    "visibleInScroller": true
   },
   "focus": {
    "hasFocus": true,
    "activeIsContent": true,
    "activeCls": "cm-content cm-lineWrapping",
    "viewHasFocus": true
   },
   "editorRect": [
    0,
    0,
    660,
    713.1,
    660
   ],
   "contentRect": [
    81.1,
    -57.1,
    569.1,
    18441.8,
    488
   ],
   "win": [
    660,
    713
   ],
   "zoom": {
    "pref": 100,
    "computed": "1"
   },
   "mode": "float",
   "dataDock": "",
   "scrollerOverflow": {
    "scrollWidth": 650,
    "clientWidth": 650,
    "horizontal": false
   },
   "lineMaxRight": 548.1
  }
 },
 "zoomFloatOpen": {
  "btn": {
   "x": 143,
   "y": 22,
   "w": 26,
   "h": 24,
   "t": 10,
   "b": 34,
   "inViewport": true,
   "hittable": true,
   "hitCls": "[object SVGAnimatedString]",
   "title": "大纲"
  },
  "zoom": {
   "pref": 150,
   "computed": "1.5"
  },
  "panel": {
   "kind": "float",
   "rect": [
    130.1,
    44,
    403.3,
    503.3,
    273.1,
    459.3
   ],
   "insideViewport": true,
   "overlapVisible": 118873,
   "overlapVisibleFrac": 0.2,
   "count": 51
  },
  "win": [
   1166,
   713
  ]
 },
 "zoomFloatPre": {
  "openBeforeEnsure": true,
  "openAfterEnsure": false
 },
 "zoomFloatJump": {
  "click": {
   "k": 1,
   "label": "zoom-float-up",
   "clicked": {
    "text": "第1章 缘起",
    "i": 1
   },
   "trace": [
    {
     "attempt": 0,
     "panelScrollTop": 0,
     "itemTop": 79,
     "itemBottom": 106,
     "fullyVisible": true,
     "hitIdx": 1,
     "hitCls": "mp-outline-item h2"
    }
   ]
  },
  "after": {
   "tag": "zoom-float-after",
   "docHash": 2816633660,
   "cursor": {
    "head": 58,
    "lineNo": 5,
    "col": 0,
    "lineText": "## 第1章 缘起"
   },
   "scrollTop": 136.4,
   "len": 14189,
   "panel": {
    "kind": "float",
    "side": null,
    "rect": [
     130.1,
     44,
     403.3,
     503.3,
     273.1,
     459.3
    ],
    "activeIdx": 1,
    "activeText": "第1章 缘起",
    "activeVisibleInPanel": true,
    "scrollTop": 0,
    "count": 51,
    "overlapContentArea": 118873,
    "overlapVisibleArea": 118873,
    "overlapVisibleFrac": 0.2,
    "insideViewport": true
   },
   "target": {
    "line": 5,
    "text": "## 第1章 缘起",
    "rect": [
     180.5,
     53.2,
     790.5,
     61.1
    ],
    "textRect": [
     180.5,
     62.3,
     233.4,
     41.1
    ],
    "textCoveredArea": 9167.5,
    "textCoveredFrac": 1,
    "firstCharPoint": [
     183,
     83
    ],
    "firstCharHitCls": "mp-outline-item h2 active",
    "firstCharCoveredByPanel": true,
    "panelOverlapArea": 13623.9,
    "panelOverlapFrac": 0.3,
    "visibleInScroller": true
   },
   "focus": {
    "hasFocus": true,
    "activeIsContent": true,
    "activeCls": "cm-content cm-lineWrapping",
    "viewHasFocus": true
   },
   "editorRect": [
    0,
    0,
    1166.3,
    713.1,
    1166.3
   ],
   "contentRect": [
    144.5,
    -180.6,
    1007,
    26947.9,
    862.5
   ],
   "win": [
    1166,
    713
   ],
   "zoom": {
    "pref": 150,
    "computed": "1.5"
   },
   "mode": "float",
   "dataDock": "",
   "scrollerOverflow": {
    "scrollWidth": 768,
    "clientWidth": 768,
    "horizontal": false
   },
   "lineMaxRight": 975.5
  }
 },
 "zoomFloatReset": {
  "pref": 100,
  "computed": "1"
 },
 "switchLeft": {
  "after": {
   "mode": "left",
   "checked": true,
   "dataDock": "left",
   "floatEl": false,
   "dockEl": false,
   "hostFlex": false
  },
  "final": {
   "dlgOpen": false,
   "mode": "left",
   "dataDock": "left"
  }
 },
 "switchRight": {
  "after": {
   "mode": "right",
   "checked": true,
   "dataDock": "right",
   "floatEl": false,
   "dockEl": false,
   "hostFlex": false
  },
  "final": {
   "dlgOpen": false,
   "mode": "right",
   "dataDock": "right"
  }
 },
 "narrowSwitchFloat": {
  "after": {
   "mode": "float",
   "checked": true,
   "dataDock": "",
   "floatEl": false,
   "dockEl": false,
   "hostFlex": false
  },
  "final": {
   "dlgOpen": false,
   "mode": "float",
   "dataDock": ""
  }
 },
 "focusProbe": [
  {
   "step": "bringToFront+click",
   "box": {
    "x": 688,
    "y": 7355
   },
   "hasFocus": true,
   "activeIsContent": true,
   "activeCls": "cm-content cm-lineWrapping"
  }
 ],
 "final": {
  "tag": "final",
  "docHash": 2816633660,
  "cursor": {
   "head": 58,
   "lineNo": 5,
   "col": 0,
   "lineText": "## 第1章 缘起"
  },
  "scrollTop": 136,
  "len": 14189,
  "panel": {
   "kind": "float",
   "side": null,
   "rect": [
    130.1,
    44,
    403.3,
    503.3,
    273.1,
    459.3
   ],
   "activeIdx": 1,
   "activeText": "第1章 缘起",
   "activeVisibleInPanel": true,
   "scrollTop": 0,
   "count": 51,
   "overlapContentArea": 117806.8,
   "overlapVisibleArea": 117806.8,
   "overlapVisibleFrac": 0.2,
   "insideViewport": true
  },
  "target": null,
  "focus": {
   "hasFocus": true,
   "activeIsContent": true,
   "activeCls": "cm-content cm-lineWrapping",
   "viewHasFocus": true
  },
  "editorRect": [
   0,
   0,
   1166.3,
   713.1,
   1166.3
  ],
  "contentRect": [
   146.8,
   -120,
   1009.8,
   17360.2,
   863
  ],
  "win": [
   1166,
   713
  ],
  "zoom": {
   "pref": 100,
   "computed": "1"
  },
  "mode": "float",
  "dataDock": "",
  "scrollerOverflow": {
   "scrollWidth": 1157,
   "clientWidth": 1157,
   "horizontal": false
  },
  "lineMaxRight": 988.8
 },
 "mainProcess": {
  "pid": 77512,
  "aliveAtEnd": true
 }
}
```

## 未通过项

- **F4** 浮层：跳转成功后**目标标题的文字是否被浮层压住**（按文字实际范围量，不是行盒；判据＝文字零遮挡）
  ```json
  {
   "firstCharCoveredByPanel": true,
   "firstCharHitCls": "mp-outline-item h3",
   "textRect": [
    172.1,
    102.5,
    155.6,
    27.4
   ],
   "lineRect": [
    172.1,
    96.2,
    822,
    40.6
   ],
   "textCoveredFrac": 1,
   "textCoveredArea": 4267.1,
   "panelRect": [
    135,
    44,
    408.1,
    505.1,
    273.1,
    461.1
   ]
  }
  ```
- **F8** 浮层：光标移到**另一条**标题后，面板当前项高亮是否跟着变（真实鼠标点正文标题；先断言本次移动确实换了标题，否则无鉴别力）
  ```json
  {
   "label": "float-follow",
   "pick": {
    "line": 671,
    "x": 624,
    "y": 573,
    "text": "### 12.3 小节",
    "idx": 50,
    "rect": [
     172,
     557,
     822,
     32
    ],
    "visibleHeadings": [
     {
      "n": 653,
      "idx": 49,
      "text": "### 12.2 小节"
     },
     {
      "n": 671,
      "idx": 50,
      "text": "### 12.3 小节"
     }
    ]
   },
   "activeIdxBefore": 49,
   "activeTextBefore": "12.2 小节",
   "clickHitCls": "cm-line cm-activeLine mp-h3",
   "cursorLineAfter": 671,
   "expectIdx": 50,
   "panelOpenAfter": true,
   "panelAfter": {
    "kind": "float",
    "count": 51,
    "activeIdx": 49,
    "activeText": "12.2 小节",
    "activeVisibleInPanel": true,
    "scrollTop": 922.3
   },
   "discriminating": true
  }
  ```
- **F8b** 浮层：用**真实键盘**（Ctrl+Home，键日志证明确实进了编辑面）把光标挪到文首标题，面板高亮是否跟随（第二条通道）
  ```json
  {
   "cursorLine": 1,
   "cursorText": "# 大纲形态普查夹具",
   "expectIdx": 0,
   "activeIdx": 49,
   "activeText": "12.2 小节",
   "panelOpen": true,
   "lastKey": null
  }
  ```
- **F10b** 浮层：上面这一刻，当前项是否在面板可视区内（51 条、面板 ~62vh ⇒ 面板要不要自己滚）
  ```json
  {
   "activeIdx": 50,
   "activeVisibleInPanel": false,
   "panelScrollTop": 0,
   "panelClientHeight": 460,
   "activeRect": [
    141.6,
    1392.3,
    250.3,
    26.8
   ],
   "panelRect": [
    135,
    44,
    408.1,
    505.1,
    273.1,
    461.1
   ]
  }
  ```
- **L5** 左停靠：光标移到**另一条**标题后，面板当前项高亮是否跟随（真实鼠标点正文标题；含鉴别力断言）
  ```json
  {
   "label": "dock-left-follow",
   "pick": {
    "line": 7,
    "x": 748,
    "y": 178,
    "text": "### 1.1 小节",
    "idx": 2,
    "rect": [
     296,
     162,
     822,
     32
    ],
    "visibleHeadings": [
     {
      "n": 5,
      "idx": 1,
      "text": "## 第1章 缘起"
     },
     {
      "n": 7,
      "idx": 2,
      "text": "### 1.1 小节"
     }
    ]
   },
   "activeIdxBefore": 1,
   "activeTextBefore": "第1章 缘起",
   "clickHitCls": "cm-line cm-activeLine mp-h3",
   "cursorLineAfter": 7,
   "expectIdx": 2,
   "panelOpenAfter": true,
   "panelAfter": {
    "kind": "dock",
    "count": 51,
    "activeIdx": 1,
    "activeText": "第1章 缘起",
    "activeVisibleInPanel": true,
    "scrollTop": 0
   },
   "discriminating": true
  }
  ```
- **R5** 右停靠：光标移到**另一条**标题后，面板当前项高亮是否跟随（真实鼠标点正文标题；含鉴别力断言）
  ```json
  {
   "label": "dock-right-follow",
   "pick": {
    "line": 671,
    "x": 500,
    "y": 573,
    "text": "### 12.3 小节",
    "idx": 50,
    "rect": [
     48,
     557,
     822,
     32
    ],
    "visibleHeadings": [
     {
      "n": 653,
      "idx": 49,
      "text": "### 12.2 小节"
     },
     {
      "n": 671,
      "idx": 50,
      "text": "### 12.3 小节"
     }
    ]
   },
   "activeIdxBefore": 49,
   "activeTextBefore": "12.2 小节",
   "clickHitCls": "cm-line cm-activeLine mp-h3",
   "cursorLineAfter": 671,
   "expectIdx": 50,
   "panelOpenAfter": true,
   "panelAfter": {
    "kind": "dock",
    "count": 51,
    "activeIdx": 49,
    "activeText": "12.2 小节",
    "activeVisibleInPanel": true,
    "scrollTop": 707.4
   },
   "discriminating": true
  }
  ```
- **N5** 窄窗 660px（浮层）：条目点击后**目标标题文字是否被浮层压住**（窄窗下浮层占正文的比例更大）
  ```json
  {
   "want": {
    "line": 5
   },
   "got": {
    "line": 5
   },
   "cursorLanded": true,
   "firstCharCovered": true,
   "firstCharHitCls": "mp-outline-item h3",
   "textRect": [
    105.1,
    152.4,
    155.6,
    27.4
   ],
   "textCoveredFrac": 1,
   "textCoveredArea": 4267.1,
   "panelRect": [
    26,
    44,
    299.1,
    503.3,
    273.1,
    459.3
   ],
   "targetLineRect": [
    105.1,
    146.2,
    440,
    40.6
   ],
   "ERR": null
  }
  ```

## pageerror

（无）

## 截图

- 01-float-open.png
- 02-float-jump-up.png
- 03-float-jump-down.png
- 04-float-follow-cursor.png
- 05b-float-docend-open.png
- 05-float-closed.png
- 06-dock-left-open.png
- 07-dock-left-jump.png
- 08-dock-left-follow.png
- 08b-dock-left-docend-open.png
- 09-dock-right-open.png
- 10-dock-right-jump.png
- 11-dock-right-follow.png
- 11b-dock-right-docend-open.png
- 12-zoom150-jump.png
- 13-narrow-dock-right.png
- 14-narrow-dock-jump.png
- 15-narrow-float-open.png
- 16-narrow-float-jump.png
- 17-zoom150-float-open.png
- 18-zoom150-float-jump.png

## 备注

（无）