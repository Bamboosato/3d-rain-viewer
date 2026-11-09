// Local-only fixture server. Never used by the product build or deployment.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
let version = 'new', weather = 'zero';
let swRequests=[];
const crc = buffer => { let c=0xffffffff; for(const byte of buffer){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0; };
const chunk = (type,data) => { const body=Buffer.concat([Buffer.from(type),data]);const head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(body));return Buffer.concat([head,body,tail]); };
const header=Buffer.alloc(13);header.writeUInt32BE(256);header.writeUInt32BE(256,4);header[8]=8;header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(256*(256*4+1)))),chunk('IEND',Buffer.alloc(0))]);
const n1=JSON.stringify([{basetime:'20261109060000',validtime:'20261109060000',elements:['hrpns']}]);
createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost:4173');
 const send=(status,body,type='text/plain')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','access-control-allow-origin':'*'});res.end(body);};
 if(url.pathname==='/__test/state'){send(200,JSON.stringify({version,weather,swRequests}),'application/json');return;}
 if(url.pathname==='/__test/config'){version=url.searchParams.get('version')||'new';weather=url.searchParams.get('weather')||'zero';send(200,'ok');return;}
 if(url.pathname==='/__fixture/jaxa.js'){send(200,await readFile('e2e/jaxa-fixture.mjs','utf8'),'text/javascript');return;}
 if(url.pathname.startsWith('/__fixture/')){
  if(url.pathname.endsWith('.json'))send(200,url.pathname.includes('N1')?n1:'[]','application/json');
  else send(weather==='missing'?404:200,weather==='missing'?'missing':png,'image/png');return;
 }
 try {
  if(url.pathname==='/sw.js'){
   swRequests.push({at:Date.now(),version});
   let code=await readFile('dist/sw.js','utf8');if(version==='old')code=code.replaceAll('-v13','-v12');
   // API-boundary fixtures: exercise the production SW handlers and real CacheStorage.
   const fixture=`const fixtureFetch=self.fetch.bind(self); self.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input.url,self.location.origin); if(u.origin===self.location.origin)return fixtureFetch(input,init); if(u.hostname==='data.earth.jaxa.jp'&&u.pathname.endsWith('.js'))return fixtureFetch('/__fixture/jaxa.js'); if(u.hostname==='tile.openstreetmap.org')return fixtureFetch('/__fixture/map.png',init); if(u.hostname==='www.jma.go.jp')return fixtureFetch('/__fixture/'+u.pathname.split('/').pop(),init); return Promise.resolve(Response.error());}; self.addEventListener('fetch',event=>{const u=new URL(event.request.url);if(u.origin!==self.location.origin&&u.hostname!=='www.jma.go.jp')event.respondWith(self.fetch(event.request));});\n`;
   send(200,fixture+code,'text/javascript');return;
  }
  let pathname=decodeURIComponent(url.pathname);if(pathname==='/'||!path.extname(pathname))pathname='/index.html';
  const root=path.resolve('dist'),target=path.resolve(root,'.'+pathname);
  if(!target.startsWith(root+path.sep)){send(403,'denied');return;}
  const body=await readFile(target);const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'}[path.extname(target)]||'application/octet-stream';send(200,body,type);
 }catch{send(404,'not found');}
}).listen(4173,'127.0.0.1');
