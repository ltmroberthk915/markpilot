// Repaint-residue regression: the user's report — after an AI-inserted
// sentence carrying an inline formula, backspacing at its end leaves stale
// pixels above the line (even above the previous line). Reproduces with real
// input events, then detects stale paint by pixel-diffing a capture against a
// forced-clean repaint (display toggle with scroll preserved). Captures never
// scroll first: scrolling itself invalidates and would wipe the evidence.
const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,ev,until,output})=>{
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const report=[];
  // Mirrors the user's 1-重识概率论.md §1.2.3 structure: a $$ display block, a
  // dense multi-formula paragraph, the AI sentence ending with 则 at the long
  // paragraph's end, the anchor line, a numbered list, then depth-filler.
  const ai='由于实空间 Borel 代数上的概率测度等价于在实空间上定义累积分布函数：$\\mathcal{B}\\equiv\\sigma(\\{(-\\infty,x]\\,|\\,x\\in\\mathbb{R}\\})$，则';
  const source='# 重识概率论（残留复现）\n\n'
    +'### 1.2.2 引理的证明收尾\n\n设定义在 $(\\Omega,\\mathcal{F},\\mathbb{P})$ 上的随机变量 $X$。考察定义在 $(\\mathbb{R}^k,\\mathcal{B}(\\mathbb{R}^k),\\mathbb{P}_X)$ 上的随机变量 $g(x):=x$，$g:\\mathbb{R}^k\\to\\mathbb{R}^k$。由于 $\\forall B\\in\\mathcal{B}(\\mathbb{R}^k)$，$g^{-1}(B)=B$，且 $\\mathbb{P}_X(g^{-1}(B))=\\mathbb{P}_X(B)=\\mathbb{P}(X^{-1}(B))$，则两个随机变量 $g$ 与 $X$ 在实数取值空间上的随机行为一致。\n\n'
    +ai+'\n\n$$\nF_X(x):=\\mathbb{P}_X\\big((-\\infty,x]\\big)\n$$\n\n'
    +'可以完全描述测度 $\\mathbb{P}_X$。换句话说，诱导概率测度 $\\mathbb{P}_X$ 与累积分布函数（CDF）$F_X$ 一一对应。因此在大部分情况下，我们将随机变量直接定义在结果空间上：$(\\Omega\':=\\mathbb{R}^k,\\ \\mathcal{F}\':=\\mathcal{B}(\\mathbb{R}^k),\\ \\mathbb{P}_X)$。'+ai+'\n\n'
    +'至此，对随机变量的理解有三层：\n\n'
    +'1. **第一层**：一个随机变化的数——"看山是山"；\n2. **第二层**：一个定义在底层样本空间 $(\\Omega,\\mathcal{F},\\mathbb{P})$ 上的可测函数——"看山不是山"；\n3. **第三层**：一个定义在观测样本空间 $(\\mathbb{R},\\mathcal{B},\\mathbb{P}_X)$ 上的恒等随机变量——"看山还是山"。\n\n'
    +Array.from({length:14},(_,i)=>'### 1.3.'+(i+1)+' 备注段落\n\n这一段是中性的填充内容，长度与真实文档相近，用于把锚点行推到需要滚动的深度，编辑器视口固定而内容足够长，公式 $a_'+i+'+b$ 与文字混排保持每段两到三行的折行状态，越往下越接近文末。\n\n').join('');
  const needle='\\mathcal{B}\\equiv';
  const capture=async name=>{const image=await win.webContents.capturePage();fs.writeFileSync(path.join(output,'repaint-'+name+'.png'),image.toPNG());return image.getBitmap();};
  const diff=(a,b,width)=>{
    if(a.length!==b.length)return{pixels:Math.min(a.length,b.length)/4,sizeMismatch:true};
    let count=0,minX=1e9,minY=1e9,maxX=-1,maxY=-1;
    for(let i=0;i<a.length;i+=4){
      const d=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);
      if(d>30){count++;const p=i/4,x=p%width,y=(p/width)|0;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    }
    return{pixels:count,box:count?[minX,minY,maxX,maxY]:null};
  };
  const resetCss=`(()=>{for(const l of document.querySelectorAll('link[rel="stylesheet"]'))if(l.sheet)l.sheet.disabled=false;document.querySelectorAll('style[data-variant-style]').forEach(n=>n.remove());return true})()`;
  const scenario=async({id,inject='',popup=false,blur=true,follow=false})=>{
    await ev(`__open(${JSON.stringify(source)})`);
    await until('vditor?.vditor?.__typoraPatched');
    await until('__typoraMathStats.pending===0');
    await delay(350);
    await ev(resetCss);
    if(inject)await ev(inject);
    // Caret at the end of the AI sentence's tail 则 (the last one: the insert
    // went at the end of the long paragraph, before the anchor paragraph).
    const placed=await ev(`(()=>{const ir=vditor.vditor.ir.element;const walker=document.createTreeWalker(ir,NodeFilter.SHOW_TEXT);let n,last=null;while(n=walker.nextNode()){if(n.data.endsWith('，则'))last=n;}if(!last)return false;const r=document.createRange();r.setStart(last,last.data.length);r.collapse(true);ir.focus();const s=getSelection();s.removeAllRanges();s.addRange(r);return ir.contains(s.anchorNode)})()`);
    if(!placed)throw new Error('caret not placed for '+id);
    if(popup){
      await ev(`(async()=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/render/css/completion.css';const done=new Promise(r=>{link.onload=r;link.onerror=r;});document.head.append(link);await done;const ir=vditor.vditor.ir.element;const sel=getSelection();let top=40,left=60;if(sel.rangeCount){const rect=sel.getRangeAt(0).getBoundingClientRect();top=Math.max(8,rect.top-96);left=Math.max(8,rect.left);}const node=document.createElement('div');node.id='fake-completion';node.className='md-completion';node.style.left=left+'px';node.style.top=top+'px';node.style.width='350px';node.textContent='由于实空间 Borel 代数……(候选)';document.body.append(node);${blur?'':`node.style.backdropFilter='none';node.style.webkitBackdropFilter='none';`}return true})()`);
    }
    // Backspace with real input events through the whole sentence and into
    // the paragraph — the artifact shows "after the line is deleted". A whole
    // inline node (formula) dies in one keystroke in IR, so run a fixed count
    // and stop early only if the document stops changing.
    let steps=0,stalled=0,lastValue='';
    for(;steps<140;steps++){
      const value=await ev('vditor.getValue()');
      if(value===lastValue){if(++stalled>=10)break;}else stalled=0;
      lastValue=value;
      if(!value.includes('Borel'))break;
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'});
      await delay(30);
      if(popup&&follow){
        await ev(`(()=>{const node=document.getElementById('fake-completion');if(!node)return false;const sel=getSelection();let top=40,left=60;if(sel.rangeCount){const rect=sel.getRangeAt(0).getBoundingClientRect();top=Math.max(8,rect.top-96);left=Math.max(8,rect.left);}node.style.top=top+'px';node.style.left=left+'px';return true})()`);
      }
    }
    await delay(600);
    await ev(`document.getElementById('fake-completion')?.remove();true`);
    await delay(150);
    // Capture at the CURRENT scroll position (scrolling would clean residue).
    const imageSize=await ev('({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})');
    const bitmapWidth=Math.round(imageSize.w*imageSize.dpr);
    const before=await capture(id+'-dirty');
    const control=await capture(id+'-control');
    // Forced clean repaint: hide the editor, reflow, restore, reflow — with
    // every scroller's position saved and restored so the frame is identical.
    await ev(`(()=>{const save={x:scrollX,y:scrollY,roots:[...document.querySelectorAll('.vditor-reset')].map(n=>({n,top:n.scrollTop,left:n.scrollLeft}))};const host=document.getElementById('vditor');host.style.display='none';host.getBoundingClientRect();requestAnimationFrame(()=>requestAnimationFrame(()=>{host.style.display='';host.getBoundingClientRect();for(const r of save.roots){r.n.scrollTop=r.top;r.n.scrollLeft=r.left;}window.scrollTo(save.x,save.y);host.getBoundingClientRect();}));return true})()`);
    await delay(400);
    const clean=await capture(id+'-clean');
    const controlDiff=diff(before,control,bitmapWidth);
    const residue=diff(before,clean,bitmapWidth);
    const value=await ev('vditor.getValue()');
    const entry={variant:id,backspaces:steps,imageSize,controlDifferentPixels:controlDiff.pixels,
      residuePixels:residue.pixels,residueBox:residue.box||null,copiesLeft:value.split(needle).length-1};
    report.push(entry);
    console.log(`${id}: backspaces=${steps} controlDiff=${controlDiff.pixels} residue=${residue.pixels}${residue.box?' box='+JSON.stringify(residue.box):''} copies=${entry.copiesLeft}`);
    fs.writeFileSync(path.join(output,'repaint-'+id+'-value.md'),value);
    fs.writeFileSync(path.join(output,'repaint-residue.json'),JSON.stringify({report},null,2));
  };
  await scenario({id:'v0-full'});
  await scenario({id:'v1-sheet-off',inject:`(()=>{const t=document.querySelector('link[href$="typography.css"]');if(t&&t.sheet)t.sheet.disabled=true;return true})()`});
  await scenario({id:'v2-autospace-off',inject:`(()=>{const s=document.createElement('style');s.dataset.variantStyle='1';s.textContent='.vditor-reset{text-autospace:no-autospace!important}';document.head.append(s);return true})()`});
  await scenario({id:'v3-justify-off',inject:`(()=>{const s=document.createElement('style');s.dataset.variantStyle='1';s.textContent='.vditor-reset p,.vditor-reset li,.vditor-reset blockquote p{text-align:start!important}';document.head.append(s);return true})()`});
  await scenario({id:'p0-blur-popup-follow',popup:true,blur:true,follow:true});
  await scenario({id:'p1-plain-popup-follow',popup:true,blur:false,follow:true});
  return report;
};
