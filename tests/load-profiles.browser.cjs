const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('../local-artifacts/test-tools/node_modules/playwright');
const { fixture } = require('./load-profiles.fixture.cjs');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname, file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html':'text/html', '.js':'application/javascript', '.css':'text/css' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const { createAdminService } = await import('../supabase/functions/profile-workbooks/admin-service.mjs');
    const { createLoadService } = await import('../supabase/functions/profile-workbooks/load-service.mjs');
    for (const width of [440, 1440]) {
      const fx = fixture(), handle = createAdminService(fx.db), handleLoads = createLoadService(fx.db), errors = [];
      for (const name of ['Vicente','Daniel','Mike','Camden','Justin']) await handle({ action:'admin-load-create', name }, fx.admin);
      const profiles = (await handle({action:'admin-load-list'},fx.admin)).profiles;
      const vicente = profiles.find(profile=>profile.name==='Vicente'), daniel = profiles.find(profile=>profile.name==='Daniel');
      await handle({action:'admin-load-assign',profileId:vicente.id,ownerId:fx.driver.id},fx.admin);
      await handle({action:'admin-load-assign',profileId:daniel.id,ownerId:fx.other.id},fx.admin);
      const context = await browser.newContext({ viewport:{ width, height:956 }, hasTouch: width === 440, serviceWorkers:'block' });
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        const json = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
        if (url.hostname.endsWith('supabase.co')) {
          if (url.pathname.endsWith('/auth/v1/token')) {
            const user=fx.users.find(user=>user.email===req.postDataJSON().email);
            return user ? json({ access_token:user.id, token_type:'bearer', refresh_token:'fake-refresh', expires_in:3600, user }) : json({msg:'Invalid login'},400);
          }
          if (url.pathname.includes('/auth/v1/')) return json({});
          if (url.pathname.includes('/functions/v1/')) {
            const body = req.postDataJSON();
            if (body.action === 'public-list') return json({ files:[] });
            const actor=fx.users.find(user=>req.headers().authorization==='Bearer '+user.id);
            try { return json(await (body.action.startsWith('load-') ? handleLoads(body,actor) : handle(body,actor))); }
            catch (error) { return json({ error:error.message }, 400); }
          }
          if (url.pathname.includes('/storage/v1/object/list/')) {
            const body = req.postDataJSON(), result = await fx.bucket.list(body.prefix, body);
            return result.error ? json({ error:'Read failed' }, 500) : json(result.data);
          }
          if (url.pathname.includes('/storage/v1/object/public/excel-files/')) {
            const key = decodeURIComponent(url.pathname.split('/excel-files/')[1]);
            return fx.state.failRead || !fx.objects.has(key) ? json({}, 404) : route.fulfill({ contentType:'application/json', body:fx.objects.get(key) });
          }
          if (url.pathname.includes('/storage/v1/object/excel-files/') && req.method() === 'POST') {
            throw Error('Browser attempted a direct Storage write');
          }
          return json([]);
        }
        if (/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
        return route.continue();
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil:'networkidle' });
      const openLoads = async target => { await target.evaluate(() => document.getElementById('loadLogBtn').click()); await target.waitForFunction(() => document.getElementById('loadLogSyncStatus').textContent.startsWith('Updated')); };
      await openLoads(page);
      assert.equal(await page.locator('#loadLogProfile option').count(), 6);
      assert(await page.locator('#newLoadBtn').isDisabled());
      assert.equal(await page.locator('#newLoadProfileBtn').count(),0,'Profile creation is admin only');
      const signIn = async (target,user) => {
        await target.evaluate(async user=>{await sb.auth.signInWithPassword({email:user.email,password:'fake-password'});},user);
        await target.waitForFunction(id=>profileState.user?.id===id,user.id);
      };
      await signIn(page,fx.driver);
      await page.waitForFunction(()=>document.getElementById('loadLogAccess').textContent.startsWith('Your truck'));
      await page.locator('#loadLogProfile').selectOption({label:'Daniel'});
      assert(await page.locator('#newLoadBtn').isDisabled());
      await page.locator('#loadLogProfile').selectOption({ label:'Vicente' });
      for (const [trash, recycling] of [[0,0], [0,7], [8,0]]) {
        await page.locator('#newLoadBtn').click();
        await page.locator('#loadTrashQuantity').fill(String(trash)); await page.locator('#loadRecycleQuantity').fill(String(recycling));
        let release; fx.state.delayWrite = new Promise(resolve => { release = resolve; });
        const before = await page.locator('#truckLoadTotal').textContent();
        await page.locator('#saveLoadBtn').click();
        await page.waitForFunction(() => document.getElementById('saveLoadBtn').matches(':disabled'));
        assert.equal(await page.locator('#truckLoadTotal').textContent(), before, 'Counts wait for confirmed writes');
        release(); fx.state.delayWrite = null;
        await page.waitForFunction(() => document.getElementById('loadLogForm').hidden);
      }
      assert.equal(await page.locator('#truckLoadTotal').textContent(), '3');
      assert.equal(await page.locator('#trashCartTotal').textContent(), '8');
      assert.equal(await page.locator('#recycleCartTotal').textContent(), '7');
      await page.locator('#newLoadBtn').click(); fx.state.failWrite = true;
      await page.locator('#saveLoadBtn').click(); await page.waitForFunction(() => document.getElementById('loadLogSaveStatus').textContent.startsWith('Save not confirmed'));
      assert.equal(await page.locator('#truckLoadTotal').textContent(), '3');
      fx.state.failWrite = false; fx.state.loseResponse = true;
      await page.locator('#saveLoadBtn').click(); await page.waitForFunction(() => document.getElementById('loadLogForm').hidden);
      assert.equal(await page.locator('#truckLoadTotal').textContent(), '4'); fx.state.loseResponse = false;
      for (const light of [false,true]) {
        await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        assert(await page.locator('#loadLogDialog').evaluate(el => el.scrollWidth <= el.clientWidth));
        await page.screenshot({ path:`local-artifacts/load-counts-${width}-${light}.png` });
      }
      const other = await context.newPage(); await other.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil:'networkidle' });
      await openLoads(other); await other.locator('#loadLogProfile').selectOption({ label:'Vicente' }); await other.locator('#newLoadBtn').click();
      await page.locator('#closeLoadLogBtn').click(); await page.locator('#openAdminBtn').click();
      await page.locator('#adminProceedBtn').click(); await page.locator('#adminPassword').fill('fake-password'); await page.locator('#adminLoginForm button').click();
      await page.waitForFunction(() => document.querySelectorAll('#adminLoadProfiles article').length === 5);
      await page.locator('#adminLoadName').fill('Test crew'); await page.locator('#adminLoadCreateForm button').click();
      await page.waitForFunction(() => document.querySelectorAll('#adminLoadProfiles article').length === 6);
      for (const light of [false,true]) {
        await page.evaluate(light => document.body.classList.toggle('sun-mode', light), light);
        await page.locator('#adminLoadsTitle').scrollIntoViewIfNeeded();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert(await page.locator('#adminDialog').evaluate(el => el.scrollWidth <= el.clientWidth));
        assert((await page.locator('#adminLoadProfiles button').first().boundingBox()).height >= 44);
        await page.screenshot({ path:`local-artifacts/load-admin-${width}-${light}.png` });
      }
      const ownerSelect=page.locator(`#loadOwner-${vicente.id}`), ownerCard=page.locator('#adminLoadProfiles article').filter({has:ownerSelect});
      assert.equal(await ownerSelect.inputValue(),fx.driver.id);
      await ownerSelect.selectOption(fx.other.id); await ownerCard.getByRole('button',{name:'Save association'}).click();
      await page.waitForFunction(()=>document.getElementById('adminStatus').textContent==='Association saved for Vicente.');
      await other.locator('#saveLoadBtn').click();
      await other.waitForFunction(()=>document.getElementById('loadLogSaveStatus').textContent.includes('Only the associated'));
      assert.equal([...fx.objects.keys()].filter(key=>key.includes('/load-')).length,4,'Stale owner cannot save after reassignment');
      await ownerSelect.selectOption(fx.driver.id); await ownerCard.getByRole('button',{name:'Save association'}).click();
      await page.waitForFunction(()=>document.getElementById('adminDialog').getAttribute('aria-busy')==='false');
      await other.locator('#refreshLoadLogBtn').click(); await other.waitForFunction(()=>!document.getElementById('newLoadBtn').disabled);
      await other.locator('#newLoadBtn').click();
      page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name:'Delete load profile Vicente', exact:true }).click();
      assert.equal(await page.locator('#adminLoadProfiles article').count(), 6);
      fx.state.failWrite = true; page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name:'Delete load profile Vicente', exact:true }).click();
      await page.waitForFunction(() => document.getElementById('adminStatus').textContent.startsWith('Could not confirm'));
      assert.equal(await page.locator('#adminLoadProfiles article').count(), 6);
      fx.state.failWrite = false; page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name:'Delete load profile Vicente', exact:true }).click();
      await page.waitForFunction(() => document.querySelectorAll('#adminLoadProfiles article').length === 5);
      await other.locator('#saveLoadBtn').click();
      await other.waitForFunction(() => document.getElementById('loadLogSaveStatus').textContent.includes('profile was deleted'));
      assert.equal([...fx.objects.keys()].filter(key => key.includes('/load-')).length, 4, 'Stale screen cannot add to deleted profile');
      assert.equal(await other.locator('#loadLogProfile option').filter({ hasText:'Vicente' }).count(), 0);
      assert.equal([...fx.objects.keys()].filter(key => key.includes('/profile-')).length, 6, 'Historical profiles preserved');
      await page.locator('#closeAdminBtn').click(); await openLoads(page);
      assert.equal(await page.locator('#loadLogProfile option').filter({ hasText:'Vicente' }).count(), 0);
      await signIn(page,fx.other);
      await page.waitForFunction(()=>document.getElementById('loadLogProfile').selectedOptions[0]?.textContent==='Daniel');
      await page.waitForFunction(()=>!document.getElementById('newLoadBtn').disabled);
      await page.locator('#newLoadBtn').click();
      await page.evaluate(async()=>{await sb.auth.signOut({scope:'local'});});
      await page.waitForFunction(()=>!profileState.user && document.getElementById('loadLogForm').hidden);
      assert(await page.locator('#newLoadBtn').isDisabled());
      assert.deepEqual(errors, []); await context.close();
    }
    console.log('PASS: phone/desktop themes, guest/other-profile read-only, owner-only writes, zero counts, confirmed saves, retries, assignment/revocation, account changes, admin create/delete and preserved history.');
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
