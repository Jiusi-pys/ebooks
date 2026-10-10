type Rect={x:number;y:number;width:number;height:number};
type Point={x:number;y:number};
export function pdfRectGeometry(rect:Rect,box:Rect,rotation:number):Rect&{line:[Point,Point]} {
  if(![rect.x,rect.y,rect.width,rect.height,box.x,box.y,box.width,box.height].every(Number.isFinite)||rect.x<0||rect.y<0||rect.width<=0||rect.height<=0||rect.x+rect.width>1.000001||rect.y+rect.height>1.000001||box.width<=0||box.height<=0||![0,90,180,270].includes(rotation))throw new Error("invalid_pdf_annotation_geometry");
  const point=(x:number,y:number):Point=>{
    const [a,b]=rotation===90?[y,1-x]:rotation===180?[1-x,1-y]:rotation===270?[1-y,x]:[x,y];
    return {x:box.x+a*box.width,y:box.y+(1-b)*box.height};
  };
  const first=point(rect.x,rect.y),last=point(rect.x+rect.width,rect.y+rect.height);
  return {x:Math.min(first.x,last.x),y:Math.min(first.y,last.y),width:Math.abs(last.x-first.x),height:Math.abs(last.y-first.y),line:[point(rect.x,rect.y+rect.height),point(rect.x+rect.width,rect.y+rect.height)]};
}
