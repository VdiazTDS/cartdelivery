const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./profile-data.fixture.cjs');
(async () => {
  const fx = await fixture();
  try {
    const a = await fx.actor('north_crew'), b = await fx.actor('south_crew');
    const { fileId } = await fx.importRows(a, 'Areas.xlsx', [{ QTY: 2, ROUTE: 'A', DAY: 1 }]);
    const other = await fx.importRows(a, 'Other.xlsx', [{ QTY: 1 }]);
    const copy = await fx.call(b, 'open', { fileId });
    const area = (profileId, name) => ({ id: randomUUID(), profileId, name, color: '#2563eb',
      geometry: { type: 'Polygon', coordinates: [[[-98,30],[-97,30],[-97,31],[-98,30]]] } });
    const north = area(a.id, 'North'), north2 = area(a.id, 'North extension'), south = area(b.id, 'South');
    const initial = await fx.call(a, 'work-areas', { fileId });
    assert.equal(initial.revision, 0);
    assert.deepEqual(initial.areas, []);
    assert(initial.profiles.some(p => p.id === b.id && p.name === 'south_crew'));
    await assert.rejects(() => fx.call(null, 'work-areas', { fileId }), /SIGN_IN_REQUIRED/);
    for (const mode of ['copy', undefined]) await assert.rejects(() => fx.call(b, 'work-areas-save',
      { fileId, mode, revision: 0, areas: [north] }), /INVALID_WORK_AREA_VIEW/);
    const fields = { fileId, mode: 'original', revision: 0, areas: [north, north2, south], requestId: randomUUID() };
    const saved = await fx.call(a, 'work-areas-save', fields);
    assert.equal(saved.areas.length, 3);
    assert.equal(saved.areas[0].profileName, 'north_crew');
    assert.deepEqual(await fx.call(a, 'work-areas-save', fields), saved, 'Lost-response retries are idempotent');
    await assert.rejects(() => fx.call(a, 'work-areas-save', { ...fields, areas: [] }), /REQUEST_REUSED/);
    assert.deepEqual((await fx.call(b, 'work-areas', { fileId, mode: 'copy' })).areas, saved.areas);
    assert.deepEqual((await fx.call(b, 'work-areas', { fileId: other.fileId })).areas, []);
    const updated = await fx.call(b, 'work-areas-save', { fileId, mode: 'original', revision: 1,
      areas: [{ ...north, profileId: b.id, name: 'Reassigned', color: '#e11d48' }, south] });
    assert.equal(updated.revision, 2);
    assert.equal(updated.areas[0].profileName, 'south_crew');
    await assert.rejects(() => fx.call(a, 'work-areas-save', { fileId, mode: 'original', revision: 1, areas: [] }), /STALE_VERSION/);
    const invalid = [
      [north, north], [{ ...north, profileId: randomUUID() }], [{ ...north, name: '' }],
      [{ ...north, color: 'red; bad' }], [{ ...north, geometry: { type: 'Point', coordinates: [0,0] } }],
      [{ ...north, geometry: { type: 'Polygon', coordinates: [[[-98,30],[-97,30],[-97,31],[-98,32]]] } }],
      [{ ...north, geometry: { type: 'Polygon', coordinates: [[[0,0],[1,1],[2,2],[0,0]]] } }],
      [{ ...north, geometry: { type: 'Polygon', coordinates: [[[0,0],[181,0],[0,1],[0,0]]] } }],
      [{ ...north, geometry: { type: 'Polygon', coordinates: [[['0',0],[1,0],[0,1],['0',0]]] } }],
      Array.from({ length: 101 }, () => area(a.id, 'Too many'))
    ];
    for (const areas of invalid) await assert.rejects(() => fx.call(a, 'work-areas-save',
      { fileId, mode: 'original', revision: 2, areas }), /INVALID_WORK_AREA/);
    fx.state.failCommit = true;
    await assert.rejects(() => fx.call(a, 'work-areas-save', { fileId, mode: 'original', revision: 2, areas: [] }), /commit failure/);
    fx.state.failCommit = false;
    assert.equal((await fx.call(a, 'work-areas', { fileId })).areas.length, 2);
    assert.equal((await fx.call(b, 'open', { fileId })).copyRevision, copy.copyRevision, 'Area edits leave delivery revisions alone');
    assert.equal((await fx.read(b, fileId))[0].del_qty, null);
    const removed = await fx.call(a, 'work-areas-save', { fileId, mode: 'original', revision: 2, areas: [] });
    assert.equal(removed.areas.length, 0);
    const rights = (await fx.pg.query("select has_table_privilege('authenticated','public.cd_work_areas','UPDATE') direct, has_function_privilege('anon','public.cd_work_areas_call(uuid,text,uuid,text,jsonb)','EXECUTE') guest, has_function_privilege('authenticated','public.cd_work_areas_call(uuid,text,uuid,text,jsonb)','EXECUTE') client, has_function_privilege('service_role','public.cd_work_areas_call(uuid,text,uuid,text,jsonb)','EXECUTE') server")).rows[0];
    assert.deepEqual(rights, { direct: false, guest: false, client: false, server: true });
    const rpcCopy = await fx.db.rpc('cd_work_areas_call', { p_actor: a.id, p_username: 'north_crew', p_request: randomUUID(), p_hash: 'test',
      p: { action: 'work-areas-save', fileId, mode: 'copy', revision: 3, areas: [] } });
    assert.match(rpcCopy.error.message, /INVALID_WORK_AREA_VIEW/);
    console.log('PASS: shared per-file areas, multiple polygons per profile, assignments, edits/deletes, copy/guest protections, validation, retries, stale edits, atomic failures and delivery isolation.');
  } finally { await fx.pg.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
