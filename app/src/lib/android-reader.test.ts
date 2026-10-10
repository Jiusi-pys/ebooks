import {describe,it,expect} from "vitest";
import {readerFlow,gestureTurn,readingInset} from "../../../platforms/android/web/reader-layout";

describe("Android reader matches iOS navigation",()=>{
  it("distinguishes vertical pages from continuous scrolling and retains old settings",()=>{
    expect(readerFlow({readingFlow:"vertical"})).toBe("vertical");
    expect(readerFlow({readingFlow:"scroll"})).toBe("scroll");
    expect(readerFlow({pageTurnMode:"vertical"})).toBe("scroll");
    expect(readerFlow({})).toBe("horizontal");
  });
  it("ignores diagonal, short and selection drags",()=>{
    expect(gestureTurn("horizontal",-100,10,false)).toBe(1);
    expect(gestureTurn("vertical",10,100,false)).toBe(-1);
    expect(gestureTurn("horizontal",100,100,false)).toBe(0);
    expect(gestureTurn("horizontal",-100,0,true)).toBe(0);
    expect(gestureTurn("scroll",0,-100,false)).toBe(0);
    expect(gestureTurn("horizontal",20,0,false)).toBe(0);
  });
  it("uses the actual reading viewport for width and bounds legacy padding",()=>{
    expect(readingInset(1000,{readingWidthPercent:92})).toBe(40);
    expect(readingInset(320,{readingWidthPercent:50})).toBe(80);
    expect(readingInset(320,{pageMargin:480})).toBeLessThan(120);
  });
});
