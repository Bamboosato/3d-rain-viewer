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
  return page.getByRole('button',{name:'更新',exact:true}).isDisabled().catch(()=>false);
 },{timeout:15000,intervals:[100,250,500]}).toBe(true);
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
  if(['tile.openstreetmap.org','cyberjapandata.gsi.go.jp','server.arcgisonline.com'].includes(url.hostname)){await route.fulfill({response:await request.get('/__fixture/map.png')});return;}
  if(url.hostname==='nominatim.openstreetmap.org'){await route.fulfill({json:{display_name:'Fixture',address:{}}});return;}
  if(['overpass-api.de','overpass.kumi.systems'].includes(url.hostname)){await route.fulfill({json:{elements:[]}});return;}
  if(url.hostname==='www.jma.go.jp'){
   const response=await request.get('/__fixture/'+url.pathname.split('/').pop()+'?upstream='+encodeURIComponent(url.pathname));await route.fulfill({response});return;
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
// Forecast perspectives: real SW + successful PNG decode, transient/permanent
// failure, catalog rollover, latest-only interaction and retained offline cache.
async function tenHours(page:Page){
 const slider=page.getByRole('slider',{name:'観測・予測時刻シークバー'});
 await slider.press('End');await slider.press('ArrowLeft');
}
function forecastCount(state:any){return Object.entries(state.forecastRequests).filter(([url])=>url.includes('/none/20261109160000/')).reduce((n,[,count])=>n+Number(count),0);}
// Sample actual layout each animation frame, including the in-flight transition.
// Endpoint-only measurements would miss a temporary status row appearing/disappearing.
async function startTimelineLayoutSample(page:Page){
 await page.evaluate(()=>{
  const samples:any[]=[];let raf=0;
  const sample=()=>{
   const slider=document.querySelector('#timeline-seek-slider')!;const panel=slider.closest('section')!;
   const rect=(el:Element)=>{const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
   samples.push({panel:rect(panel),slider:rect(slider),busy:panel.getAttribute('aria-busy'),status:!!document.querySelector('#timeline-data-state')});
   raf=requestAnimationFrame(sample);
  };
  sample();(window as any).__finishTimelineSample=()=>{cancelAnimationFrame(raf);return samples;};
 });
}
async function expectStableTimeline(page:Page){
 const samples=await page.evaluate(()=>(window as any).__finishTimelineSample());
 expect(samples.length).toBeGreaterThan(2);expect(samples.some((s:any)=>s.busy==='true')).toBe(true);
 expect(samples.some((s:any)=>s.status)).toBe(false);
 for(const element of ['panel','slider'])for(let i=0;i<4;i++){
  const values=samples.map((s:any)=>s[element][i]);
  expect(Math.max(...values)-Math.min(...values),`${element} coordinate ${i}`).toBeLessThanOrEqual(1);
 }
 await expect(page.locator('#timeline-data-state')).toHaveCount(0);
}
test('FORECAST transient 10h failure recovers automatically and existing cache survives offline reload',async({page,request,context},info)=>{
 await page.setViewportSize({width:390,height:844});
 await request.get('/__test/config?forecast=retry');await page.goto(point);await controlled(page);await page.reload();
 await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
 await page.evaluate(async()=>{await(await caches.open('foreign-keep')).put('/keep',new Response('keep'));});
 // Functional recovery uses the product's 18-second whole-frame deadline;
 // the request-count assertions below enforce the I/O budget independently.
 await startTimelineLayoutSample(page);
 await tenHours(page);await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/10 01:00',{timeout:19000});
 await expectStableTimeline(page);
 await expect(page.locator('#timeline-status-pill')).toHaveText('予測');
 const first=await(await request.get('/__test/state')).json();expect(forecastCount(first)).toBe(40);
 await page.getByRole('slider').press('Home');await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
 await tenHours(page);await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/10 01:00');
 expect(forecastCount(await(await request.get('/__test/state')).json())).toBe(40);
 await page.waitForFunction(async()=>{const c=await caches.open('rain3d-runtime-v13');return(await c.keys()).filter(r=>r.url.includes('/none/20261109160000/')).length===20;});
 // Force the next navigation to start from the observation while preserving caches.
 await page.goto(point);await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
 await context.setOffline(true);
 try{
  await page.reload();await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
  await tenHours(page);await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/10 01:00');
  await expect(page.locator('#inspector-rain-value')).toContainText('0.0');
  expect(await page.evaluate(async()=>await(await(await caches.open('foreign-keep')).match('/keep'))?.text())).toBe('keep');
 }finally{await context.setOffline(false);}
 await expect(page.getByText(/選択時刻の取得に失敗|雨雲データを取得できません/)).toHaveCount(0);
 await info.attach('forecast-cache-counts',{body:JSON.stringify({first,after:await(await request.get('/__test/state')).json()}),contentType:'application/json'});
});
test('FORECAST persistent failure rolls back without moving the controller or slider',async({page,request})=>{
 await page.setViewportSize({width:320,height:740});
 await request.get('/__test/config?forecast=unavailable');await page.goto(point);await controlled(page);
 await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
 await startTimelineLayoutSample(page);await tenHours(page);
 await expect(page.getByRole('slider')).toHaveValue('5');
 await expect(page.getByRole('slider')).toHaveValue('0',{timeout:19000});
 await expectStableTimeline(page);
 await expect(page.locator('#timeline-play-btn')).toHaveAttribute('aria-label','タイムラプスを再生');
 await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/09 15:00');
 await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
 await expect(page.locator('#inspector-rain-value')).toContainText('0.0');
 await expect(page.getByText(/選択時刻の取得に失敗|雨雲データを取得できません|再試行してください/)).toHaveCount(0);
 expect(forecastCount(await(await request.get('/__test/state')).json())).toBe(60);
});
test('FORECAST failed autoplay returns to its last displayed forecast and pauses',async({page,request})=>{
 await page.setViewportSize({width:390,height:844});
 await request.get('/__test/config?forecast=unavailable');await page.goto(point);await controlled(page);
 await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
 await page.evaluate(()=>{
  const slider=document.querySelector<HTMLInputElement>('#timeline-seek-slider')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(slider,'4');
  slider.dispatchEvent(new Event('input',{bubbles:true}));
 });
 await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/09 22:00');
 await page.locator('#timeline-play-btn').click();await expect(page.getByRole('slider')).toHaveValue('5');
 await expect(page.getByRole('slider')).toHaveValue('4',{timeout:19000});
 await expect(page.locator('#timeline-play-btn')).toHaveAttribute('aria-label','タイムラプスを再生');
 await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/09 22:00');
 await expect(page.locator('#timeline-data-state')).toHaveCount(0);
 expect(forecastCount(await(await request.get('/__test/state')).json())).toBe(60);
});
test('FORECAST observation nowcast and 6h 7h 10h 15h boundaries show the actual frame',async({page,request})=>{
 await request.get('/__test/config?forecast=healthy');await page.goto(point);await controlled(page);
 await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
 for(const time of ['11/09 15:10','11/09 16:00','11/09 21:00','11/09 22:00','11/10 01:00','11/10 06:00']){
  await page.getByRole('slider').press('ArrowRight');
  await expect(page.locator('#timeline-timestamp-badge')).toContainText(time);
  await expect(page.locator('#timeline-status-pill')).toHaveText('予測');
 }
});
test('MEMBER delivery boundaries preserve old none caches and restore immed offline',async({page,request,context})=>{
 await request.get('/__test/config?forecast=members');await page.goto(point);await controlled(page);
 await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
 // Model an existing installation: legacy catalog and an old none URL at the
 // same base/valid time as a new immed frame. This entry must not be consumed or erased.
 const oldUrl='https://www.jma.go.jp/bosai/jmatile/data/rasrf/20261109060000/none/20261109120000/surf/rasrf/6/56/25.png';
 await page.evaluate(async oldUrl=>{
  const key='rain3d_jma_catalog_v1';const catalog=JSON.parse(localStorage.getItem(key)!);
  catalog.version=1;for(const frame of catalog.frames)delete frame.member;
  localStorage.setItem(key,JSON.stringify(catalog));
  await(await caches.open('rain3d-runtime-v13')).put(oldUrl,new Response('legacy none sentinel'));
  await(await caches.open('foreign-keep')).put('/member-keep',new Response('keep'));
 },oldUrl);
 await page.reload();await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
 for(const [index,time] of [[2,'11/09 16:00'],[3,'11/09 16:30'],[4,'11/09 21:00'],[5,'11/09 22:00']] as const){
  await page.evaluate(index=>{
   const slider=document.querySelector<HTMLInputElement>('#timeline-seek-slider')!;
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(slider,String(index));
   slider.dispatchEvent(new Event('input',{bubbles:true}));
  },index);
  await expect(page.locator('#timeline-timestamp-badge')).toContainText(time);
  await expect(page.getByRole('slider')).toHaveValue(String(index));
 }
 const state=await(await request.get('/__test/state')).json();expect(state.memberErrors).toBe(0);
 for(const [member,valid] of [['none','20261109070000'],['immed','20261109073000'],['immed','20261109120000'],['none','20261109130000']]){
  const requests=Object.entries(state.forecastRequests).filter(([url])=>url.includes(`/${member}/${valid}/`));
  expect(requests).toHaveLength(20);
  // The 1h nowcast may be prefetched on both initial load and reload; the SW
  // revalidates an existing image once per visit. New immed/7h images are read once.
  const limit=valid==='20261109070000'?2:1;
  expect(requests.every(([,count])=>Number(count)>=1&&Number(count)<=limit)).toBe(true);
 }
 await page.waitForFunction(async()=>{
  const cache=await caches.open('rain3d-runtime-v13');const keys=await cache.keys();
  return keys.filter(r=>r.url.includes('/immed/20261109120000/')).length===20&&keys.filter(r=>r.url.includes('/none/20261109130000/')).length===20;
 });
 // A local revisit is served by the composed-frame memory cache.
 await page.getByRole('slider').press('ArrowLeft');await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/09 21:00');
 expect((await(await request.get('/__test/state')).json()).forecastRequests).toEqual(state.forecastRequests);
 await context.setOffline(true);
 try{
  await page.reload();await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/09 21:00');
  await page.getByRole('slider').press('ArrowRight');await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/09 22:00');
  // Existing none images must also remain readable with the pre-update catalog
  // shape, entirely offline; unknown legacy immed data is deliberately not guessed.
  await page.evaluate(()=>{
   const key='rain3d_jma_catalog_v1';const catalog=JSON.parse(localStorage.getItem(key)!);
   catalog.version=1;catalog.frames=catalog.frames.filter((frame:any)=>frame.member==='none');
   for(const frame of catalog.frames)delete frame.member;
   catalog.defaultIndex=0;localStorage.setItem(key,JSON.stringify(catalog));
  });
  await page.reload();await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/09 22:00');
  expect(await page.evaluate(async oldUrl=>await(await(await caches.open('rain3d-runtime-v13')).match(oldUrl))?.text(),oldUrl)).toBe('legacy none sentinel');
  expect(await page.evaluate(async()=>await(await(await caches.open('foreign-keep')).match('/member-keep'))?.text())).toBe('keep');
 }finally{await context.setOffline(false);}
 await expect(page.locator('#timeline-data-state')).toHaveCount(0);
});
test('FORECAST missing old generation refreshes catalog once and displays the same selected valid time',async({page,request})=>{
 await request.get('/__test/config?forecast=refresh');await page.goto(point);await controlled(page);
 await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
 const before=await(await request.get('/__test/state')).json();
 await tenHours(page);await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/10 01:00',{timeout:19000});
 const after=await(await request.get('/__test/state')).json();
 expect(after.catalogRequests['targetTimes.json']-before.catalogRequests['targetTimes.json']).toBe(1);
 expect(forecastCount(after)).toBe(40);await expect(page.locator('#timeline-status-pill')).toHaveText('予測');
});
test('FORECAST burst coalesces and cancelled old frame cannot overwrite a later selection',async({page,request})=>{
 await request.get('/__test/config?forecast=delay');await page.goto(point);await controlled(page);
 await expect(page.locator('#timeline-status-pill')).toHaveText('現在');
 const slider=page.getByRole('slider');
 // Send a deterministic sub-120ms burst through the real React input handler.
 // Separate Playwright key commands can exceed the debounce window under load.
 await page.evaluate(()=>{
  const slider=document.querySelector<HTMLInputElement>('#timeline-seek-slider')!;
  const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  for(const index of [6,5,0]){setValue.call(slider,String(index));slider.dispatchEvent(new Event('input',{bubbles:true}));}
 });
 await expect(slider).toHaveValue('0');
 await expect(page.getByRole('region',{name:'雨雲タイムラプスコントローラー'})).toHaveAttribute('aria-busy','false');
 expect(forecastCount(await(await request.get('/__test/state')).json())).toBe(0);
 await tenHours(page);
 await expect.poll(async()=>forecastCount(await(await request.get('/__test/state')).json())).toBeGreaterThan(0);
 await slider.press('End');await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/10 06:00');
 // Release the obsolete responses only after the newer frame is displayed.
 await request.get('/__test/release-forecast');
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await expect(page.locator('#timeline-timestamp-badge')).toContainText('11/10 06:00');
 await expect(slider).toHaveValue('6');
 expect(forecastCount(await(await request.get('/__test/state')).json())).toBeLessThanOrEqual(4);
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

// VT perspectives: one persisted save/rename, overlapping UI updates, modal focus
// and reload. Native animation stays enabled; observation must not catch ready.
test('VT save uses one transition and rapid operations preserve state and focus',async({page})=>{
 await page.emulateMedia({reducedMotion:'no-preference'});
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error'&&message.text().startsWith('View transition '))errors.push(message.text());});
 await page.addInitScript(()=>{
  const original=document.startViewTransition.bind(document);
  const state=(window as any).__vt={started:0,pending:0,peak:0};
  document.startViewTransition=((...args:any[])=>{
   state.started++;state.pending++;state.peak=Math.max(state.peak,state.pending);
   const transition=(original as any)(...args);
   // Do not observe ready: that would hide the original unhandled rejection.
   transition.finished.then(()=>state.pending--,()=>state.pending--);
   return transition;
  }) as typeof document.startViewTransition;
 });
 const settled=async()=>{
  await page.waitForFunction(()=>(window as any).__vt.pending===0);
  // Advance a task after promises settle so unhandledrejection can be delivered.
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
 };
 await page.goto(point);await controlled(page);await settled();
 await page.getByRole('button',{name:'お気に入りに追加',exact:true}).click();
 await page.locator('#inspector-fav-name-input').fill('VT saved');await settled();
 const before=await page.evaluate(()=>(window as any).__vt.started);
 await page.locator('#inspector-fav-save-btn').click();
 await expect(page.locator('#inspector-fav-edit-btn')).toBeVisible();await settled();
 expect(await page.evaluate(()=>(window as any).__vt.started)).toBe(before+1);
 expect((await persisted(page)).favorites.map((f:any)=>f.name)).toEqual(['VT saved']);
 await page.locator('#inspector-fav-edit-btn').click();
 await page.locator('#inspector-fav-name-input').fill('VT renamed');
 const beforeRename=await page.evaluate(()=>(window as any).__vt.started);
 // Use browser mouse events: React commits disabled between user input events.
 // Two synchronous DOM click() calls in one script bypass that input boundary.
 await page.locator('#inspector-fav-save-btn').dblclick();
 await expect(page.locator('#inspector-fav-edit-btn')).toBeVisible();await settled();
 expect(await page.evaluate(()=>(window as any).__vt.started)).toBe(beforeRename+1);
 expect((await persisted(page)).favorites.map((f:any)=>f.name)).toEqual(['VT renamed']);
 // Dispatch real panel handlers in one task to guarantee overlapping native transitions.
 await page.evaluate(()=>{
  (window as any).__vt.peak=0;
  document.querySelector<HTMLButtonElement>('#layer-menu-toggle-btn')!.click();
  document.querySelector<HTMLButtonElement>('#share-view-btn')!.click();
 });
 await expect(page.locator('#share-menu-current-screen-btn')).toBeVisible();await settled();
 expect(await page.evaluate(()=>(window as any).__vt.peak)).toBeGreaterThanOrEqual(2);
 await page.keyboard.press('Escape');await settled();
 await expect(page.locator('#share-menu-current-screen-btn')).toBeHidden();
 await page.locator('#jaxa-credit-trigger-btn').click();
 await expect(page.locator('#jaxa-credit-close-btn')).toBeFocused();
 await page.keyboard.press('Escape');
 await expect(page.locator('#jaxa-credit-close-btn')).toBeHidden();
 await expect(page.locator('#jaxa-credit-trigger-btn')).toBeFocused();await settled();
 expect(errors).toEqual([]);
 await page.reload();await expect(page.locator('#inspector-fav-edit-btn')).toBeVisible();await settled();
 expect((await persisted(page)).favorites.map((f:any)=>f.name)).toEqual(['VT renamed']);
 expect(errors).toEqual([]);
});
test('T01/20/21 actual old-to-new SW preserves editing and foreign cache',async({page,request},info)=>{
 await request.get('/__test/config?version=old');await page.goto(point);await controlled(page);
 await page.evaluate(async()=>{const cache=await caches.open('rain3d-opfs-fallback-v1');await cache.put('/fixture-tile',new Response('keep'));await caches.open('rain3d-shell-v10');});
 await page.getByRole('button',{name:'お気に入りに追加',exact:true}).click();await page.locator('#inspector-fav-name-input').fill('Unsaved fixture');
 await request.get('/__test/config?version=new');await updateWhileBlocked(page);
 const update=page.getByRole('button',{name:'更新',exact:true});await expect(update).toBeVisible();await expect(update).toBeDisabled();
 // UI/boundary: distinct text/action, disabled explanation, and a narrow viewport.
 const notice=page.getByRole('region',{name:'アプリの更新'});
 await expect(notice.getByRole('status')).toHaveText('新しいバージョンがあります');
 await expect(page.locator('#app-update-reason')).toBeVisible();
 await expect(update).toHaveAccessibleDescription(/編集・取り込みの完了後に更新できます/);
 const originalViewport=page.viewportSize()!;
 await page.setViewportSize({width:320,height:740});
 const box=(await notice.boundingBox())!;
 expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(320);
 expect((await update.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 await page.setViewportSize(originalViewport);
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
 await expect(page.getByRole('button',{name:'更新',exact:true})).toBeEnabled();
 await expect(page.locator('#app-update-reason')).toBeHidden();
 await page.setViewportSize({width:390,height:844});
 await update.focus();await expect(update).toBeFocused();
 await notice.screenshot({path:`test-results/update-notice-${info.project.name}.png`});
 await Promise.all([page.waitForEvent('load'),update.press('Enter')]);
 // Resizing the viewport can change the inspected map point; verify the saved
 // record itself after navigation rather than relying on that point's selection.
 expect((await persisted(page)).favorites[0].name).toBe('Unsaved fixture');
 await expect(notice).toBeHidden();
 await expect.poll(()=>page.evaluate(()=>caches.keys())).not.toContain('rain3d-shell-v10');
 const keys=await page.evaluate(()=>caches.keys());expect(keys).toContain('rain3d-opfs-fallback-v1');
});
test('T20 valid import confirmation survives SW update and clears after cancel',async({page,request})=>{
 await request.get('/__test/config?version=old');await page.goto('/#fav='+payload);await controlled(page);
 await expect(page.getByRole('button',{name:'追加する',exact:true})).toBeVisible();
 await request.get('/__test/config?version=new');await updateWhileBlocked(page);
 await expect(page.getByRole('button',{name:'更新',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'キャンセル',exact:true}).click();await page.getByRole('button',{name:'閉じる',exact:true}).click();
 await expect(page.getByRole('button',{name:'更新',exact:true})).toBeEnabled();
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
 console.log('PERF persistent hits after reload',info.project.name,JSON.stringify(after.filter((e:any)=>e.operation==='tile-read'&&e.outcome==='hit').reduce((counts:any,e:any)=>({...counts,[e.backend]:(counts[e.backend]||0)+1}),{})));
 await info.attach('map-cache-events',{body:JSON.stringify({before,after},null,2),contentType:'application/json'});
});

// Migration viewpoints: production worker messages (not just Worker construction),
// three source switches, retained favorites, online -> cached offline restart.
// Fresh context and provider fixtures isolate this from real services/devices.
test('MIGRATION bundled worker responds online and offline with retained map data',async({page,context})=>{
 // Exercise the supported reduced-motion path to isolate data/worker migration
 // from overlapping menu/favorite ViewTransition animations.
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.addInitScript(()=>{
  (window as any).__fixtureTerrain=true;
  (window as any).__workerReplies=0;
  (window as any).__workerErrors=[];
  (window as any).__tileEvents=[];
  window.addEventListener('rain3d-diagnostic',(event:any)=>{if(event.detail.operation.startsWith('tile-'))(window as any).__tileEvents.push(event.detail);});
  const OriginalWorker=window.Worker;
  window.Worker=class extends OriginalWorker {
   constructor(url:string|URL,options?:WorkerOptions){
    super(url,options);
    this.addEventListener('message',()=>{(window as any).__workerReplies++;});
    this.addEventListener('error',event=>{(window as any).__workerErrors.push(event.message);});
   }
  };
 });
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(point);await controlled(page);
 await expect.poll(()=>page.evaluate(()=>(window as any).__workerReplies)).toBeGreaterThan(0);
 await expect(page.locator('#inspector-rain-value')).toContainText('0.0');
 await save(page,'Migration retained');
 await page.locator('#layer-menu-toggle-btn').click();
 for(const source of ['hillshade','photo','osm']){
  const writes=await page.evaluate(()=>(window as any).__tileEvents.filter((e:any)=>e.operation==='tile-write'&&e.outcome==='success').length);
  await page.locator('#basemap-radio-'+source).check();
  if(source!=='osm')await expect.poll(()=>page.evaluate(()=>(window as any).__tileEvents.filter((e:any)=>e.operation==='tile-write'&&e.outcome==='success').length),{timeout:10000}).toBeGreaterThan(writes);
 }
 // Assert the emitted worker is precached, not incidentally served by HTTP cache.
 const workers=await page.evaluate(async()=>{
  const cache=await caches.open('rain3d-shell-v13');
  return (await cache.keys()).map(r=>r.url).filter(url=>url.includes('/maplibre-gl-worker-'));
 });
 expect(workers).toHaveLength(1);
 expect(errors).toEqual([]);
 await context.setOffline(true);
 try {
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>(window as any).__workerReplies),{timeout:10000}).toBeGreaterThan(0);
  await expect.poll(()=>page.evaluate(()=>(window as any).__tileEvents.filter((e:any)=>e.operation==='tile-read'&&e.outcome==='hit'&&['opfs','cache'].includes(e.backend)).length),{timeout:10000}).toBeGreaterThan(3);
  expect((await persisted(page)).favorites[0].name).toBe('Migration retained');
  await expect(page.locator('#inspector-fav-edit-btn')).toBeVisible();
  // Offline background revalidation can fail; the bundled worker must still
  // start without errors and answer messages using retained persistent data.
  expect(await page.evaluate(()=>(window as any).__workerErrors)).toEqual([]);
 } finally {await context.setOffline(false);}
});
