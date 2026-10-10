import { PDFDocument,rgb } from "pdf-lib";
import { parseBookFile } from "../../../app/src/lib/parseBook";
import { detectBookFormat } from "../../../app/src/lib/bookFormats";
import { openPdfDocument, pdfjs } from "../../../app/src/lib/pdfjs";
import { readerFlow,gestureTurn,readingInset } from "./reader-layout";
import { swatch } from "../../../app/src/lib/readingPalette";
import { pdfRectGeometry } from "./pdf-annotations";
import { pdfSelectionPage } from "./pdf-selection";
import { pdfScrollPosition, pdfScrollOffset } from "./pdf-position";

declare global {
  interface Window {
    ShufangBridge: { postMessage(value: string): void; onmessage: (event: MessageEvent) => void };
    shufang: { importFile: typeof importFile; showBook: typeof showBook; setType: typeof setType; showTranslation: typeof showTranslation };
  }
}
let counter = 0;
const replies = new Map<number, {resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
function send(type: string, value: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve,reject) => {
    const requestId = ++counter; replies.set(requestId,{resolve,reject});
    window.ShufangBridge.postMessage(JSON.stringify({type,requestId,...value}));
  });
}
window.ShufangBridge.onmessage = event => {
  const value = JSON.parse(event.data); const reply = replies.get(value.requestId);
  replies.delete(value.requestId); if(value.error) reply?.reject(new Error(value.error)); else reply?.resolve(value.value);
};
const status = document.getElementById("status")!;
const content = document.getElementById("content")!;
let currentBook: any; let currentChapter: any; let pageNumber=1; let currentPdf: any;
let pdfObserver:IntersectionObserver|undefined;let pdfGeneration=0;let pdfTask:any;
let pdfSeek:((page:number,fraction:number)=>void)|undefined;
let pdfSyncToken="";
for(const event of ["touchstart","wheel","pointerdown","keydown"])content.addEventListener(event,()=>{pdfSyncToken="";},{passive:true});
let currentHighlights:any[]=[];let typeSettings:any={};let activeSource="";let renderingBookUrl="";let footnoteOpen=false;let pdfReadingLayout="vertical";let regionMode=false;
function textAnchor(){const viewport=content.getBoundingClientRect();const paragraphs=Array.from(content.querySelectorAll("p[data-index]"));const p=paragraphs.find(p=>{const r=p.getBoundingClientRect();return r.right>viewport.left&&r.left<viewport.right&&r.bottom>0;});return p?{paraIndex:Number(p.getAttribute("data-index"))}:null;}
const escape = (value:string) => value.replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));
function highlightStyle(style:any):string {
  const color=swatch(style?.color??"yellow");
  if(style?.kind==="underline")return `background:transparent;color:inherit;text-decoration:underline;text-decoration-color:${color.solid}`;
  if(style?.kind==="color")return `background:transparent;color:${color.solid}`;
  return `background:${color.soft};color:inherit`;
}
async function importFile(url:string,name:string,mode:"reflow"|"original") {
  try {
    const format=detectBookFormat(name); if(!format) throw new Error("不支持的书籍格式");
    status.textContent="正在解析 "+name;
    const response=await fetch(url); if(!response.ok) throw new Error("无法读取导入文件");
    const file=new File([await response.blob()],name);
    const parsed=await parseBookFile(file,format,(stage,ratio)=> {status.textContent=stage;void send("progress",{stage,ratio});},{pdfMode:mode});
    const book={...parsed,format,coverTone:0,readerMode:format==="pdf"?(parsed.chapters.some(c=>c.paragraphs.some(p=>p.trim()))?mode:"original"):"reflow",progress:{chapterId:parsed.chapters[0]?.id??"",ratio:0}};
    const json=JSON.stringify(book);
    await send("parsedBegin");
    // Chunk boundaries preserve surrogate pairs before Kotlin UTF-8 encoding.
    for(let offset=0;offset<json.length;) {
      let end=Math.min(offset+64*1024,json.length);
      if(end<json.length && /[\uD800-\uDBFF]/.test(json[end-1])) end--;
      await send("parsedChunk",{text:json.slice(offset,end)});offset=end;
    }
    await send("parsedEnd");status.textContent="导入完成";
  } catch(error) {status.textContent=String(error);void send("failure",{error:String(error)});}
}
async function searchPdf(url:string,bookId:string,query:string,generation:number) {
  let document:any;let loadingTask:any;
  try {
    loadingTask=openPdfDocument(new Uint8Array(await (await fetch(url)).arrayBuffer()));document=await loadingTask.promise;
    let emptyPages=0;let hits=0;
    for(let number=1;number<=document.numPages;number++) {
      const page=await document.getPage(number);const data=await page.getTextContent();
      const text=data.items.map((item:any)=>item.str??"").join(" ");if(!text.trim())emptyPages++;
      const index=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if(index>=0) {await send("pdfSearchHit",{bookId,generation,page:number,text:text.slice(Math.max(0,index-45),index+query.length+80)});if(++hits>=500)break;}
      if(number%5===0)void send("pdfSearchProgress",{bookId,generation,page:number,pages:document.numPages});
      page.cleanup();
    }
    await send("pdfSearchEnd",{bookId,generation,emptyPages,pages:document.numPages,truncated:hits>=500});
  }catch(error){await send("pdfSearchEnd",{bookId,generation,error:String(error)});}
  finally {await loadingTask?.destroy();}
}
let bookRenderQueue:Promise<void>=Promise.resolve();
function showBook(url:string,source:string,chapterId:string,highlights:any[],anchor?:any) {
  // Native state may change while PDF.js is opening the previous request.
  // Serialize document replacement so an older completion cannot overwrite a
  // later navigation anchor or destroy the later request's PDF task.
  bookRenderQueue=bookRenderQueue.catch(()=>{}).then(()=>renderBook(url,source,chapterId,highlights,anchor));
  return bookRenderQueue;
}
async function renderBook(url:string,source:string,chapterId:string,highlights:any[],anchor?:any) {
  try {
    renderingBookUrl=url;activeSource=source;pdfObserver?.disconnect();pdfSeek=undefined;pdfSyncToken="";pdfGeneration++;await pdfTask?.destroy();pdfTask=null;currentPdf=null;
    currentBook=(await (await fetch(url)).json()).value;
    currentHighlights=highlights;
    currentChapter=currentBook.chapters.find((chapter:any)=>chapter.id===chapterId)??currentBook.chapters[0];
    if(currentBook.format==="pdf" && currentBook.readerMode==="original") {
      pdfTask=openPdfDocument(new Uint8Array(await (await fetch(source)).arrayBuffer()));currentPdf=await pdfTask.promise;
      pageNumber=Math.max(1,Math.min(currentPdf.numPages,anchor?.pdfAnchor?.page??Math.floor((currentBook.progress?.ratio??0)*currentPdf.numPages)+1));
      const requestedPdfPage=pageNumber;
      await renderPdf();
      if(anchor?.pdfAnchor?.fraction!==undefined)pdfSeek?.(requestedPdfPage,anchor.pdfAnchor.fraction);
    } else {
      content.innerHTML="<h2>"+escape(currentChapter?.title??currentBook.title)+"</h2>"+(currentChapter?.paragraphs??[]).map((p:string,index:number)=> {
        const ranges=highlights.flatMap(h=>(h.sourceRanges??[h]).filter((r:any)=>r.chapterId===currentChapter.id&&r.paraIndex===index&&typeof r.start==="number").map((r:any)=>({...r,id:h.id,style:h.style}))).sort((a,b)=>a.start-b.start);
        const notes=(currentChapter.footnotes??[]).map((n:any,number:number)=>({...n,number})).filter((n:any)=>n.paraIndex===index&&n.start>=0&&n.end<=p.length&&n.end>n.start);
        const boundaries=[...new Set([0,p.length,...ranges.flatMap((r:any)=>[r.start,r.end]),...notes.flatMap((n:any)=>[n.start,n.end])])].sort((a,b)=>Number(a)-Number(b));
        let result="";
        for(let n=0;n<boundaries.length-1;n++){const start=Number(boundaries[n]),end=Number(boundaries[n+1]);if(start<0||end>p.length||end<=start)continue;let text=escape(p.slice(start,end));const note=notes.find((r:any)=>r.start<=start&&r.end>=end);if(note)text=`<sup class="footnote" role="button" aria-label="注释 ${escape(p.slice(note.start,note.end))}" data-footnote="${note.number}">${text}</sup>`;const mark=ranges.find((r:any)=>r.start<=start&&r.end>=end);if(mark)text=`<mark data-highlight="${escape(mark.id)}" style="${highlightStyle(mark.style)}">${text}</mark>`;result+=text;}
        return `<p data-index="${index}">${result}</p>`;
      }).join("");
      status.textContent="";setType(currentBook.typeSettings??{});
      if(anchor?.paraIndex!==undefined) document.querySelector(`[data-index="${anchor.paraIndex}"]`)?.scrollIntoView();
      else {const ratio=anchor?.ratio??currentBook.progress?.ratio??0;if(readerFlow(typeSettings)==="horizontal")content.scrollLeft=(content.scrollWidth-content.clientWidth)*ratio;else content.scrollTop=(content.scrollHeight-content.clientHeight)*ratio;}
    }
    void send("rendered",{bookId:currentBook.id,chapterId:currentChapter?.id,mode:currentBook.readerMode,paragraphs:currentChapter?.paragraphs?.length??0});
  }catch(error){status.textContent=String(error);void send("failure",{error:String(error)});}
}
async function renderPdf() {
  if(!currentPdf)return;
  const generation=++pdfGeneration, documentPdf=currentPdf;
  pdfObserver?.disconnect();content.innerHTML="";content.onscroll=null;
  Object.assign(content.style,{overflowX:pdfReadingLayout==="horizontal"?"auto":"hidden",overflowY:pdfReadingLayout==="horizontal"?"hidden":"auto",height:"calc(100vh - 48px)",padding:"64px 16px 16px",columnCount:"auto",columnWidth:"auto"});
  const pages=document.createElement("div"), double=pdfReadingLayout==="double"&&innerWidth>=720;
  Object.assign(pages.style,{display:double?"grid":"flex",gridTemplateColumns:"1fr 1fr",flexDirection:pdfReadingLayout==="horizontal"?"row":"column",gap:"16px",alignItems:"start"});content.append(pages);
  content.style.scrollSnapType=pdfReadingLayout==="horizontal"?"x mandatory":"none";
  const containers=new Map<number,HTMLElement>(), loaded=new Set<number>(), loading=new Set<number>();
  const width=Math.max(160,double?(innerWidth-48)/2:innerWidth-32);
  for(let number=1;number<=documentPdf.numPages;number++) {
    const page=await documentPdf.getPage(number);if(generation!==pdfGeneration)return;
    const viewport=page.getViewport({scale:width/page.getViewport({scale:1}).width});
    const box=document.createElement("div");box.className="pdf-page";box.dataset.page=String(number);
    Object.assign(box.style,{width:width+"px",height:viewport.height+"px",flexShrink:"0",scrollSnapAlign:"start"});box.style.setProperty("--scale-factor",String(viewport.scale));box.style.setProperty("--total-scale-factor",String(viewport.scale));box.dataset.rotation=String(((page.rotate%360)+360)%360);box.dataset.canonicalHeight=String(1000*(page.view[3]-page.view[1])/(page.view[2]-page.view[0]));
    pages.append(box);containers.set(number,box);
  }
  const draw=async(number:number)=>{
    if(loaded.has(number)||loading.has(number))return;loading.add(number);
    try {
      const box=containers.get(number)!, page=await documentPdf.getPage(number), viewport=page.getViewport({scale:width/page.getViewport({scale:1}).width});
      if(generation!==pdfGeneration)return;
      const canvas=document.createElement("canvas");canvas.width=viewport.width;canvas.height=viewport.height;box.append(canvas);
      await page.render({canvasContext:canvas.getContext("2d")!,canvas,viewport}).promise;if(generation!==pdfGeneration)return;
      const layer=document.createElement("div");layer.className="textLayer";layer.style.pointerEvents=regionMode?"none":"auto";box.append(layer);
      await new pdfjs.TextLayer({textContentSource:await page.getTextContent(),container:layer,viewport}).render();
      for(const quote of currentHighlights.filter(h=>h.pdfAnchor?.page===number))for(const rect of quote.pdfAnchor.rects) {
        const overlay=document.createElement("div");overlay.dataset.highlight=quote.id;const color=swatch(quote.style?.color??"yellow");
        Object.assign(overlay.style,{position:"absolute",left:`${rect.x*100}%`,top:`${rect.y*100}%`,width:`${rect.width*100}%`,height:`${rect.height*100}%`,background:quote.style?.kind==="underline"?"transparent":color.soft,borderBottom:quote.style?.kind==="underline"?`2px solid ${color.solid}`:"none",zIndex:"3"});box.append(overlay);
      }
      loaded.add(number);
    }finally {loading.delete(number);}
  };
  const report=()=>{
    const bounds=content.getBoundingClientRect();let best=pageNumber,distance=Infinity;
    // Anchor to the first visible page, rather than the largest visible area:
    // changing pane height must not advance the saved page to its neighbour.
    for(const [number,box] of containers){const r=box.getBoundingClientRect();const visible=Math.max(0,Math.min(r.right,bounds.right)-Math.max(r.left,bounds.left))*Math.max(0,Math.min(r.bottom,bounds.bottom)-Math.max(r.top,bounds.top));const start=pdfReadingLayout==="horizontal"?r.left-bounds.left:r.top-bounds.top;const d=Math.max(0,start);if(visible>0&&d<distance){distance=d;best=number;}}
    pageNumber=best;const box=containers.get(best)!,r=box.getBoundingClientRect();status.textContent=`${best} / ${documentPdf.numPages}`;
    const position=pdfScrollPosition(best,documentPdf.numPages,pdfReadingLayout==="horizontal"?r.left-bounds.left:r.top-bounds.top,pdfReadingLayout==="horizontal"?r.width:r.height);
    void send("pdfViewport",{...position,syncToken:pdfSyncToken,left:r.left,top:r.top,width:r.width,height:r.height,windowWidth:innerWidth,rotation:Number(box.dataset.rotation),canonicalHeight:Number(box.dataset.canonicalHeight)});
    void send("progressPosition",{chapterId:currentChapter?.id??"",ratio:(best-1)/Math.max(1,documentPdf.numPages)});
    // Keep a bounded raster cache while retaining page placeholders and positions.
    for(const number of loaded)if(Math.abs(number-best)>4){containers.get(number)?.replaceChildren();loaded.delete(number);}
  };
  pdfObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)void draw(Number((entry.target as HTMLElement).dataset.page)).catch(error=>void send("failure",{error:String(error)}));},{root:content,rootMargin:"600px"});
  containers.forEach(box=>pdfObserver!.observe(box));await draw(pageNumber);
  // A phone's full-height view can be taller than several PDF pages that were
  // scaled in a comparison pane. Allow the final page to reach the leading
  // edge, so restoring an earlier anchor is not clamped to the document end.
  const last=containers.get(documentPdf.numPages)!;
  if(pdfReadingLayout!=="horizontal")pages.style.paddingBottom=Math.max(0,content.clientHeight-last.getBoundingClientRect().height)+"px";
  const target=containers.get(pageNumber)!;if(pdfReadingLayout==="horizontal")content.scrollLeft=target.offsetLeft-pages.offsetLeft;else content.scrollTop=target.offsetTop-pages.offsetTop;
  report();content.onscroll=report;
  pdfSeek=(page,fraction)=>{pageNumber=Math.max(1,Math.min(documentPdf.numPages,Math.floor(page)));const box=containers.get(pageNumber)!;
    const r=box.getBoundingClientRect(),bounds=content.getBoundingClientRect();
    if(pdfReadingLayout==="horizontal")content.scrollLeft=pdfScrollOffset(content.scrollLeft+r.left-bounds.left,r.width,fraction);
    else content.scrollTop=pdfScrollOffset(content.scrollTop+r.top-bounds.top,r.height,fraction);
    report();};
}
function setType(settings:any) {
  const anchor=textAnchor();typeSettings=settings;
  content.style.boxSizing="border-box";
  content.style.fontSize=(settings.fontSize??19)+"px";content.style.lineHeight=String(settings.lineHeight??2);
  content.style.padding=`72px ${readingInset(content.clientWidth||innerWidth,settings)}px`;content.style.letterSpacing=(settings.letterSpacing??.02)+"em";
  const themes:any={paper:["#fffdf7","#3d3629"],warm:["#f3ecdf","#4f483e"],green:["#e7efe2","#33402f"],night:["#262019","#cfc2a8"]};const theme=settings.inkMode?["#ffffff","#000000"]:(themes[settings.themeId]??themes.warm);
  document.body.style.background=theme[0];document.body.style.color=theme[1];
  const fonts:any={song:"ShufangSong,serif",hei:"sans-serif",kai:"ShufangKai,serif",fangsong:"ShufangFangSong,serif",yuan:"ShufangYuan,sans-serif",xihei:"sans-serif","latin-serif":"serif","latin-sans":"sans-serif"};
  content.style.fontFamily=fonts[settings.fontId]??"ShufangSong,serif";content.style.fontWeight=String(settings.fontWeight??400);
  content.querySelectorAll("p").forEach(p=>{p.style.marginBottom=(settings.paragraphSpacing??.4)+"em";});
  const flow=readerFlow(settings),paged=flow!=="scroll";
  content.style.height="calc(100vh - 32px)";content.style.width="100%";
  const gap=36,padding=readingInset(content.clientWidth||innerWidth,settings),columns=Math.min(2,settings.columns??1);
  content.style.columnWidth=flow==="horizontal"?Math.max(80,(content.clientWidth-2*padding-(columns-1)*gap)/columns)+"px":"auto";
  content.style.columnGap=gap+"px";content.style.columnCount=flow==="horizontal"?String(columns):"auto";
  content.style.columnFill="auto";content.style.overflowX=flow==="horizontal"?"auto":"hidden";content.style.overflowY=flow==="horizontal"?"hidden":"auto";
  content.style.scrollSnapType=paged?(flow==="horizontal"?"x mandatory":"y proximity"):"none";
  if(anchor)requestAnimationFrame(()=>content.querySelector(`[data-index="${anchor.paraIndex}"]`)?.scrollIntoView({block:"start",inline:"start"}));
}
function turnPage(delta:number) {
  if(currentPdf&&currentBook.readerMode==="original") {const next=pageNumber+delta*(pdfReadingLayout==="double"&&innerWidth>=720?2:1);if(next>=1&&next<=currentPdf.numPages){pageNumber=next;void renderPdf();}return;}
  const horizontal=readerFlow(typeSettings)==="horizontal";
  const position=horizontal?content.scrollLeft:content.scrollTop,maximum=horizontal?content.scrollWidth-content.clientWidth:content.scrollHeight-content.clientHeight;
  if((delta>0&&position>=maximum-2)||(delta<0&&position<=2)){void send("chapterTurn",{delta});return;}
  const animated=!typeSettings.inkMode&&typeSettings.pageEffect!=="none"&&!matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(animated&&typeSettings.pageEffect==="fade")content.animate([{opacity:.4},{opacity:1}],{duration:180});
  content.scrollBy({left:horizontal?delta*content.clientWidth:0,top:horizontal?0:delta*content.clientHeight,behavior:animated&&typeSettings.pageEffect!=="fade"?"smooth":"instant" as ScrollBehavior});
}
function showTranslation(text:string) {
  const previous=content.querySelector(".bilingual-view");
  if(previous) {const source=previous.querySelector(".bilingual-source")!;const nodes=Array.from(source.childNodes);previous.replaceWith(...nodes);}
  if(!text)return;
  const pair=document.createElement("div");pair.className="bilingual-view";
  const source=document.createElement("section");source.className="bilingual-source";
  while(content.firstChild)source.append(content.firstChild);
  const translation=document.createElement("section");translation.className="translation";
  const title=document.createElement("h2");title.textContent="译文";translation.append(title);
  for(const paragraph of text.split(/\n+/).filter(Boolean)){const p=document.createElement("p");p.textContent=paragraph;translation.append(p);}
  Object.assign(pair.style,{display:"grid",gridTemplateColumns:innerWidth>=600?"1fr 1fr":"1fr",gap:"24px",alignItems:"start"});
  pair.append(source,translation);content.append(pair);
}
document.addEventListener("selectionchange",()=> {
  const selection=getSelection();if(!selection?.rangeCount||selection.isCollapsed||!currentBook){void send("selectionState",{active:false});return;}
  if((selection.anchorNode?.parentElement)?.closest(".footnote-popup"))return;
  void send("selectionState",{active:true});
  const range=selection.getRangeAt(0);const text=selection.toString().trim();if(!text)return;
  if(currentPdf && currentBook.readerMode==="original") {
    const page=pdfSelectionPage(range);if(!page)return;const selectedPage=Number(page.dataset.page);const bounds=page.getBoundingClientRect();
    const rects=Array.from(range.getClientRects()).map(r=>{const x=Math.max(0,Math.min(1,(r.x-bounds.x)/bounds.width));const y=Math.max(0,Math.min(1,(r.y-bounds.y)/bounds.height));return{x,y,width:Math.max(0,Math.min(1-x,r.width/bounds.width)),height:Math.max(0,Math.min(1-y,r.height/bounds.height))};}).filter(r=>r.width>0&&r.height>0);
    void send("selection",{anchor:{kind:"pdf",bookId:currentBook.id,chapterId:currentChapter?.id??"",chapterTitle:`第 ${selectedPage} 页`,text,pdfAnchor:{page:selectedPage,rects}}});return;
  }
  const segments=[];
  for(const p of Array.from(content.querySelectorAll("p[data-index]"))) {
    if(!range.intersectsNode(p))continue;
    const full=p.textContent??"";const local=document.createRange();local.selectNodeContents(p);
    if(p.contains(range.startContainer))local.setStart(range.startContainer,range.startOffset);
    if(p.contains(range.endContainer))local.setEnd(range.endContainer,range.endOffset);
    const prefix=document.createRange();prefix.selectNodeContents(p);prefix.setEnd(local.startContainer,local.startOffset);
    const selected=local.toString();if(!selected)continue;
    const start=prefix.toString().length;segments.push({kind:"text",bookId:currentBook.id,chapterId:currentChapter.id,chapterTitle:currentChapter.title,text:selected,paraIndex:Number(p.getAttribute("data-index")),start,end:Math.min(full.length,start+selected.length)});
  }
  if(segments.length)void send("selection",{anchor:segments[0],segments});
});
content.addEventListener("click",event=>{if(regionMode)return;
  const target=event.target as Element;
  const note=target.closest("[data-footnote]");
  if(note){const data=currentChapter.footnotes[Number(note.getAttribute("data-footnote"))];document.querySelector(".footnote-popup")?.remove();const popup=document.createElement("section");popup.className="footnote-popup";popup.setAttribute("role","dialog");const close=document.createElement("button");close.textContent="关闭注释";close.onclick=()=>{popup.remove();footnoteOpen=false;void send("panelState",{active:false});};const text=document.createElement("p");text.textContent=data.content??data.text??"";popup.append(close,text);document.body.append(popup);footnoteOpen=true;void send("panelState",{active:true});return;}
  const id=target.closest("[data-highlight]")?.getAttribute("data-highlight");const quote=currentHighlights.find(h=>h.id===id);if(quote){void send("selection",{anchor:quote});return;}
  if(footnoteOpen||target.closest("button")||getSelection()?.toString())return;
  const rect=content.getBoundingClientRect(),flow=readerFlow(typeSettings);const fraction=flow==="vertical"?((event as MouseEvent).clientY-rect.top)/rect.height:((event as MouseEvent).clientX-rect.left)/rect.width;
  if(flow!=="scroll"&&fraction<.25)turnPage(-1);else if(flow!=="scroll"&&fraction>.75)turnPage(1);else void send("toggleControls");
});
let gestureStart:{x:number,y:number,selected:boolean}|null=null;let suppressClickUntil=0;
content.addEventListener("pointerdown",event=>{if(event.pointerType==="pen"||regionMode||currentPdf)return;gestureStart={x:event.clientX,y:event.clientY,selected:!!getSelection()?.toString()};});
content.addEventListener("pointerup",event=>{if(!gestureStart)return;const delta=gestureTurn(readerFlow(typeSettings),event.clientX-gestureStart.x,event.clientY-gestureStart.y,gestureStart.selected||!!getSelection()?.toString()||footnoteOpen);gestureStart=null;if(delta){suppressClickUntil=performance.now()+400;turnPage(delta);}});
content.addEventListener("click",event=>{if(performance.now()<suppressClickUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
let resizeTimer:number;window.addEventListener("resize",()=>{clearTimeout(resizeTimer);resizeTimer=window.setTimeout(()=>{if(currentPdf)void renderPdf();else setType(typeSettings);},100);});
let scrollTimer:number;
function positionChanged(){clearTimeout(scrollTimer);scrollTimer=window.setTimeout(()=> {if(currentBook&&currentChapter&&currentBook.readerMode!=="original") {
  const ratio=readerFlow(typeSettings)==="horizontal"?content.scrollLeft/Math.max(1,content.scrollWidth-content.clientWidth):content.scrollTop/Math.max(1,content.scrollHeight-content.clientHeight);
  void send("progressPosition",{chapterId:currentChapter.id,ratio:Math.max(0,Math.min(1,ratio))});
}},700);}
window.addEventListener("scroll",positionChanged);content.addEventListener("scroll",positionChanged);
window.shufang={importFile,showBook,setType,showTranslation,turnPage,searchPdf} as any;void send("ready");

let fileQueue=Promise.resolve();
async function sendFile(bytes:Uint8Array,purpose:string,page?:number){
  const task=fileQueue.then(async()=>{await send("fileBegin");for(let offset=0;offset<bytes.length;offset+=60*1024){const chunk=bytes.subarray(offset,offset+60*1024);let text="";for(const byte of chunk)text+=String.fromCharCode(byte);await send("fileChunk",{base64:btoa(text)});}await send("fileEnd",{purpose,page});});
  fileQueue=task.catch(()=>undefined);await task;
}
async function ocrPage(){if(!currentPdf)throw new Error("请先打开 PDF 原版");const page=await currentPdf.getPage(pageNumber);const v=page.getViewport({scale:Math.min(3,2048/page.getViewport({scale:1}).width)});const canvas=document.createElement("canvas");canvas.width=v.width;canvas.height=v.height;await page.render({canvasContext:canvas.getContext("2d")!,canvas,viewport:v}).promise;const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),"image/png"));await sendFile(new Uint8Array(await blob.arrayBuffer()),"ocr",pageNumber);}
async function exportPdf(inkPages:any[]){try{const pdf=await PDFDocument.load(await (await fetch(activeSource)).arrayBuffer());const pages=pdf.getPages();for(let i=0;i<pages.length;i++){const page=pages[i],box=page.getCropBox(),rotation=((page.getRotation().angle%360)+360)%360;
  for(const quote of currentHighlights.filter(h=>h.pdfAnchor?.page===i+1))for(const rect of quote.pdfAnchor.rects){const geometry=pdfRectGeometry(rect,box,rotation);const hex=swatch(quote.style?.color??"yellow").solid.replace("#","");const color=rgb(parseInt(hex.slice(0,2),16)/255,parseInt(hex.slice(2,4),16)/255,parseInt(hex.slice(4,6),16)/255);if(quote.style?.kind==="underline")page.drawLine({start:geometry.line[0],end:geometry.line[1],color,thickness:1.5,opacity:1});else page.drawRectangle({x:geometry.x,y:geometry.y,width:geometry.width,height:geometry.height,color,opacity:.25});}
  const data=inkPages.find(item=>item.page===i+1);if(data?.ink){const ink=data.ink;for(const stroke of ink.strokes){if(stroke.points.length===1){const point=stroke.points[0];page.drawCircle({x:box.x+point.x/1000*box.width,y:box.y+(1-point.y/ink.height)*box.height,size:stroke.width*(.3+.7*point.pressure)/2000*box.width,color:rgb(...stroke.color.slice(0,3) as [number,number,number]),opacity:stroke.color[3]});}for(let n=1;n<stroke.points.length;n++){const a=stroke.points[n-1],b=stroke.points[n];page.drawLine({start:{x:box.x+a.x/1000*box.width,y:box.y+(1-a.y/ink.height)*box.height},end:{x:box.x+b.x/1000*box.width,y:box.y+(1-b.y/ink.height)*box.height},thickness:stroke.width*(.3+.7*b.pressure)/1000*box.width,color:rgb(...stroke.color.slice(0,3) as [number,number,number]),opacity:stroke.color[3]});}}}
  else if(data?.preview){const image=await pdf.embedPng(await (await fetch(data.preview)).arrayBuffer());page.drawImage(image,{x:box.x,y:box.y,width:box.width,height:box.height});}}
  await sendFile(await pdf.save(),"annotatedPdf");}catch(error){void send("failure",{error:String(error)});}}
