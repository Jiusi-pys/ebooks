// Offsets match the shared model's UTF-16 contract, including emoji.
export function serialDispatch(onError) {
  let pending = Promise.resolve();
  return action => { pending = pending.then(action).catch(onError); return pending; };
}
export function markedSegments(text, marks) {
  const boundary = i => i === 0 || i === text.length || !(text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff && text.charCodeAt(i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff);
  const ranges = marks.filter(h => Number.isInteger(h.start) && Number.isInteger(h.end) && h.start >= 0 && h.end <= text.length && h.end > h.start && boundary(h.start) && boundary(h.end) && text.slice(h.start, h.end) === h.text).sort((a,b)=>a.start-b.start);
  const merged = [];
  for (const r of ranges) { const last = merged.at(-1); if (last && r.start <= last.end) last.end = Math.max(last.end, r.end); else merged.push({start:r.start,end:r.end}); }
  const result = []; let offset = 0;
  for (const r of merged) { if (r.start > offset) result.push({text:text.slice(offset,r.start),marked:false}); result.push({text:text.slice(r.start,r.end),marked:true}); offset=r.end; }
  if (offset < text.length || !result.length) result.push({text:text.slice(offset),marked:false});
  return result;
}
