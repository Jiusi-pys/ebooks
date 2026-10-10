// Disposable browser acceptance server; never loads the production environment.
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {createServer}=await import(pathToFileURL(path.join(root,'app/node_modules/vite/dist/node/index.js')).href);
const server=await createServer({configFile:false,envFile:false,root:path.join(root,'app'),resolve:{alias:{'@':path.join(root,'app/src'),'@contracts':path.join(root,'app/contracts'),'@db':path.join(root,'app/db')}},server:{host:'127.0.0.1',port:31234,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:31487',changeOrigin:false}}},plugins:[{name:'isolated-acceptance',configureServer(server){server.middlewares.use('/acceptance',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Shufang isolated network acceptance</title><p>Isolated browser storage</p>');});}}]});
await server.listen();
console.log('ISOLATED_WEB_READY');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await server.close();process.exit(0)});
