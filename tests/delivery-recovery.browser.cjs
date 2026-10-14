const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('../local-artifacts/test-tools/node_modules/playwright');
const { fixture } = require('./profile-data.fixture.cjs');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const file = path.join(root, new URL(req.url, 'http://localhost').pathname === '/' ? 'index.html' : new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({'.html':'text/html','.js':'application/javascript','.css':'text/css'})[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  const fx = await fixture(); let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    const a = await fx.actor('recovery_a'), b = await fx.actor('recovery_b');
    const rows = Array.from({length:100}, (_, i) => ({LATITUDE:30.75+i*0.00001,LONGITUDE:-98.23,ROUTE:'A',DAY:1,QTY:3,'CSADR#':100+i,CSSTRT:'Test',BINNO:`BIN-${i}`}));
    const file = await fx.importRows(a, 'Recovery.xlsx', rows);
    const context = await browser.newContext({viewport:{width:440,height:956},hasTouch:true,serviceWorkers:'block',acceptDownloads:true});
    let mode = 'ok', release, delay, saves = [], errors = [];
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      const json = (value,status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
      if (url.hostname.endsWith('supabase.co')) {
        if (url.pathname.endsWith('/auth/v1/token')) {
          const user = [a,b].find(user => user.email === req.postDataJSON().email);
          return user ? json({access_token:user.id,refresh_token:'fake-refresh',expires_in:3600,token_type:'bearer',user}) : json({},400);
        }
        if (url.pathname.includes('/auth/v1/')) return json({});
        if (url.pathname.includes('/functions/v1/')) {
          const body = req.postDataJSON(), user = [a,b].find(user => req.headers().authorization === `Bearer ${user.id}`);
          if (body.action === 'save') {
            saves.push({body,user:user?.id});
            if (mode === 'fail') return route.abort();
            if (mode === 'delay') await delay;
          }
          try {
            const result = await fx.handle(body,user);
            if (body.action === 'save' && mode === 'lost') return route.abort();
            return json(result);
          } catch (error) { return json({error:error.message},400); }
        }
        return json([]);
      }
      if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
      return route.continue();
    });
    const newPage = async () => {
      const page = await context.newPage(); page.on('pageerror',error => errors.push(error.message));
      page.on('dialog',dialog => dialog.accept());
      await page.goto(`http://127.0.0.1:${server.address().port}`, {waitUntil:'networkidle'});
      return page;
    };
    const login = async (page,user) => {
      await page.evaluate(async user => { await sb.auth.signInWithPassword({email:user.email,password:'fake-password'}); },user);
      await page.waitForFunction(id => profileState.user?.id === id,user.id);
    };
    const ready = async page => page.waitForFunction(() => !profileState.busy && !deliverySaveInProgress);
    const openFile = async page => {
      await ready(page); await page.evaluate(file => openProfileFile(file),file);
      await page.waitForFunction(() => _currentRows?.length === 100);
    };
    const journal = page => page.evaluate(() => new Promise((resolve,reject) => {
      const req=indexedDB.open('cartdelivery-delivery-recovery',1);
      req.onsuccess=()=>{const db=req.result; const read=db.transaction('saves').objectStore('saves').getAll();read.onsuccess=()=>{resolve(read.result);db.close();};read.onerror=reject;}; req.onerror=reject;
    }));
    const save = async (page,indices,count) => {
      await ready(page);
      await page.evaluate(({indices,count}) => {
        drawnLayer.clearLayers(); individuallySelectedMarkers.clear(); individuallyDeselectedMarkers.clear();
        for (const index of indices) {
          const row=_currentRows[index];
          for (const [key,group] of Object.entries(routeDayGroups)) {
            const marker=group.layers.find(marker=>marker._rowRef===row);
            if(marker){map.addLayer(marker);individuallySelectedMarkers.add(marker);break;}
          }
        }
        updateSelectionCount(); updateUndoButtonState();
        document.getElementById('recordCartsBtn').click();
      },{indices,count});
      await page.locator('[name=cartCountOperation][value=set]').check();
      await page.locator('#cartCountAmount').fill(String(count));
      await page.locator('#saveCartCountsBtn').click();
    };
    const finish = async page => { await ready(page); if(await page.locator('#cartCountsDialog').isVisible()) await page.locator('#closeCartCountsBtn').click(); };
    const savedCounts = async () => (await fx.read(a,file.fileId)).map(row=>row.del_qty);
    let page=await newPage(); await login(page,a); await openFile(page);

    mode='fail'; await save(page,rows.map((_,i)=>i),3); await finish(page);
    assert.equal((await journal(page)).length,1);
    assert.equal((await journal(page))[0].stops.length,100);
    assert((await savedCounts()).every(count=>!count));
    assert(await page.evaluate(()=>_currentRows.every(row=>!row.del_qty)),'Unconfirmed deliveries do not change the map');
    const originalRequest=(await journal(page))[0].request;
    await page.evaluate(()=>reviewProfileSync());
    assert.match(await page.locator('#profileStatus').textContent(),/earlier delivery save/,'Sync is blocked until recovery resolves');
    await page.locator('#deliveryRecoveryBtn').click();
    for(const width of [440,1440]) {
      await page.setViewportSize({width,height:956});
      for(const light of [false,true]) {
        await page.evaluate(light=>document.body.classList.toggle('sun-mode',light),light);
        await page.locator('#deliveryRecoveryList summary').click();
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        assert(await page.locator('#deliveryRecoveryDialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
        for(const button of await page.locator('#deliveryRecoveryDialog button:visible').all()) assert((await button.boundingBox()).height>=44);
        await page.screenshot({path:`local-artifacts/recovery-${width}-${light}.png`});
        await page.locator('#deliveryRecoveryList summary').click();
      }
    }
    const downloadPromise=page.waitForEvent('download');
    await page.getByRole('button',{name:'Download attempted stops'}).click();
    const download=await downloadPromise;
    const XLSX=require('../local-artifacts/test-tools/node_modules/xlsx');
    const exported=XLSX.read(fs.readFileSync(await download.path()));
    assert.equal(XLSX.utils.sheet_to_json(exported.Sheets['Attempted stops']).length,100);
    assert.match(JSON.stringify(XLSX.utils.sheet_to_json(exported.Sheets['Read first'],{header:1})),/not proof of saved deliveries/);
    await page.close(); page=await newPage();
    await page.waitForFunction(()=>profileState.user && _currentRows?.length===100);
    assert.equal((await journal(page))[0].request.requestId,originalRequest.requestId,'Closing/reopening preserves the exact request');
    mode='ok'; await ready(page); await ready(page); await page.evaluate(()=>deliveryRecovery.retry(true)); await ready(page);
    assert.equal((await journal(page)).length,0);
    assert((await savedCounts()).every(count=>count===3));
    assert(await page.evaluate(()=>_currentRows.every(row=>row.del_qty===3)));
    assert(saves.every(save=>JSON.stringify(save.body)===JSON.stringify(originalRequest)),'Retries preserve every request field');

    // Server committed, but every response was lost; a later edit must survive recovery.
    mode='lost'; await save(page,[0],1); await finish(page);
    const lost=(await journal(page))[0]; assert.equal((await savedCounts())[0],1);
    const view=await fx.call(a,'open',{fileId:file.fileId});
    await fx.call(a,'save',{fileId:file.fileId,copyRevision:view.copyRevision,edits:[{index:0,values:{del_qty:2,del_status:''}}]});
    await page.close(); page=await newPage();
    await page.waitForFunction(()=>profileState.user && _currentRows?.length===100);
    mode='ok'; await ready(page); await ready(page); await page.evaluate(()=>deliveryRecovery.retry(true)); await ready(page);
    assert.equal((await journal(page)).length,0); assert.equal((await savedCounts())[0],2);
    assert.equal(await page.evaluate(()=>_currentRows[0].del_qty),2,'Recovery reloads latest records, not the old receipt snapshot');
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_receipts where actor_id=$1 and request_id=$2',[a.id,lost.request.requestId])).rows[0].n,1);

    mode='fail'; await save(page,[1],1); await finish(page);
    const pending=(await journal(page))[0];
    await page.evaluate(()=>sb.auth.signOut({scope:'local'})); await page.waitForFunction(()=>!profileState.user);
    await login(page,b); await openFile(page);
    assert(await page.locator('#deliveryRecoveryBtn').isHidden());
    const beforeOther=saves.length; mode='ok'; await ready(page); await page.evaluate(()=>deliveryRecovery.retry(true)); await ready(page);
    assert.equal(saves.length,beforeOther,'Another account cannot send the saved request');
    assert.equal((await journal(page))[0].request.requestId,pending.request.requestId);
    mode='fail'; await login(page,a); await openFile(page);
    const changed=await fx.call(a,'open',{fileId:file.fileId});
    await fx.call(a,'save',{fileId:file.fileId,copyRevision:changed.copyRevision,edits:[{index:1,values:{del_qty:2,del_status:''}}]});
    mode='ok'; await ready(page); await ready(page); await page.evaluate(()=>deliveryRecovery.retry(true)); await ready(page);
    assert.equal((await journal(page))[0].state,'review'); assert.equal((await savedCounts())[1],2);
    await page.locator('#deliveryRecoveryBtn').click(); await page.getByRole('button',{name:'Compare with saved copy'}).click();
    await page.getByRole('button',{name:'Keep saved records · Dismiss this attempt'}).waitFor();
    await page.locator('#deliveryRecoveryList summary').click();
    assert.match(await page.locator('#deliveryRecoveryList').textContent(),/Currently saved: 2 carts/);
    await page.getByRole('button',{name:'Keep saved records · Dismiss this attempt'}).click();
    await page.waitForFunction(()=>document.getElementById('deliveryRecoveryBtn').hidden);
    assert.equal((await journal(page)).length,0); assert.equal((await savedCounts())[1],2);
    await page.locator('#closeDeliveryRecoveryBtn').click();

    // Two tabs cannot replace each other's locally recorded request.
    const second=await newPage(); await openFile(second);
    mode='delay'; delay=new Promise(resolve=>{release=resolve;});
    await save(page,[2],1); await page.waitForFunction(()=>deliverySaveInProgress);
    while(!(await journal(page)).length) await new Promise(resolve=>setTimeout(resolve,20));
    const concurrent=(await journal(page))[0];
    await save(second,[3],1); await finish(second);
    assert.equal((await journal(second))[0].request.requestId,concurrent.request.requestId);
    assert.match(await second.locator('#deliverySaveStatus').textContent(),/earlier delivery save/);
    mode='ok'; release(); await finish(page); await second.close();
    assert.equal((await savedCounts())[2],1); assert.equal((await savedCounts())[3],3);

    // A storage/quota failure must prevent sending, even if the internet works.
    const beforeQuota=saves.length;
    await page.evaluate(()=>{window.realTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){if(args[1]==='readwrite')throw new DOMException('Full','QuotaExceededError');return realTransaction.apply(this,args);};});
    await save(page,[4],1); await finish(page);
    assert.equal(saves.length,beforeQuota);
    assert.match(await page.locator('#deliverySaveStatus').textContent(),/Delivery not sent/);
    assert.equal((await savedCounts())[4],3);
    assert.equal(await page.locator('#selectionCount').textContent(),'1','Storage failure preserves selected stops');
    await page.evaluate(()=>{IDBDatabase.prototype.transaction=realTransaction;});

    // Close the tab while the request is still in flight, not after an error screen.
    mode='delay'; delay=new Promise(resolve=>{release=resolve;});
    await save(page,[5],1);
    await page.waitForFunction(()=>deliverySaveInProgress);
    while(!(await journal(page)).length) await new Promise(resolve=>setTimeout(resolve,20));
    const inFlight=(await journal(page))[0];
    await page.close(); mode='ok'; release(); page=await newPage();
    await page.waitForFunction(()=>profileState.user && _currentRows?.length===100);
    await ready(page); await ready(page); await page.evaluate(()=>deliveryRecovery.retry(true)); await ready(page);
    assert.equal((await journal(page)).length,0); assert.equal((await savedCounts())[5],1);
    assert(saves.filter(save=>save.body.requestId===inFlight.request.requestId).length>=1);

    // A timed-out request remains recoverable even if the server later commits it.
    await page.evaluate(()=>{window.realTimeout=AbortSignal.timeout;AbortSignal.timeout=()=>realTimeout(80);});
    mode='delay'; delay=new Promise(resolve=>{release=resolve;});
    await save(page,[7],1); await finish(page);
    assert.equal((await journal(page)).length,1);
    assert.match(await page.locator('#deliverySaveStatus').textContent(),/attempted stops are kept/);
    await page.evaluate(()=>{AbortSignal.timeout=realTimeout;});
    mode='ok'; release(); await ready(page); await page.evaluate(()=>deliveryRecovery.retry(true)); await ready(page);
    assert.equal((await journal(page)).length,0); assert.equal((await savedCounts())[7],1);

    // A deleted file must leave an exportable attempt, never recreate its records.
    mode='fail'; await save(page,[6],1); await finish(page);
    await fx.call(a,'delete-team-file',{fileId:file.fileId,confirmName:'Recovery.xlsx',confirmation:'Confirm',acknowledged:true});
    mode='ok'; await ready(page); await page.evaluate(()=>deliveryRecovery.retry(true)); await ready(page);
    assert.equal((await journal(page))[0].state,'unavailable');
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_files where id=$1',[file.fileId])).rows[0].n,0);
    assert(await page.locator('#deliveryRecoveryBtn').isVisible(),'Deleted-file attempts remain reachable without an open file');
    assert.deepEqual(errors,[]);
    console.log('PASS: 100-stop interrupted saves, durable reopen/in-flight closure, exact retries, lost responses, latest saved counts, account isolation, conflict review/export, sync blocking, concurrent tabs, quota failure, deleted files and phone/desktop themes. All services are fake.');
    await context.close();
  } finally { if(browser) await browser.close(); await fx.pg.close(); server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
