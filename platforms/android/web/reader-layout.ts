export type ReadingFlow="horizontal"|"vertical"|"scroll";
export function readerFlow(settings:any):ReadingFlow {
  if(["horizontal","vertical","scroll"].includes(settings.readingFlow))return settings.readingFlow;
  return settings.pageTurnMode==="vertical"?"scroll":"horizontal";
}
export function gestureTurn(flow:ReadingFlow,dx:number,dy:number,selection:boolean):number {
  if(selection||flow==="scroll")return 0;
  const primary=flow==="horizontal"?dx:dy,secondary=flow==="horizontal"?dy:dx;
  if(Math.abs(primary)<48||Math.abs(primary)<Math.abs(secondary)*1.5)return 0;
  return primary<0?1:-1;
}
export function readingInset(width:number,settings:any):number {
  const percent=settings.readingWidthPercent;
  if(typeof percent==="number"&&Number.isFinite(percent))return width*(100-Math.max(50,Math.min(100,percent)))/200;
  if(typeof settings.pageMargin==="number")return Math.max(0,Math.min(width*.35,settings.pageMargin));
  return width*.04;
}
