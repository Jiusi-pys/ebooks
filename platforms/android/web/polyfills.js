// Android System WebView versions lack newer standard methods used by
// the repository's pinned PDF.js. Install only missing standard operations.
if(typeof globalThis === "undefined") {if(typeof window!=="undefined")window.globalThis=window;else self.globalThis=self;}
if(typeof window!=="undefined"&&!window.ShufangBridge&&window.ShufangLegacyBridge)window.ShufangBridge={postMessage(value){window.ShufangLegacyBridge.postMessage(value);},onmessage(){}};
if(globalThis.crypto&&!globalThis.crypto.randomUUID)globalThis.crypto.randomUUID=function(){const bytes=new Uint8Array(16);globalThis.crypto.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,"0"));return hex.slice(0,4).join("")+"-"+hex.slice(4,6).join("")+"-"+hex.slice(6,8).join("")+"-"+hex.slice(8,10).join("")+"-"+hex.slice(10).join("");};
if(!Object.fromEntries)Object.fromEntries=function(entries){const result={};for(const [key,value] of entries)Object.defineProperty(result,key,{value,writable:true,enumerable:true,configurable:true});return result;};
if(!Object.hasOwn)Object.hasOwn=function(value,key){return Object.prototype.hasOwnProperty.call(value,key);};
if(!Promise.allSettled)Promise.allSettled=function(values){return Promise.all(Array.from(values,value=>Promise.resolve(value).then(value=>({status:"fulfilled",value}),reason=>({status:"rejected",reason}))));};
for(const Type of [Array,String])if(!Type.prototype.at)Object.defineProperty(Type.prototype,"at",{configurable:true,writable:true,value:function(index){index=Math.trunc(index)||0;if(index<0)index+=this.length;return index<0||index>=this.length?undefined:this[index];}});
for (const Type of [Map, WeakMap]) {
  if (!Type.prototype.getOrInsertComputed) Type.prototype.getOrInsertComputed = function (key, callback) {
    if (this.has(key)) return this.get(key);
    const value = callback(key);this.set(key, value);return value;
  };
  if (!Type.prototype.getOrInsert) Type.prototype.getOrInsert = function (key, value) {
    if (this.has(key)) return this.get(key);this.set(key, value);return value;
  };
}
if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype.values = async function* (options = {}) {
    const reader = this.getReader();let complete = false;
    try {
      while (true) {const item = await reader.read();if (item.done) {complete = true;return;}yield item.value;}
    } finally {
      try {if (!complete && !options.preventCancel) await reader.cancel();}
      finally {reader.releaseLock();}
    }
  };
  ReadableStream.prototype[Symbol.asyncIterator] = ReadableStream.prototype.values;
}
if (typeof globalThis.Iterator === "undefined") {
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  globalThis.Iterator = function Iterator() { throw new TypeError("Iterator is abstract"); };
  globalThis.Iterator.prototype = prototype;
  globalThis.Iterator.from = function (value) { return value[Symbol.iterator] ? value[Symbol.iterator]() : value; };
}
const iteratorPrototype = globalThis.Iterator.prototype;
if (!iteratorPrototype.toArray) iteratorPrototype.toArray = function () { return [...this]; };
if (!iteratorPrototype.filter) iteratorPrototype.filter = function* (predicate) { let index=0; for (const value of this) if (predicate(value,index++)) yield value; };
if (!iteratorPrototype.map) iteratorPrototype.map = function* (transform) { let index=0; for (const value of this) yield transform(value,index++); };
if (!Array.prototype.toSorted) Object.defineProperty(Array.prototype,"toSorted",{configurable:true,writable:true,value:function (compare) { return this.slice().sort(compare); }});
if (!Array.prototype.toReversed) Object.defineProperty(Array.prototype,"toReversed",{configurable:true,writable:true,value:function () { return this.slice().reverse(); }});
if (!Promise.withResolvers) Promise.withResolvers = function () {
  let resolve, reject;
  const promise = new this((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
if (!Promise.try) Promise.try = function (callback, ...args) {
  return new this(resolve => resolve(callback(...args)));
};
if (!Uint8Array.prototype.toHex) Uint8Array.prototype.toHex = function () {
  return Array.from(this, byte => byte.toString(16).padStart(2, "0")).join("");
};
if (!Uint8Array.fromHex) Uint8Array.fromHex = function (text) {
  if (typeof text !== "string" || text.length % 2 || !/^[0-9a-f]*$/i.test(text)) throw new SyntaxError("Invalid hex");
  return Uint8Array.from(text.match(/../g) || [], pair => parseInt(pair, 16));
};
if (!Uint8Array.prototype.toBase64) Uint8Array.prototype.toBase64 = function (options = {}) {
  let text = "";
  for (let start = 0; start < this.length; start += 8192) text += String.fromCharCode(...this.subarray(start, start + 8192));
  let result = btoa(text);
  if (options.alphabet === "base64url") result = result.replace(/\+/g, "-").replace(/\//g, "_");
  return options.omitPadding ? result.replace(/=+$/, "") : result;
};
if (!Uint8Array.fromBase64) Uint8Array.fromBase64 = function (text) {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
};

// PDF.js transfers operator buffers. Older WebViews support transferable buffers
// but do not expose ArrayBuffer.transferToFixedLength yet.
if (!ArrayBuffer.prototype.transferToFixedLength) Object.defineProperty(ArrayBuffer.prototype, "transferToFixedLength", {
  configurable: true, writable: true,
  value: function (newLength) {
    const length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get.call(this);
    const original = new Uint8Array(this); // Reject detached buffers before allocating.
    const number = newLength === undefined ? length : Number(newLength);
    const size = Number.isNaN(number) ? 0 : Math.trunc(number);
    if (!Number.isFinite(size) || size < 0 || size > Number.MAX_SAFE_INTEGER) throw new RangeError("Invalid buffer length");
    const result = new ArrayBuffer(size);
    new Uint8Array(result).set(original.subarray(0, size));
    if (typeof structuredClone === "function") structuredClone(this, { transfer: [this] });
    else {
      const channel = new MessageChannel();
      try { channel.port1.postMessage(this, [this]); } finally { channel.port1.close(); channel.port2.close(); }
    }
    return result;
  }
});
