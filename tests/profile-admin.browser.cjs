const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), http=require('node:http');
const {chromium}=require('../local-artifacts/test-tools/node_modules/playwright');
const {fixture}=require('./profile-admin.fixture.cjs');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname, file=path.join(root,pathname==='/'?'index.html':pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  const fx=await fixture();let browser;
  try {
    const createAccount=async(username,admin=false)=>(await fx.db.auth.admin.createUser({email:username+'@profiles.cartdelivery.invalid',password:'fake-password',app_metadata:{cartdelivery_admin:admin}})).data.user;
    const admin=await createAccount('admin',true), driver=await createAccount('driver');
    const {fileId}=await fx.importRows(driver,'Admin browser.xlsx',[{QTY:2,ROUTE:'A',DAY:1,LATITUDE:30,LONGITUDE:-98}]);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    const errors=[],tokens=new Map();let failSave=false;
    for(const width of [440,1440]) {
      const context=await browser.newContext({viewport:{width,height:956},hasTouch:width===440,serviceWorkers:'block'});
      await context.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url());
        const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
        if(url.hostname.endsWith('supabase.co')) {
          if(url.pathname.endsWith('/auth/v1/token')) {
            const body=req.postDataJSON();
            const row=(await fx.pg.query('select id,encrypted_password from auth.users where email=$1 and deleted_at is null',[body.email])).rows[0];
            if(!row||row.encrypted_password!==fx.hash(body.password)) return json({msg:'Invalid login credentials'},400);
            const user=await fx.user(row.id),token=Buffer.from(JSON.stringify({sub:user.id})).toString('base64url');tokens.set(token,user);
            return json({access_token:token,token_type:'bearer',refresh_token:'fake-refresh-'+user.id,expires_in:3600,user:{...user,aud:'authenticated',role:'authenticated'}});
          }
          if(url.pathname.includes('/auth/v1/')) return json({});
          if(url.pathname.includes('/functions/v1/profile-workbooks')) {
            const body=req.postDataJSON();if(failSave&&body.action==='admin-save') return json({error:'REQUEST_FAILED'},400);
            try {return json(await fx.dispatch(body,tokens.get(req.headers().authorization?.replace('Bearer ',''))));}
            catch(error){return json({error:error.message},/ADMIN_REQUIRED|PROFILE_DISABLED/.test(error.message)?403:400);}
          }
          return json([]);
        }
        if(/tile|arcgisonline|arcgis\.com|maps\.austin|census\.gov/.test(url.hostname)) return route.abort();
        return route.continue();
      });
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
      await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
      await page.evaluate(async({driver,fileId})=>{await sb.auth.signInWithPassword({email:driver.email,password:'fake-password'});await new Promise(resolve=>setTimeout(resolve,100));await openProfileFile({fileId},'copy');},{driver,fileId});
      const copyBefore=await page.evaluate(()=>JSON.stringify(profileState.workspace));
      assert.equal(await page.locator('#profilePassword').getAttribute('minlength'),'6');
      assert((await page.locator('#openAdminBtn').boundingBox()).height>=44);
      await page.locator('#openAdminBtn').click();assert(await page.locator('#adminPrompt').isVisible());
      await page.locator('#adminDismissBtn').click();assert(!await page.locator('#adminDialog').isVisible());
      await page.locator('#openAdminBtn').click();await page.locator('#adminProceedBtn').click();
      await page.locator('#adminUsername').fill('driver');await page.locator('#adminPassword').fill('fake-password');
      await page.locator('#adminLoginForm button').click();await page.waitForFunction(()=>document.getElementById('adminStatus').textContent.includes('not an administrator'));
      assert.equal(await page.evaluate(()=>profileState.user.id),driver.id);
      await page.locator('#adminUsername').fill('Admin');await page.locator('#adminPassword').fill('fake-password');
      await page.locator('#adminLoginForm button').click();await page.locator('#adminDashboard').waitFor();
      assert.equal(await page.evaluate(()=>JSON.stringify(profileState.workspace)),copyBefore,'Admin login leaves delivery work open');
      for(const light of [false,true]) {
        await page.evaluate(light=>document.body.classList.toggle('sun-mode',light),light);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        assert(await page.locator('#adminDialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
        await page.screenshot({path:path.join(root,`local-artifacts/profile-admin-${width}-${light}.png`)});
      }
      const name='new_driver_'+width;
      await page.locator('#adminNewBtn').click();await page.locator('#adminEditUsername').fill(name);await page.locator('#adminEditPassword').fill('123456');
      failSave=true;await page.locator('#adminSaveBtn').click();await page.waitForFunction(()=>document.getElementById('adminStatus').textContent.includes('Could not confirm'));
      assert.equal((await fx.pg.query('select count(*)::int n from auth.users where email=$1',[name+'@profiles.cartdelivery.invalid'])).rows[0].n,0);
      failSave=false;await page.locator('#adminSaveBtn').click();await page.waitForFunction(()=>document.getElementById('adminStatus').textContent==='Profile saved.');
      await page.locator('#adminSearch').fill(name);
      assert.equal(await page.locator('.admin-profile-card').count(),1);
      await page.getByRole('button',{name:'Manage profile',exact:true}).click();
      await page.locator('#adminEditUsername').fill(name+'_renamed');await page.locator('#adminEditPassword').fill('654321');await page.locator('#adminSaveBtn').click();
      await page.waitForFunction(()=>document.getElementById('adminStatus').textContent==='Profile saved.');
      await page.getByRole('button',{name:'Manage profile',exact:true}).click();
      await page.screenshot({path:path.join(root,`local-artifacts/profile-admin-edit-${width}.png`)});
      await page.locator('#adminToggleAccessBtn').click();await page.waitForFunction(()=>document.getElementById('adminStatus').textContent==='Account access updated.');
      assert.match(await page.locator('.admin-profile-card').textContent(),/Sign-in disabled/);
      await page.getByRole('button',{name:'Manage profile',exact:true}).click();await page.locator('#adminToggleAccessBtn').click();
      await page.waitForFunction(()=>document.getElementById('adminStatus').textContent==='Account access updated.');
      await page.getByRole('button',{name:'Manage profile',exact:true}).click();await page.locator('.admin-remove summary').click();
      assert(await page.locator('#adminRemoveBtn').isDisabled());
      await page.locator('#adminRemoveConfirm').fill(name+'_renamed');await page.locator('#adminRemoveBtn').click();
      await page.waitForFunction(()=>document.getElementById('adminStatus').textContent.startsWith('Profile login removed'));
      assert.equal(await page.locator('.admin-profile-card').count(),0);
      await page.locator('#adminSignOutBtn').click();await page.waitForFunction(()=>document.getElementById('adminStatus').textContent==='Signed out of admin.');
      assert.equal(await page.evaluate(()=>profileState.user.id),driver.id);
      assert.equal(await page.evaluate(()=>JSON.stringify(profileState.workspace)),copyBefore);
      assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(key=>key.includes('admin-session'))),false,'Admin credentials/session are not persisted');
      await context.close();
    }
    assert.deepEqual(errors,[]);assert.equal(fx.state.uploads.length,0);
    console.log('PASS: phone/desktop admin entry, ordinary-account denial, independent session, six-character creation, failed saves, search, rename/reset, disable/enable, removal confirmation, themes and no live storage.');
  } finally {if(browser) await browser.close();server.close();await fx.pg.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
