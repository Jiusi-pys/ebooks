import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(root, "app/package.json"));
const { build } = require("esbuild");
const output = path.join(root, "platforms/android/app/src/main/assets/reader");
const polyfills = await fs.readFile(path.join(root,"platforms/android/web/polyfills.js"),"utf8");
await fs.mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(root, "platforms/android/web/reader.ts")],
  outfile: path.join(output, "reader.js"), bundle: true, format: "esm", platform: "browser", target: "chrome69",
  nodePaths: [path.join(root, "app/node_modules")],
  alias: { "@": path.join(root, "app/src"), "@contracts": path.join(root, "app/contracts") },
  define: { "import.meta.env.BASE_URL": '"/assets/reader/"' },
  banner: {js:polyfills},
  inject: [path.join(root,"platforms/android/web/standards.ts")],
  plugins: [{name:"parser-id-adapter", setup(plugin) {
    plugin.onResolve({filter:/^\.\/db$/}, args => ({path:path.join(root,"platforms/android/web/id.ts")}));
  }}],
});
await fs.copyFile(path.join(root, "platforms/android/web/index.html"), path.join(output, "index.html"));
await build({entryPoints:[path.join(root,"app/public/pdf.worker.min.mjs")],outfile:path.join(output,"pdf.worker.min.mjs"),bundle:true,format:"esm",platform:"browser",target:"chrome69",banner:{js:polyfills},inject:[path.join(root,"platforms/android/web/standards.ts")]});
await build({entryPoints:[path.join(root,"app/node_modules/pdfjs-dist/web/pdf_viewer.css")],outfile:path.join(output,"pdf_viewer.css"),target:"chrome69"});
console.log("Bundled existing Web format parsers and Android reader assets.");

await fs.mkdir(path.join(output,"fonts"),{recursive:true});
for(const name of ["NotoSerifCJKsc-Regular.otf","LXGWWenKaiLite-Regular.ttf","tkFangSong.ttf","ZCOOLKuaiLe-Regular.ttf"])await fs.copyFile(path.join(root,"ios/Shufang/Fonts",name),path.join(output,"fonts",name));

for(const name of (await fs.readdir(path.join(root,"ios/Shufang/Fonts"))).filter(name=>/license|ofl|readme/i.test(name)))await fs.copyFile(path.join(root,"ios/Shufang/Fonts",name),path.join(output,"fonts",name));
await fs.mkdir(path.join(output,"licenses"),{recursive:true});
for(const [directory,name] of [["platforms/android/web/node_modules/core-js-pure","core-js-pure"],["platforms/android/web/node_modules/pdf-lib","pdf-lib"],["app/node_modules/pdfjs-dist","pdfjs-dist"]]) {
  for(const file of (await fs.readdir(path.join(root,directory))).filter(file=>/^license/i.test(file)))await fs.copyFile(path.join(root,directory,file),path.join(output,"licenses",`${name}-${file}`));
}
