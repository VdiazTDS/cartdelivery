const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../local-artifacts/test-tools/node_modules/playwright');
const { fixture } = require('./profile-data.fixture.cjs');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const file = path.join(root, new URL(req.url, 'http://localhost').pathname === '/' ? 'index.html' : new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  const fx = await fixture();
  let browser;
  try {
    const north = await fx.actor('north_crew'), south = await fx.actor('south_crew');
    const rows = [1,2,3].map((QTY,i) => ({ QTY, ROUTE: 'TRASH', DAY: 1, LATITUDE: 30.75+i*.001, LONGITUDE: -98.23, CSSTRT: 'Sample' }));
    const { fileId } = await fx.importRows(north, 'Shared areas.xlsx', rows);
    const other = await fx.importRows(north, 'Other area file.xlsx', rows);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    let delaySave = false, releaseSave, failSave = false, loseResponse = false, failImport = false;
    const errors = [], requests = [], users = new Map([[north.id,north],[south.id,south]]);
    async function create(user, width, mode) {
      const context = await browser.newContext({ viewport: { width, height: 956 }, hasTouch: width === 440, serviceWorkers: 'block' });
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        const json = (body, status=200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.hostname === 'fixture.invalid' || url.pathname.includes('/storage/v1/object/public/excel-files/')) {
          const key = url.hostname === 'fixture.invalid' ? decodeURIComponent(url.pathname.slice(1)) : 'excel-files/' + decodeURIComponent(url.pathname.split('/excel-files/')[1]);
          const bytes = fx.objects.get(key);
          return route.fulfill({status:bytes?200:404,contentType:'application/octet-stream',body:bytes?Buffer.from(bytes):''});
        }
        if (url.hostname.endsWith('supabase.co')) {
          if (url.pathname.includes('/functions/v1/profile-workbooks')) {
            const body = req.postDataJSON(); requests.push(body);
            if (body.action === 'import-start' && failImport) return json({error:'REQUEST_FAILED'},400);
            if (body.action === 'work-areas-save') {
              if (delaySave) await new Promise(resolve => { releaseSave = resolve; });
              if (failSave) return json({error:'REQUEST_FAILED'},400);
            }
            const actor = users.get(req.headers().authorization?.replace('Bearer ',''));
            try {
              const result = await fx.handle(body,actor);
              if (body.action === 'work-areas-save' && loseResponse) { loseResponse=false; return route.abort(); }
              return json(result);
            } catch (error) { return json({error:error.message}, error.message.includes('STALE')?409:400); }
          }
          return json([]);
        }
        if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',d=>d.accept());
      await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
      await page.evaluate(({user,fileId,mode})=>{
        sb.auth.getSession=async()=>({data:{session:{access_token:user.id,user}}});
        profileState.user=user; renderProfileState();
        return openProfileFile({fileId},mode);
      },{user,fileId,mode});
      await page.waitForFunction(()=>!document.getElementById('manageWorkAreasBtn').disabled);
      return page;
    }
    async function menu(page) {
      if(page.viewportSize().width<=900 && await page.locator('#mobileMenuBtn').getAttribute('aria-expanded')==='false') await page.locator('#mobileMenuBtn').click();
      if(!await page.locator('#workAreasSection').evaluate(el=>el.open)) await page.locator('#workAreasSection > summary').click();
    }
    async function manager(page) { await menu(page); await page.locator('#manageWorkAreasBtn').click(); }
    async function addArea(page,name,profileId,color='#2563eb') {
      await manager(page);
      await page.locator('#newWorkAreaBtn').click();
      await page.locator('#workAreaName').fill(name);
      await page.locator('#workAreaProfile').selectOption(profileId);
      await page.locator('#workAreaAppearance > summary').click();
      await page.locator('#workAreaColor').selectOption(color);
      await page.locator('#workAreaAppearance > summary').click();
      await page.locator('#drawWorkAreaBtn').click();
      const bounds=await page.locator('#map').boundingBox();
      const width=Math.min(bounds.width,500);
      for(const [x,y] of [[width*.25,100],[width*.65,100],[width*.65,250],[width*.25,250]]) {
        if(page.viewportSize().width===440) await page.touchscreen.tap(bounds.x+x,bounds.y+y);
        else await page.mouse.click(bounds.x+x,bounds.y+y);
        await page.waitForTimeout(100);
      }
      assert(await page.locator('#finishWorkAreaBoundary').isEnabled(),'Three or more vertices enable Finish');
      await page.locator('#undoWorkAreaCorner').click();
      assert.match(await page.locator('#workAreaMapHelp').textContent(),/3 corners placed/);
      await page.locator('#finishWorkAreaBoundary').click();
      assert(await page.locator('#workAreasDialog').isVisible());
      assert(await page.locator('#saveWorkAreaBtn').isEnabled());
      assert.match(await page.locator('#workAreaAssignmentPreview').textContent(),new RegExp(name));
      await page.screenshot({path:path.join(root,`local-artifacts/work-area-form-${page.viewportSize().width}.png`)});
    }
    const count = page => page.evaluate(()=>map.getPane('workAreasPane').querySelectorAll('path').length);
    async function adjustBoundary(page) {
      await page.locator('#adjustWorkAreaBtn').click();
      await page.waitForFunction(()=>!map._animatingZoom && !map._panAnim?._inProgress);
      const box=await page.locator('.leaflet-editing-icon').first().boundingBox();
      assert(box.width>=43.9 && box.height>=43.9,'Boundary handles meet phone tap-target size');
      await page.screenshot({path:path.join(root,`local-artifacts/work-area-adjust-${page.viewportSize().width}.png`)});
      const x=box.x+box.width/2,y=box.y+box.height/2;
      if(page.viewportSize().width===440) {
        const cdp=await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let i=1;i<=5;i++) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+i*5,y:y+i*4}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await cdp.detach();
      } else {
        await page.mouse.move(x,y);
        await page.mouse.down();await page.mouse.move(x+25,y+20,{steps:5});await page.mouse.up();
      }
      await page.locator('#finishWorkAreaBoundary').click();
    }
    const a=await create(north,1440,'original'), b=await create(south,440,'copy');
    await a.evaluate(()=>map.fire(L.Draw.Event.CREATED,{layerType:'polygon',layer:L.polygon([[30.74,-98.24],[30.76,-98.24],[30.76,-98.22]])}));
    const selection=await a.evaluate(()=>JSON.stringify(drawnLayer.toGeoJSON()));
    await addArea(a,'North side',north.id);
    assert.equal(await count(a),0,'Unsaved boundary never enters shared layer');
    delaySave=true;
    await a.locator('#saveWorkAreaBtn').click();
    await a.waitForFunction(()=>document.getElementById('saveWorkAreaBtn').disabled);
    assert.equal(await count(a),0,'Pending save keeps confirmed map unchanged');
    assert.equal((await fx.call(north,'work-areas',{fileId})).areas.length,0);
    while(!releaseSave) await new Promise(resolve=>setTimeout(resolve,25));
    delaySave=false;releaseSave();
    await a.waitForFunction(()=>document.getElementById('workAreaSaveStatus').textContent.startsWith('Saved'));
    assert.equal(await a.evaluate(()=>JSON.stringify(drawnLayer.toGeoJSON())),selection,'Area drawing preserves stop selection');
    await a.evaluate(()=>{drawnLayer.clearLayers();updateSelectionCount();updateUndoButtonState();});
    assert.equal(await count(a),1);
    await a.locator('#closeWorkAreasBtn').click();
    await addArea(a,'North extension',north.id);
    await a.locator('#saveWorkAreaBtn').click();
    await a.waitForFunction(()=>document.getElementById('workAreaSaveStatus').textContent.startsWith('Saved'));
    await a.locator('#closeWorkAreasBtn').click();
    await b.evaluate(()=>workAreas.refresh());
    assert.equal(await count(b),2,'Another profile copy sees shared areas');
    await manager(b);
    assert.equal(await b.locator('#newWorkAreaBtn').isVisible(),false);
    assert.equal(await b.locator('#workAreasList button').filter({hasText:/^(Edit area|Assign profile|Delete)$/}).count(),0);
    await b.locator('#workAreasListFilter').selectOption('mine');
    assert.equal(await count(b),0);
    assert.match(await b.locator('#workAreasList').textContent(),/No areas assigned to you yet/);
    await b.locator('#workAreasListFilter').selectOption(north.id);
    assert.equal(await count(b),2);
    assert.equal(await b.locator('#workAreasFilter').inputValue(),north.id);
    await b.locator('#workAreasListFilter').selectOption('all');
    await b.locator('#closeWorkAreasBtn').click();
    await menu(b);
    await b.locator('#workAreasVisible').uncheck(); assert.equal(await count(b),0);
    await b.locator('#workAreasVisible').check(); assert.equal(await count(b),2);
    assert.equal(requests.filter(r=>r.action==='work-areas-save' && r.mode==='copy').length,0);
    await manager(b);
    const copyBefore=await fx.call(south,'open',{fileId});
    await b.locator('#workAreasTeamBtn').click();
    await b.waitForFunction(()=>profileState.workspace.mode==='original' && !document.getElementById('manageWorkAreasBtn').disabled);
    assert.equal(await b.evaluate(()=>profileState.workspace.mode),'original');
    assert.equal((await fx.call(south,'open',{fileId})).copyRevision,copyBefore.copyRevision,'Switching to edit areas preserves the profile copy');
    await b.locator('#closeWorkAreasBtn').click();
    await addArea(b,'South side',south.id,'#e11d48');
    await b.locator('#saveWorkAreaBtn').click();
    await b.waitForFunction(()=>document.getElementById('workAreaSaveStatus').textContent.startsWith('Saved'));
    await b.locator('#closeWorkAreasBtn').click();
    await a.waitForFunction(()=>map.getPane('workAreasPane').querySelectorAll('path').length===3,{},{timeout:20000});
    for(const page of [a,b]) {
      await menu(page);
      for(const light of [false,true]) {
        await page.evaluate(light=>document.body.classList.toggle('sun-mode',light),light);
        await page.waitForTimeout(250);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        assert(await page.locator('.sidebar').evaluate(el=>el.scrollWidth<=el.clientWidth));
        for(const id of ['manageWorkAreasBtn','refreshWorkAreasBtn']) assert((await page.locator('#'+id).boundingBox()).height>=44);
        const label=await page.locator('.work-area-label').first().boundingBox();
        assert(label.width>80 && label.height<65,'Map labels remain readable without one-letter wrapping');
        await page.screenshot({path:path.join(root,`local-artifacts/work-areas-${page.viewportSize().width}-${light}.png`)});
        await page.locator('#manageWorkAreasBtn').click();
        await page.screenshot({path:path.join(root,`local-artifacts/work-area-list-${page.viewportSize().width}-${light}.png`)});
        assert(await page.locator('#workAreasDialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
        await page.locator('#closeWorkAreasBtn').click();
      }
    }
    await manager(b);
    await b.locator('.work-area-card').filter({hasText:'South side'}).getByRole('button',{name:'Assign profile',exact:true}).click();
    assert(await b.locator('#workAreaProfile').evaluate(el=>el===document.activeElement));
    await b.locator('#cancelWorkAreaBtn').click();
    await b.locator('.work-area-card').filter({hasText:'South side'}).getByRole('button',{name:'Edit area',exact:true}).click();
    await adjustBoundary(b);
    await b.locator('#workAreaName').fill('South adjusted');
    // Another editor changes the same shared revision before this draft is saved.
    const shared=await fx.call(north,'work-areas',{fileId});
    await fx.call(north,'work-areas-save',{fileId,mode:'original',revision:shared.revision,areas:shared.areas.map((area,i)=>i?area:{...area,name:'North updated'})});
    await b.locator('#saveWorkAreaBtn').click();
    await b.waitForFunction(()=>document.getElementById('workAreaSaveStatus').textContent.includes('Another profile'));
    assert.equal((await fx.call(north,'work-areas',{fileId})).areas[2].name,'South side');
    await b.locator('#cancelWorkAreaBtn').click();
    await b.waitForFunction(()=>document.getElementById('workAreasList').textContent.includes('North updated'));
    await b.locator('.work-area-card').filter({hasText:'South side'}).getByRole('button',{name:'Edit area',exact:true}).click();
    await adjustBoundary(b);
    await b.locator('#workAreaName').fill('South renamed');
    await b.locator('#workAreaProfile').selectOption(north.id);
    failSave=true;
    await b.locator('#saveWorkAreaBtn').click();
    await b.waitForFunction(()=>document.getElementById('workAreaSaveStatus').textContent.includes('Could not confirm'));
    assert.equal((await fx.call(north,'work-areas',{fileId})).areas[2].name,'South side');
    failSave=false;loseResponse=true;
    await b.locator('#saveWorkAreaBtn').click();
    await b.waitForFunction(()=>document.getElementById('workAreaSaveStatus').textContent.startsWith('Saved'));
    const latest=await fx.call(north,'work-areas',{fileId});
    assert.equal(latest.revision,5,'Lost response retry commits once');
    assert.equal(latest.areas[2].profileId,north.id);
    assert.notDeepEqual(latest.areas[2].geometry,shared.areas[2].geometry,'Adjusted corners persist only after confirmed save');
    await b.locator('.work-area-card').filter({hasText:'South renamed'}).getByRole('button',{name:'Edit area',exact:true}).click();
    await b.locator('#deleteWorkAreaBtn').click();
    await b.waitForFunction(()=>document.querySelectorAll('#workAreasList .work-area-card').length===2);
    await b.locator('#workAreasReturnBtn').click();
    await b.waitForFunction(()=>profileState.workspace.mode==='copy' && !profileState.busy);
    assert.equal((await fx.call(south,'open',{fileId})).copyRevision,copyBefore.copyRevision);
    await b.evaluate(fileId=>openProfileFile({fileId},'copy'),other.fileId);
    await b.waitForFunction(()=>!document.getElementById('manageWorkAreasBtn').disabled);
    assert.equal(await count(b),0,'File switches discard previous boundaries');
    fx.objects.set('excel-files/Legacy areas.xlsx',fx.workbook(rows));
    const copiesBefore=(await fx.pg.query('select count(*)::int n from cd_data_copies')).rows[0].n;
    await b.evaluate(()=>openProfileFile({name:'Legacy areas.xlsx',sourceKey:'Legacy areas.xlsx'},'original'));
    await menu(b);
    assert(await b.locator('#prepareWorkAreasBtn').isVisible());
    failImport=true;
    await b.locator('#prepareWorkAreasBtn').click();
    await b.waitForFunction(()=>!profileState.busy && document.getElementById('profileStatus').dataset.state==='error');
    assert.equal(await b.locator('#workAreasStatus').textContent(),await b.locator('#profileStatus').textContent(),'Legacy preparation errors are visible in the sidebar');
    failImport=false;
    await b.locator('#prepareWorkAreasBtn').click();
    await b.waitForFunction(()=>!profileState.busy && !document.getElementById('manageWorkAreasBtn').disabled);
    assert.equal(await b.evaluate(()=>profileState.workspace.mode),'original');
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_copies')).rows[0].n,copiesBefore,'Enabling areas never creates a copy');
    await fx.pg.query("update auth.users set raw_app_meta_data=raw_app_meta_data || '{\"cartdelivery_color\":\"#730f26\"}'::jsonb where id=$1",[north.id]);
    for(const page of [a,b]) {
      await page.evaluate(()=>workAreas.refresh());
      await manager(page);await page.locator('#newWorkAreaBtn').click();
      await page.locator('#workAreaProfile').selectOption(north.id);
      assert(await page.locator('#workAreaProfileColor').isVisible());
      assert(!await page.locator('#workAreaAppearance').isVisible());
      assert.equal(await page.locator('#workAreaColor').inputValue(),'#730f26');
      assert(await page.locator('#workAreaColor').isDisabled());
      await page.screenshot({path:path.join(root,`local-artifacts/profile-color-area-${page.viewportSize().width}.png`)});
      await page.locator('#workAreaProfile').selectOption(south.id);
      assert(await page.locator('#workAreaAppearance').isVisible());
      assert(!await page.locator('#workAreaProfileColor').isVisible());
      await page.locator('#cancelWorkAreaBtn').click();await page.locator('#closeWorkAreasBtn').click();
    }
    assert.equal(fx.state.uploads.length,0,'Work areas never write Excel objects');
    await b.evaluate(()=>{profileState.user=null;renderProfileState();});
    assert.equal(await count(b),0);
    assert(await b.locator('#manageWorkAreasBtn').isDisabled());
    assert.deepEqual(errors,[]);
    console.log('PASS: phone/desktop drawing, shared updates, copy viewing/toggle, saved-only layers, selection isolation, edit handles, stale edits, failed/retried saves, reassignment, deletion, file switches, sign-out and both themes.');
  } finally { if(browser) await browser.close(); server.close(); await fx.pg.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