function pdfPage(page:number){if(!currentPdf)return;pdfSyncToken="";pdfSeek?.(page,0);}
function pdfPosition(page:number,fraction:number,token:string){if(!Number.isFinite(page)||!Number.isFinite(fraction)||typeof token!=="string")return;pdfSyncToken=token;pdfSeek?.(page,fraction);}
function pdfLayout(layout:string){if(!["vertical","horizontal","double"].includes(layout))return;pdfReadingLayout=layout;void renderPdf();}
function pdfRegion(enabled:boolean){regionMode=enabled;document.querySelectorAll<HTMLElement>(".textLayer").forEach(layer=>layer.style.pointerEvents=enabled?"none":"auto");}
async function pdfThumbnails(){if(!currentPdf)return;const dialog=document.createElement("section");dialog.className="footnote-popup";const close=document.createElement("button");close.textContent="关闭缩略图";close.onclick=()=>dialog.remove();dialog.append(close);document.body.append(dialog);for(let i=1;i<=currentPdf.numPages;i++){if(!dialog.isConnected)break;const page=await currentPdf.getPage(i),v=page.getViewport({scale:160/page.getViewport({scale:1}).width}),canvas=document.createElement("canvas");canvas.width=v.width;canvas.height=v.height;await page.render({canvasContext:canvas.getContext("2d")!,canvas,viewport:v}).promise;const button=document.createElement("button");button.setAttribute("aria-label",`第 ${i} 页`);button.append(canvas,document.createTextNode(String(i)));button.onclick=()=>{pdfPage(i);dialog.remove();};dialog.append(button);}}
let regionStart:{x:number,y:number}|null=null;
content.addEventListener("pointerdown",event=>{if(regionMode&&currentPdf){regionStart={x:event.clientX,y:event.clientY};content.setPointerCapture(event.pointerId);}});
content.addEventListener("pointerup",event=>{if(!regionStart||!currentPdf)return;const page=Array.from(document.querySelectorAll<HTMLElement>(".pdf-page")).find(p=>{const r=p.getBoundingClientRect();return regionStart!.x>=r.left&&regionStart!.x<=r.right&&regionStart!.y>=r.top&&regionStart!.y<=r.bottom;});if(!page){regionStart=null;return;}const selectedPage=Number(page.dataset.page),r=page.getBoundingClientRect();const x=Math.max(0,Math.min(1,(Math.min(regionStart.x,event.clientX)-r.x)/r.width)),y=Math.max(0,Math.min(1,(Math.min(regionStart.y,event.clientY)-r.y)/r.height));const rect={x,y,width:Math.min(1-x,Math.abs(event.clientX-regionStart.x)/r.width),height:Math.min(1-y,Math.abs(event.clientY-regionStart.y)/r.height)};regionStart=null;suppressClickUntil=performance.now()+400;pdfRegion(false);if(rect.width>.005&&rect.height>.005)void send("selection",{anchor:{kind:"pdf",bookId:currentBook.id,chapterId:currentChapter?.id??"",chapterTitle:`第 ${selectedPage} 页`,text:"区域摘录",pdfAnchor:{page:selectedPage,rects:[rect]}}});});
Object.assign(window.shufang,{ocrPage,exportPdf,pdfPage,pdfPosition,pdfLayout,pdfRegion,pdfThumbnails});
