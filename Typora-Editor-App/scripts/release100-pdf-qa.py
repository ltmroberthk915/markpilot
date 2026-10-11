"""Read exported PDFs, inspect page bounds, render representative pages only."""
import hashlib,json,pathlib,subprocess,sys
import fitz
source=pathlib.Path(sys.argv[1]).resolve(); output=pathlib.Path(sys.argv[2]).resolve();output.mkdir(parents=True,exist_ok=True)
digest=hashlib.sha256(source.read_bytes()).hexdigest();doc=fitz.open(source)
anomalies=[];matrix=[];summaries=[]
for i,page in enumerate(doc):
    text=page.get_text();summaries.append({'page':i+1,'characters':len(text),'width':page.rect.width,'height':page.rect.height})
    if '矩阵' in text:matrix.append(i)
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines',[]):
            for span in line.get('spans',[]):
                if not span['text'].strip():continue
                box=fitz.Rect(span['bbox'])
                if box.x0<-1 or box.y0<-1 or box.x1>page.rect.width+1 or box.y1>page.rect.height+1:
                    anomalies.append({'page':i+1,'bbox':list(box),'text':span['text'][:80]})
selected=sorted(set([0,min(1,len(doc)-1),len(doc)//2,len(doc)-1]+matrix[:3]+[item['page']-1 for item in anomalies[:4]]))
poppler=pathlib.Path(r'C:\Users\Ming\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe')
images=[]
for i in selected:
    prefix=output/f'page-{i+1:03d}'
    subprocess.run([str(poppler),'-f',str(i+1),'-l',str(i+1),'-r','105','-png','-singlefile',str(source),str(prefix)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,creationflags=0x08000000)
    images.append(str(prefix)+'.png')
assert hashlib.sha256(source.read_bytes()).hexdigest()==digest
report={'source':str(source),'sha256':digest,'pageCount':len(doc),'pageSummaries':summaries,'outsidePageText':anomalies,'sampledPages':[i+1 for i in selected],'images':images,'visualInspection':'pending; bounds check alone does not prove layout quality'}
(output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:report[k] for k in ['pageCount','outsidePageText','sampledPages','images']},ensure_ascii=False))
