import { test, expect, type Page } from '@playwright/test';
// Perspectives: real UI commit/reload, update while editing, import/Undo, offline and missing vs zero.
// Each browser context starts empty. SW and IDB remain real; external providers are fixtures.
const payload='1j'+Buffer.from(JSON.stringify([['Imported',14000000,3600000,1000,60,0,1,1794182400]])).toString('base64url');
const point='/?name=Fixture&lng=139&lat=35';
async function controlled(page:Page){
 await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 // Complete the initial update job before changing the server's SW generation.
 await page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration())!.update();});
}
async function updateWhileBlocked(page:Page){
 // update() can join an already-running browser update job. Wait for the observed new controller/UI.
 await expect.poll(async()=>{
  await page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration())!.update();});
  return page.getByRole('button',{name:'編集・取り込みの完了後に更新できます'}).count();
 },{timeout:15000,intervals:[100,250,500]}).toBe(1);
}
async function save(page:Page,name:string){
 await page.getByRole('button',{name:'お気に入りに追加',exact:true}).click();
 await page.locator('#inspector-fav-name-input').fill(name);await page.locator('#inspector-fav-save-btn').click();
 await expect(page.locator('#inspector-fav-edit-btn')).toBeVisible();
}
async function persisted(page:Page){return page.evaluate(()=>JSON.parse(localStorage.getItem('rain3d_favorite_atomic_state_v1')||'null'));}
test.beforeEach(async({page,request,context})=>{
 await request.get('/__test/config?version=new&weather=zero');
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.hostname==='localhost'||url.hostname==='127.0.0.1'){await route.continue();return;}
  if(url.hostname==='data.earth.jaxa.jp'&&url.pathname.endsWith('.js')){await route.fulfill({response:await request.get('/__fixture/jaxa.js')});return;}
  if(url.hostname==='tile.openstreetmap.org'){await route.fulfill({response:await request.get('/__fixture/map.png')});return;}
  if(url.hostname==='www.jma.go.jp'){
   const response=await request.get('/__fixture/'+url.pathname.split('/').pop());await route.fulfill({response});return;
  }
  await route.abort();
 });
});
test.afterEach(async({page,request},info)=>{
 if(info.status!==info.expectedStatus){
  const browser=await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();return {controller:navigator.serviceWorker.controller?.state,active:r?.active?.state,waiting:r?.waiting?.state,installing:r?.installing?.state,caches:await caches.keys(),buttons:[...document.body.children].filter(e=>e.tagName==='BUTTON').map(e=>e.outerHTML)};}).catch(()=>null);
  await info.attach('sw-state',{body:JSON.stringify({browser,server:await (await request.get('/__test/state')).json()},null,2),contentType:'application/json'});
 }
});
test('T16/19 UI save and delete-all survive real page reload',async({page})=>{
 await page.goto(point);await controlled(page);await save(page,'Saved fixture');
 await page.reload();await expect(page.locator('#inspector-fav-edit-btn')).toBeVisible();
 expect((await persisted(page)).favorites[0].name).toBe('Saved fixture');
 await page.locator('#inspector-fav-remove-btn').click();await expect(page.getByRole('button',{name:'お気に入りに追加',exact:true})).toBeVisible();
 await page.reload();await expect(page.getByRole('button',{name:'お気に入りに追加',exact:true})).toBeVisible();expect((await persisted(page)).favorites).toEqual([]);
});
test('T17/18 valid sync import and Undo commit through UI then reload',async({page})=>{
 await page.goto(point);await controlled(page);await save(page,'Before import');
 await page.evaluate(hash=>{location.hash=hash;},'fav='+payload);
 await page.getByRole('button',{name:'追加する',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'取り込みが完了'})).toBeVisible();expect((await persisted(page)).favorites).toHaveLength(2);
 await page.getByRole('button',{name:/直前の取り込みを元に戻す/}).click();
 await expect(page.getByRole('status').filter({hasText:'取り込み前の状態'})).toBeVisible();
 await page.reload();expect((await persisted(page)).favorites.map((f:any)=>f.name)).toEqual(['Before import']);expect((await persisted(page)).undo).toBeNull();
});
test('T01/20/21 actual old-to-new SW preserves editing and foreign cache',async({page,request})=>{
 await request.get('/__test/config?version=old');await page.goto(point);await controlled(page);
 await page.evaluate(async()=>{const cache=await caches.open('rain3d-opfs-fallback-v1');await cache.put('/fixture-tile',new Response('keep'));await caches.open('rain3d-shell-v10');});
 await page.getByRole('button',{name:'お気に入りに追加',exact:true}).click();await page.locator('#inspector-fav-name-input').fill('Unsaved fixture');
 await request.get('/__test/config?version=new');await updateWhileBlocked(page);
 const update=page.getByRole('button',{name:'編集・取り込みの完了後に更新できます'});await expect(update).toBeVisible();await expect(update).toBeDisabled();
 await expect(page.locator('#inspector-fav-name-input')).toHaveValue('Unsaved fixture');
 await page.evaluate(()=>{
  const original=IDBDatabase.prototype.transaction;
  (window as any).__releaseCommits=[];
  IDBDatabase.prototype.transaction=function(...args:any[]){
   const tx=(original as any).apply(this,args);
   if(args[1]==='readwrite')Object.defineProperty(tx,'oncomplete',{set(fn){tx.addEventListener('complete',(event:any)=>(window as any).__releaseCommits.push(()=>fn(event)));}});
   return tx;
  } as any;
 });
 await page.locator('#inspector-fav-save-btn').click();
 await page.waitForFunction(()=>(window as any).__releaseCommits.length>0);
 await expect(update).toBeDisabled();await expect(page.locator('#inspector-fav-save-btn')).toBeDisabled();
 await page.evaluate(()=>{for(const release of (window as any).__releaseCommits.splice(0))release();});
 await expect(page.getByRole('button',{name:'更新があります。再読み込み'})).toBeEnabled();
 await page.getByRole('button',{name:'更新があります。再読み込み'}).click();await expect(page.locator('#inspector-fav-edit-btn')).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>caches.keys())).not.toContain('rain3d-shell-v10');
 const keys=await page.evaluate(()=>caches.keys());expect(keys).toContain('rain3d-opfs-fallback-v1');
});
test('T20 valid import confirmation survives SW update and clears after cancel',async({page,request})=>{
 await request.get('/__test/config?version=old');await page.goto('/#fav='+payload);await controlled(page);
 await expect(page.getByRole('button',{name:'追加する',exact:true})).toBeVisible();
 await request.get('/__test/config?version=new');await updateWhileBlocked(page);
 await expect(page.getByRole('button',{name:'編集・取り込みの完了後に更新できます'})).toBeDisabled();
 await page.getByRole('button',{name:'キャンセル',exact:true}).click();await page.getByRole('button',{name:'閉じる',exact:true}).click();
 await expect(page.getByRole('button',{name:'更新があります。再読み込み'})).toBeEnabled();
 await page.reload();await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('T06/07/23/27 zero fixture differs from missing and survives offline reload',async({page,context,request})=>{
 await page.goto(point);await controlled(page);await page.reload();
 await expect(page.locator('#inspector-rain-value')).toContainText('0.0');
 await page.waitForFunction(async()=>{const c=await caches.open('rain3d-runtime-v13');return (await c.keys()).filter(k=>k.url.endsWith('.png')).length===20;});
 await context.setOffline(true);await page.reload();await expect(page.locator('#inspector-rain-value')).toContainText('0.0');await context.setOffline(false);
 await request.get('/__test/config?weather=missing');await page.evaluate(async()=>{await caches.delete('rain3d-runtime-v13');});await page.reload();
 await expect(page.locator('#inspector-rain-value')).toContainText('欠測');
});
test('T16 storage rejection keeps input and shows error',async({page})=>{
 await page.addInitScript(()=>{Object.defineProperty(window,'indexedDB',{value:undefined});Storage.prototype.setItem=function(){throw new DOMException('fixture quota','QuotaExceededError');};});
 await page.goto(point);await page.getByRole('button',{name:'お気に入りに追加',exact:true}).click();await page.locator('#inspector-fav-name-input').fill('Keep input');await page.locator('#inspector-fav-save-btn').click();
 await expect(page.locator('#inspector-fav-save-error')).toBeVisible();await expect(page.locator('#inspector-fav-name-input')).toHaveValue('Keep input');
});

test('T13/14 source roundtrip adopts matching displayed time and point value',async({page})=>{
 await page.goto(point);await controlled(page);await expect(page.locator('#inspector-rain-value')).toContainText('0.0');
 await page.locator('#layer-menu-toggle-btn').click();await page.locator('#source-btn-gsmap').click();
 await expect(page.locator('#inspector-rain-value')).toContainText('20.0');
 await page.getByRole('slider',{name:'観測・予測時刻シークバー'}).press('Home');
 await expect(page.locator('#inspector-rain-value')).toContainText('1.0');
 await page.locator('#source-btn-jma').click();await expect(page.locator('#inspector-rain-value')).toContainText('0.0');
 // Delay a different SDK frame at the provider boundary, switch back, then release the obsolete result.
 await page.reload();await expect(page.locator('#inspector-rain-value')).toContainText('0.0');
 await page.waitForFunction(()=>!!(window as any).__fixtureSdk);
 await page.evaluate(()=>{(window as any).__fixtureSdk.hold=true;});
 await page.locator('#layer-menu-toggle-btn').click();await page.locator('#source-btn-gsmap').click();
 await page.waitForFunction(()=>(window as any).__fixtureSdk.pending.length>0);
 await page.locator('#source-btn-jma').click();await expect(page.locator('#inspector-rain-value')).toContainText('0.0');
 await page.evaluate(async()=>{
  const sdk=(window as any).__fixtureSdk;sdk.hold=false;for(const release of sdk.pending.splice(0))release();
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
 });
 await expect(page.locator('#inspector-rain-value')).toContainText('0.0');
});

// Short performance smoke: real MapLibre/protocol/OPFS/CacheStorage, fixed map and DEM providers.
// Normal/revisit + burst/viewport transition; no physical-device timing claims.
test('PERF accumulated map cache survives pan zoom and reload without internal warnings',async({page},info)=>{
 await page.addInitScript(()=>{
  (window as any).__fixtureTerrain=true;
  (window as any).__tileEvents=[];
  window.addEventListener('rain3d-diagnostic',(event:any)=>{if(event.detail.operation.startsWith('tile-'))(window as any).__tileEvents.push(event.detail);});
 });
 await page.goto('/?lng=139&lat=35&zoom=9');await controlled(page);
 await expect.poll(()=>page.evaluate(()=>(window as any).__tileEvents.filter((e:any)=>e.operation==='tile-write'&&e.outcome==='success').length),{timeout:15000}).toBeGreaterThan(8);
 const canvas=page.locator('.maplibregl-canvas');const box=(await canvas.boundingBox())!;
 const x=box.x+box.width*0.5,y=box.y+box.height*0.55;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+180,y+60,{steps:8});await page.mouse.up();
 await page.mouse.wheel(0,-350);await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x-180,y-60,{steps:8});await page.mouse.up();await page.mouse.wheel(0,350);
 await expect.poll(()=>page.evaluate(()=>(window as any).__tileEvents.filter((e:any)=>e.operation==='tile-write'&&e.outcome==='success').length),{timeout:15000}).toBeGreaterThan(12);
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('rain3d-diagnostic',{detail:{operation:'tile-write',outcome:'memory-only'}})));
 await expect(page.getByText('地図データを端末に保存できません。この画面では閲覧を続けられます。')).toHaveCount(0);
 const before=await page.evaluate(()=>(window as any).__tileEvents);
 await page.reload();
 await expect.poll(()=>page.evaluate(()=>(window as any).__tileEvents.filter((e:any)=>e.operation==='tile-read'&&e.outcome==='hit'&&['opfs','cache'].includes(e.backend)).length),{timeout:15000}).toBeGreaterThan(3);
 const after=await page.evaluate(()=>(window as any).__tileEvents);
 expect(after.filter((e:any)=>e.operation==='tile-write'&&e.outcome==='memory-only')).toHaveLength(0);
 await info.attach('map-cache-events',{body:JSON.stringify({before,after},null,2),contentType:'application/json'});
});
