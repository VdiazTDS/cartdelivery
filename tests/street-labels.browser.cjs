const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('../local-artifacts/test-tools/node_modules/playwright');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname,file=path.join(root,pathname==='/'?'index.html':pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
const sample=Array.from({length:12},(_,i)=>({ID:i,ROUTE:['A','B','C','D'][i%4],DAY:1+(i%2),SEQNO:i,QTY:1+i%3,
  'CSADR#':100+i,CSSTRT:i===11?'<img src=x onerror=alert(1)>':'SAMPLE',BINNO:'00'+i,
  LATITUDE:30.75+Math.floor(i/4)*.0007,LONGITUDE:-98.23+i%4*.0008,del_status:i===10?'Delivered':''}));
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    const failures=[],errors=[];
    for(const width of [440,1440]){
      const context=await browser.newContext({viewport:{width,height:956},hasTouch:width===440,serviceWorkers:'block',geolocation:{latitude:30.75,longitude:-98.23},permissions:['geolocation']});
      await context.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.hostname.endsWith('supabase.co')||url.hostname==='api.optimoroute.com') return route.fulfill({contentType:'application/json',body:'[]'});
        if(/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.fulfill({contentType:'application/json',body:'{"features":[]}'});
        return route.continue();
      });
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
      await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
      const settle=()=>page.waitForTimeout(350);
      const count=()=>page.locator('.street-label').count();
      const check=(ok,message)=>{if(!ok) failures.push(width+': '+message);};
      const toggle=(id,value)=>page.evaluate(({id,value})=>{const el=document.getElementById(id);el.checked=value;el.dispatchEvent(new Event('change'));},{id,value});
      const load=async(rows=sample)=>{
        await page.evaluate(rows=>{
          layerVisibilityState={};document.getElementById('multipleCartsOnly').checked=false;
          profileState.user={id:'fixture',email:'fixture@profiles.cartdelivery.invalid'};
          profileState.workspace={mode:'copy',owner:'fixture',name:'Labels.xlsx'};window._currentFilePath='Labels.xlsx';
          const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'Stops');
          processExcelBuffer(null,wb);map.setView([30.7507,-98.2288],17,{animate:false});
          window.testMarkers=()=>Object.values(routeDayGroups).flatMap(g=>g.layers);
          window.mapZoomEvents=0;map.off('zoomend',window.countTestZoom);window.countTestZoom=()=>window.mapZoomEvents++;map.on('zoomend',window.countTestZoom);
        },rows);await settle();
      };
      const invariant=()=>page.evaluate(()=>JSON.stringify({rows:window._currentRows,selected:testMarkers().filter(m=>isStopSelected(m,createSelectionTester())).map(m=>m._rowRef.ID),
        visible:testMarkers().filter(m=>map.hasLayer(m)).map(m=>m._rowRef.ID),styles:testMarkers().map(m=>[m.options.color,m.options.fillColor])}));
      await load();
      await toggle('streetLabelToggle',false);await page.evaluate(()=>testMarkers()[0].fire('mouseover'));await settle();
      check(await count()===0,'Hover must not show labels while toggle is off');
      await page.evaluate(()=>testMarkers()[0].fire('mouseout'));
      await page.evaluate(()=>window.mapZoomEvents=0);const initial=await invariant();
      await toggle('streetLabelToggle',true);await settle();
      check(await count()>0,'Enabled labels show without panning');
      check(await page.evaluate(()=>window.mapZoomEvents)===0,'Toggling labels must not emit a fake zoom event');
      check(await invariant()===initial,'Label toggle preserves records, selection, visibility and marker colors');
      const firstCount=await count();await page.evaluate(()=>testMarkers()[0].fire('mouseout'));await settle();
      check(await count()===firstCount,'Moving pointer off a stop must not hide its enabled label');
      if(width===440){
        await page.locator('#mobileSelectionBtn').click();await settle();check(await count()===0,'Entering Select Stops hides labels immediately');
        await page.evaluate(()=>map.panBy([25,0],{animate:false}));await settle();check(await count()===0,'Panning during selection does not recreate labels');
        await page.locator('#mobileSelectionBtn').click();await settle();check(await count()>0,'Done restores labels immediately');
      }
      await page.evaluate(()=>{testMarkers().forEach(m=>map.removeLayer(m));});await settle();check(await count()===0,'Hiding all stops removes their labels');
      await page.evaluate(()=>applyFilters());await settle();check(await count()>0,'Restoring filtered stops restores labels without map movement');
      for(const zoom of [15,16,19,14,17]){
        await page.evaluate(z=>map.setZoom(z,{animate:false}),zoom);await settle();check(zoom<16?await count()===0:await count()>0,'Zoom threshold '+zoom);
      }
      for(const pair of [['draw:drawstart','draw:drawstop'],['draw:editstart','draw:editstop'],['draw:deletestart','draw:deletestop']]){
        await page.evaluate(event=>map.fire(event),pair[0]);await settle();check(await count()===0,'Labels pause during '+pair[0]);
        await page.evaluate(event=>map.fire(event),pair[1]);await settle();check(await count()>0,'Labels restore after '+pair[1]);
      }
      await page.evaluate(()=>beginOptimoLocationPick('start'));await settle();check(await count()===0,'Endpoint picking hides labels');
      await page.evaluate(()=>finishOptimoLocationPick(false,false));await settle();check(await count()>0,'Canceling endpoint picking restores labels');
      // Real pointer/touch selection with all marker shapes; labels never become stop targets.
      await load();await toggle('streetLabelToggle',true);await settle();
      await page.evaluate(()=>map.setView([30.7507,-98.2288],16,{animate:false}));await settle();
      if(width===440) await page.locator('#mobileSelectionBtn').click();
      for(let i=0;i<4;i++){
        await page.evaluate(i=>map.panTo(testMarkers()[i].getLatLng(),{animate:false}),i);await settle();
        const p=await page.evaluate(i=>{const m=testMarkers()[i],p=map.latLngToContainerPoint(m.getLatLng()),r=map.getContainer().getBoundingClientRect();return {x:r.x+p.x,y:r.y+p.y};},i);
        const mapTop=await page.locator('#map').evaluate(el=>el.getBoundingClientRect().top);
        if(width===440) await page.touchscreen.tap(p.x,p.y);else await page.mouse.click(p.x,p.y);
        check(Math.abs(await page.locator('#map').evaluate(el=>el.getBoundingClientRect().top)-mapTop)<1,'Focusing the map does not shift the click target');
        await page.evaluate(()=>map.closePopup());
        await settle();
      }
      await settle();const tappedCount=Number(await page.locator('#selectionCount').textContent());check(tappedCount===4,'Real taps select exactly four stops (got '+tappedCount+')');
      await page.evaluate(()=>map.closePopup());
      if(width===440) await page.locator('#mobileSelectionBtn').click();
      const selected=await invariant();
      for(const value of ['streets','satellite','clarity','light','dark','austin']){
        await page.evaluate(value=>{const el=document.getElementById('baseMapSelect');el.value=value;el.dispatchEvent(new Event('change'));},value);await settle();
        check(await invariant()===selected,'Map view '+value+' preserves stops and selection');
      }
      if(width===440){
        const cdp=await context.newCDPSession(page),box=await page.locator('#map').boundingBox();
        const x=box.x+box.width/2,y=box.y+box.height/2;
        const touch=async(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y],id)=>({x,y,id,radiusX:2,radiusY:2}))});
        await page.locator('#mobileSelectionBtn').click();
        await touch('touchStart',[[x,y]]);
        for(let i=1;i<=8;i++){await touch('touchMove',[[x+i*8,y+i*3]]);await page.waitForTimeout(25);}
        await touch('touchEnd',[]);await settle();
        check(await invariant()===selected,'Touch drag while selecting does not select extra stops');
        await touch('touchStart',[[x-35,y],[x+35,y]]);
        for(let i=1;i<=6;i++){await touch('touchMove',[[x-35-i*8,y],[x+35+i*8,y]]);await page.waitForTimeout(25);}
        await touch('touchEnd',[]);await settle();
        check(await invariant()===selected,'Pinch zoom while selecting preserves selected stops');
        check(await count()===0,'Pinch keeps labels paused while selecting');
        await page.locator('#mobileSelectionBtn').click();await settle();
        await cdp.detach();
      }
      for(const id of ['quantityBadgesToggle','sequenceNumbersToggle','sequenceLayerToggle','addressNumbersToggle','cityLimitsToggle']){
        if(!await page.locator('#'+id).count()) continue;
        await toggle(id,true);await settle();await toggle(id,false);await settle();
        check(await invariant()===selected,id+' leaves selection/data/styles unchanged');
      }
      for(const light of [false,true]){
        await page.evaluate(light=>document.body.classList.toggle('sun-mode',light),light);
        for(const delta of [[100,40],[-100,-40]]){await page.evaluate(delta=>map.panBy(delta,{animate:false}),delta);await settle();}
        await page.screenshot({path:path.join(root,`local-artifacts/street-labels-${width}-${light}.png`)});
        check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal scrolling');
        check(await invariant()===selected,'Panning/themes preserve selected stops');
      }
      await page.evaluate(()=>map.setView([31,-99],17,{animate:false}));await settle();check(await count()===0,'No labels from an offscreen town');
      await page.evaluate(()=>map.setView([30.7507,-98.2288],17,{animate:false}));await settle();check(await count()>0,'Returning to town restores labels');
      await toggle('multipleCartsOnly',true);await settle();
      check(await page.evaluate(()=>[...document.querySelectorAll('.street-label')].every(el=>!el.textContent.startsWith('100 '))),'QTY filter hides label with its stop');
      await toggle('multipleCartsOnly',false);await settle();
      check(await page.evaluate(()=>[...document.querySelectorAll('.street-label')].some(el=>el.textContent.startsWith('100 '))),'Removing QTY filter restores labels');
      await page.setViewportSize({width:width===440?1440:440,height:956});await settle();check(await count()>0,'Layout switch keeps labels');
      await page.setViewportSize({width,height:956});await settle();
      await load(sample.map(row=>({...row,CSSTRT:'REPLACEMENT'})));check(await page.evaluate(()=>[...document.querySelectorAll('.street-label')].every(el=>el.textContent.includes('REPLACEMENT'))),'File switch removes old labels');
      await load(Array.from({length:5400},(_,i)=>({...sample[0],ID:i,'CSADR#':i,LATITUDE:30.75+(i%60)*.000005,LONGITUDE:-98.23+Math.floor(i/60)*.000005})));
      check(await count()<=150,'Large file stays within 150 labels');
      for(let i=0;i<5;i++){await toggle('streetLabelToggle',false);await toggle('streetLabelToggle',true);}await settle();check(await count()<=150,'Rapid toggles do not duplicate labels');
      await page.evaluate(()=>document.getElementById('resetMapBtn').click());await settle();check(await count()===0,'Reset clears labels');
      await context.close();
    }
    assert.deepEqual(errors,[],'No browser exceptions');assert.deepEqual(failures,[],'Street label interaction regressions');
    console.log('PASS: street labels, real selection taps, hover, zoom thresholds, pan, drawing/edit/delete, endpoint picker, filters, overlays, themes, resize, file replacement, reset, 5,400 stops and rapid toggles.');
  }finally{if(browser) await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
