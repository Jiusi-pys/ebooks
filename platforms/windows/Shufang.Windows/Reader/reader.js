import { markedSegments, serialDispatch } from "./anchors.mjs";
import { matchingChapter, localImage } from "./rendition.mjs";
import * as pdfjs from "./vendor/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.mjs";
let book, pdf, chapterIndex = 0, timer, generation = 0, original = false, highlights = [], translations = [];
const content = document.getElementById("content"), chapters = document.getElementById("chapters");
let preferences={fontSize:20,dark:false,lineHeight:1.9};
let rendition=null, outline=[];
const outlineSelect=document.getElementById("outline");
function showOutline() { outlineSelect.replaceChildren(); outline.forEach(entry=>{const option=document.createElement("option");option.value=entry.id;option.textContent="　".repeat(entry.depth??0)+entry.title;outlineSelect.append(option);}); }
async function openLink(link) {
  const target=rendition?.targets?.[link.target];if(!target)return;
  if(!link.footnote&&target.chapterId){await jump(target);return;}
  const origin={chapterId:book.chapters[chapterIndex].id,paraIndex:link.paraIndex};
  document.getElementById("footnote")?.remove();
  const panel=document.createElement("aside"),text=document.createElement("p"),back=document.createElement("button");panel.id="footnote";panel.setAttribute("role","dialog");panel.setAttribute("aria-label","脚注");text.textContent=target.text;back.textContent="返回正文";back.onclick=()=>guard(async()=>{panel.remove();await jump(origin);});panel.append(text,back);content.append(panel);panel.scrollIntoView({block:"center"});back.focus();
}
const applyPreferences=()=>{content.style.fontSize=preferences.fontSize+"px";content.style.lineHeight=preferences.lineHeight;document.body.classList.toggle("dark",!!preferences.dark);document.getElementById("size").value=preferences.fontSize;document.getElementById("spacing").value=preferences.lineHeight;};
const savePreferences=()=>{applyPreferences();send({type:"preferences",value:preferences});};
const send = value => window.chrome.webview.postMessage(value);
const guard = action => Promise.resolve().then(action).catch(error => {content.textContent = `阅读器：${error.message}`; send({type:"error",message:error.message});});
const dispatch = serialDispatch(error => {content.textContent = `阅读器：${error.message}`;send({type:"error",message:error.message});});
function progress() { if(book)send({type:"progress",bookId:book.id,chapterId:book.chapters[chapterIndex]?.id,ratio:Math.max(0,Math.min(1,scrollY/Math.max(1,document.documentElement.scrollHeight-innerHeight)))}); }
async function render() {
  const version=++generation, chapter=book?.chapters?.[chapterIndex];
  content.replaceChildren(); if(!chapter)return; chapters.value=String(chapterIndex);
  if(original && pdf) {
    const page=await pdf.getPage(chapterIndex+1); if(version!==generation)return;
    const base=page.getViewport({scale:1}), scale=Math.min(2,Math.max(0.5,(content.clientWidth-72)/base.width));
    const viewport=page.getViewport({scale});
    const host=document.createElement("div");host.className="pdf-page";host.style.width=`${viewport.width}px`;host.style.height=`${viewport.height}px`;
    host.style.setProperty("--scale-factor",scale);host.style.setProperty("--total-scale-factor",scale);host.style.setProperty("--user-unit",1);
    const canvas=document.createElement("canvas"),layer=document.createElement("div");layer.className="textLayer";
    canvas.width=Math.ceil(viewport.width*devicePixelRatio);canvas.height=Math.ceil(viewport.height*devicePixelRatio);canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`;
    host.append(canvas,layer);content.append(host);
    await page.render({canvasContext:canvas.getContext("2d"),viewport,transform:[devicePixelRatio,0,0,devicePixelRatio,0,0]}).promise;
    const text=await page.getTextContent(); if(version!==generation)return;
    await new pdfjs.TextLayer({textContentSource:text,container:layer,viewport}).render();
    layer.style.width=`${viewport.width}px`;layer.style.height=`${viewport.height}px`;
    for(const h of highlights.filter(h=>h.chapterId===chapter.id)) for(const r of h.pdfAnchor?.rects??[]) {const mark=document.createElement("div");mark.className="pdf-mark";Object.assign(mark.style,{left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`});host.append(mark);}
  } else {
    const title=document.createElement("h1");title.textContent=chapter.title;content.append(title);
    const enhanced=matchingChapter(chapter,rendition);
    const pictures=index=>{for(const item of enhanced?.images?.filter(i=>i.beforeParagraph===index)??[]){if(!localImage(item.src))continue;const figure=document.createElement("figure"),image=document.createElement("img"),caption=document.createElement("figcaption");image.src=item.src;image.alt=item.alt??"";image.loading="lazy";caption.textContent=item.alt??"";figure.append(image,caption);content.append(figure);}};
    chapter.paragraphs.forEach((text,index)=>{const p=document.createElement("p");p.dataset.paragraph=String(index);for (const segment of markedSegments(text, highlights.filter(h=>h.chapterId===chapter.id&&h.paraIndex===index))) { const node=document.createElement(segment.marked?"mark":"span");node.textContent=segment.text;p.append(node); }
      pictures(index);content.append(p);for(const link of enhanced?.links?.filter(l=>l.paraIndex===index)??[]){if(!rendition?.targets?.[link.target])continue;const button=document.createElement("button");button.textContent=(link.footnote?"脚注：":"跳转：")+(link.label||"阅读");button.onclick=()=>guard(()=>openLink(link));content.append(button);}});
    pictures(chapter.paragraphs.length);
  }
  for (const t of translations.filter(t=>t.chapterId===chapter.id)) { const details=document.createElement("details"), summary=document.createElement("summary"), text=document.createElement("p");summary.textContent="译文 · "+t.targetLang;text.textContent=t.text;details.append(summary,text);content.append(details); }
  if(version!==generation)return;window.scrollTo(0,0);send({type:"rendered",bookId:book.id});progress();
}
async function jump(anchor) {
  const index=book.chapters.findIndex(c=>c.id===anchor.chapterId);if(index<0)return;
  if(index!==chapterIndex){chapterIndex=index;await render();}
  const paragraph=content.querySelector(`[data-paragraph="${Number(anchor.paraIndex)||0}"]`);
  paragraph?.scrollIntoView({block:"center"});paragraph?.classList.add("flash");
  if(original&&anchor.pdfAnchor?.rects?.length){const r=anchor.pdfAnchor.rects[0],host=content.querySelector(".pdf-page");window.scrollTo(0,host.offsetTop+r.y*host.clientHeight-100);}
}
window.chrome.webview.addEventListener("message",({data})=>dispatch(async()=>{
  if(data.type==="preferences"){preferences={...preferences,...data.value};applyPreferences();}
  else if(data.type==="book") {
    ++generation;if(pdf){await pdf.destroy();pdf=null;} book=data.book;rendition=data.rendition;outline=data.outline??[];showOutline();highlights=data.highlights??[];translations=data.translations??[];chapters.replaceChildren();
    book.chapters.forEach((chapter,index)=>{const option=document.createElement("option");option.value=String(index);option.textContent=chapter.title;chapters.append(option);});
    original=book.format==="pdf"&&book.readerMode!=="reflow";document.getElementById("mode").hidden=book.format!=="pdf";
    if(book.format==="pdf")pdf=await pdfjs.getDocument({url:"https://resource.shufang.local/original.pdf",cMapUrl:"./vendor/cmaps/",cMapPacked:true,standardFontDataUrl:"./vendor/standard_fonts/",isEvalSupported:false,enableXfa:false}).promise;
    chapterIndex=Math.max(0,book.chapters.findIndex(c=>c.id===book.progress?.chapterId));const ratio=book.progress?.ratio??0;await render();
    requestAnimationFrame(()=>window.scrollTo(0,Math.max(0,document.documentElement.scrollHeight-innerHeight)*ratio));
  }else if(data.type==="jump"&&book)await jump(data.anchor);
  else if(data.type==="highlights"){const y=scrollY;highlights=data.highlights;await render();window.scrollTo(0,y);}
  else if(data.type==="outline"){outline=data.outline;showOutline();}
}));
chapters.onchange=()=>guard(async()=>{chapterIndex=Number(chapters.value);await render();});
document.getElementById("previous").onclick=()=>guard(async()=>{if(chapterIndex>0){chapterIndex--;await render();}});
document.getElementById("next").onclick=()=>guard(async()=>{if(book&&chapterIndex+1<book.chapters.length){chapterIndex++;await render();}});
document.getElementById("size").onchange=e=>{preferences.fontSize=Number(e.target.value);savePreferences();};
document.getElementById("theme").onclick=()=>{preferences.dark=!preferences.dark;savePreferences();};
document.getElementById("mode").onclick=()=>guard(async()=>{original=!original;send({type:"readerMode",bookId:book.id,mode:original?"original":"reflow"});await render();});
document.addEventListener("mouseup",()=>{
  const selection=getSelection();if(!selection||selection.isCollapsed||!book||!content.contains(selection.anchorNode))return;
  const range=selection.getRangeAt(0),text=selection.toString(),chapter=book.chapters[chapterIndex];if(!text||text.length>32000)return;
  if(original){const host=content.querySelector(".pdf-page"),box=host?.getBoundingClientRect();if(!box||!host.contains(range.endContainer))return;
    const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>({x:Math.max(0,(r.left-box.left)/box.width),y:Math.max(0,(r.top-box.top)/box.height),width:Math.min(1,r.width/box.width),height:Math.min(1,r.height/box.height)}));
    send({type:"selection",anchor:{kind:"pdf",bookId:book.id,chapterId:chapter.id,chapterTitle:chapter.title,text,pdfAnchor:{page:chapterIndex+1,rects}}});return;
  }
  const p=range.startContainer.parentElement?.closest("p[data-paragraph]");if(!p||!p.contains(range.endContainer))return;
  const prefix=range.cloneRange();prefix.selectNodeContents(p);prefix.setEnd(range.startContainer,range.startOffset);const start=prefix.toString().length;
  send({type:"selection",anchor:{kind:"text",bookId:book.id,chapterId:chapter.id,chapterTitle:chapter.title,text,paraIndex:Number(p.dataset.paragraph),start,end:start+text.length}});
});
window.addEventListener("scroll",()=>{clearTimeout(timer);timer=setTimeout(progress,500);});

document.getElementById("spacing").onchange=e=>{preferences.lineHeight=Number(e.target.value);savePreferences();};
document.getElementById("find").onchange=e=>{const term=e.target.value.trim();if(!term||!book)return;const index=book.chapters.findIndex(c=>c.paragraphs.some(p=>p.includes(term)));if(index>=0)guard(async()=>{chapterIndex=index;await render();const p=[...content.querySelectorAll("p")].find(p=>p.textContent.includes(term));p?.scrollIntoView({block:"center"});p?.classList.add("flash");});};
outlineSelect.onchange=()=>guard(()=>jump(outline.find(e=>e.id===outlineSelect.value)));
for(const button of document.querySelectorAll("[data-outline-action]"))button.onclick=()=>send({type:"outlineEdit",action:button.dataset.outlineAction,entry:outlineSelect.value,title:document.getElementById("outlineTitle").value.trim()});
