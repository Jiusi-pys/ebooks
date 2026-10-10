import clone from "core-js-pure/actual/structured-clone";
import replaceAll from "core-js-pure/actual/string/virtual/replace-all";
import matchAll from "core-js-pure/actual/string/virtual/match-all";
if(!String.prototype.replaceAll)Object.defineProperty(String.prototype,"replaceAll",{configurable:true,writable:true,value:replaceAll});
if(!String.prototype.matchAll)Object.defineProperty(String.prototype,"matchAll",{configurable:true,writable:true,value:matchAll});
if(typeof Blob!=="undefined"&&!Blob.prototype.arrayBuffer)Object.defineProperty(Blob.prototype,"arrayBuffer",{configurable:true,writable:true,value:function(this:Blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(this);});}});
if(typeof Blob!=="undefined"&&!Blob.prototype.text)Object.defineProperty(Blob.prototype,"text",{configurable:true,writable:true,value:function(this:Blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsText(this,"UTF-8");});}});
// Injected into both the reader and its worker; native implementations retain precedence.
const structuredClone = typeof globalThis.structuredClone === "function" ? globalThis.structuredClone : clone;
export { structuredClone };
