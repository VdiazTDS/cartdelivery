const assert = require('node:assert/strict');
const { fixture } = require('./profile-data.fixture.cjs');
(async () => {
  const fx = await fixture({ legacySeed: async old => {
    const a=await old.actor('migrate_a'), b=await old.actor('migrate_b');
    const rows=[{ID:1,QTY:3,ROUTE:'A',DAY:1,del_qty:0,del_status:''},{ID:2,QTY:2,ROUTE:'B',DAY:2,del_qty:0,del_status:''}];
    const {fileId}=await old.call(a,'import',{name:'Existing.xlsx',base64:Buffer.from(old.workbook(rows)).toString('base64')});
    await old.call(a,'open',{fileId}); await old.call(b,'open',{fileId});
    await old.call(a,'save',{fileId,copyRevision:1,edits:[{index:0,values:{del_qty:1,del_status:''}}]});
    await old.call(a,'sync',{fileId,copyRevision:2,masterRevision:1,resolutions:[]});
    await old.call(b,'save',{fileId,copyRevision:1,edits:[{index:1,values:{del_qty:1,del_status:''}}]});
    return {a,b,fileId,objects:old.objects.size};
  }});
  try {
    const {a,b,fileId}=fx.legacy;
    assert.deepEqual((await fx.read(a,fileId,'original')).map(x=>x.del_qty),[1,0]);
    assert.deepEqual((await fx.read(a,fileId)).map(x=>x.del_qty),[1,0]);
    assert.deepEqual((await fx.read(b,fileId)).map(x=>x.del_qty),[0,1]);
    const preview=await fx.call(b,'preview',{fileId});
    assert.equal(preview.changes.length,1); assert.equal(preview.changes[0].conflict,false);
    assert.equal(preview.copyRevision,2); assert.equal(preview.masterRevision,2);
    const history=(await fx.call(a,'history',{fileId})).history;
    assert.equal(history.length,1); assert.equal(history[0].change_count,1);
    const details=await fx.call(a,'history-changes',{fileId,eventId:history[0].id});
    assert.equal(details.changes[0].fields.find(x=>x.field==='del_qty').after,1);
    await fx.call(b,'sync',{fileId,copyRevision:preview.copyRevision,masterRevision:preview.masterRevision,resolutions:[]});
    assert.deepEqual((await fx.read(a,fileId,'original')).map(x=>x.del_qty),[1,1]);
    assert.equal(fx.objects.size,fx.legacy.objects);
    assert.equal((await fx.pg.query('select count(*)::int n from cd_files')).rows[0].n,1,'Old tables remain intact');
    console.log('PASS: existing originals, isolated old baselines, pending copies, revisions, history, and source objects survive migration.');
  } finally {await fx.pg.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
