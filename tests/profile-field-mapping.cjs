const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./profile-data.fixture.cjs');
const code = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const scope = vm.createContext({}); scope.self = scope;
vm.runInContext(code('profile-field-mapping.js'), scope);
const fields = scope.CartDeliveryFields;
const plain = value => JSON.parse(JSON.stringify(value));
(async () => {
  const fx = await fixture();
  try {
    const headers = ['GPS Latitude', 'Lng', 'Route name', 'Collection day', 'Cart quantity', 'Address', 'Cart ID', 'Delivered qty', 'Delivery status', 'Notes', 'NEWROUTE', 'NEWDAY'];
    const mapping = plain(fields.suggest(headers).mapping);
    assert.equal(mapping.LATITUDE, 'GPS Latitude'); assert.equal(mapping.QTY, 'Cart quantity');
    assert.equal(mapping.ROUTE, 'Route name'); assert.equal(mapping.DAY, 'Collection day');
    assert.equal(fields.suggest(['NEWROUTE', 'NEWDAY']).mapping.ROUTE, undefined);
    assert.equal(fields.suggest(['Lat', 'GPS Latitude']).mapping.LATITUDE, undefined, 'Ambiguous aliases are not guessed');
    assert.equal(fields.suggest(['LATITUDE', 'Lat']).mapping.LATITUDE, 'LATITUDE');
    assert(fields.errors({ LATITUDE: 'Lat', LONGITUDE: 'Lat' }, ['Lat']).length);
    assert(fields.errors({}, []).length);
    const source = { 'GPS Latitude': 30.75, Lng: -98.2, 'Route name': 'Trash', 'Collection day': 'Monday', 'Cart quantity': 3,
      Address: '123 Main St', 'Cart ID': '0012', 'Delivered qty': 0, 'Delivery status': '', Notes: 'Gate', NEWROUTE: 'Wrong', NEWDAY: 7 };
    const converted = plain(fields.apply(source, mapping));
    assert.equal(converted.DAY, 1); assert.equal(converted.ROUTE, 'Trash'); assert.equal(converted.BINNO, '0012');
    assert.equal(converted.del_qty, 0); assert.equal(converted.delivery_notes, 'Gate');
    assert.deepEqual(plain(fields.apply({ LATITUDE: 10, LONGITUDE: 20, del_status: 'Delivered' }, { LATITUDE: 'LONGITUDE', LONGITUDE: 'LATITUDE' })), { LATITUDE: 20, LONGITUDE: 10 }, 'Remapping uses original cells and clearing a field really ignores it');
    let response;
    const worker = vm.createContext({ XLSX: fx.XLSX, Uint8Array, importScripts: () => {}, CartDeliveryFields: fields });
    worker.self = worker; worker.postMessage = data => { response = plain(data); };
    vm.runInContext(code('profile-import-worker.js'), worker);
    const bytes = fx.workbook([source]);
    worker.onmessage({ data: { bytes, mapping } });
    assert.equal(response.rowCount, 1); assert.equal(response.samples['Cart ID'][0], '0012');
    worker.onmessage({ data: { offset: 0 } });
    assert.deepEqual(response.rows[0], converted);
    const actor = await fx.actor('mapping_test');
    const other = await fx.actor('mapping_other');
    const input = { name: 'Mapped.xlsx', digest: 'a'.repeat(64), fieldMapping: mapping };
    const requestId = randomUUID();
    const started = await fx.call(actor, 'import-start', { ...input, requestId });
    assert.deepEqual(started.fieldMapping, mapping);
    assert.deepEqual((await fx.call(actor, 'import-start', { ...input, requestId })).fieldMapping, mapping, 'Receipt retry retains mapping');
    fx.objects.set(`${started.upload.bucket}/${started.upload.path}`, bytes);
    await fx.call(actor, 'import-batch', { fileId: started.fileId, offset: 0, rows: [converted] });
    const resumed = await fx.call(actor, 'import-start', input);
    assert.equal(resumed.fileId, started.fileId); assert.equal(resumed.rowCount, 1);
    const changed = await fx.call(actor, 'import-start', { ...input, fieldMapping: { ...mapping, CSSTRT: 'Notes', delivery_notes: 'Address' } });
    assert.notEqual(changed.fileId, started.fileId, 'Different choices cannot resume old mapped batches');
    await fx.call(actor, 'import-finish', { fileId: started.fileId, rowCount: 1 });
    const copy = await fx.call(other, 'open', { fileId: started.fileId });
    assert.deepEqual(copy.fieldMapping, mapping, 'Other devices/profiles receive persisted mapping');
    assert.deepEqual((await fx.handle({ action: 'public-original', fileId: started.fileId })).fieldMapping, mapping);
    await fx.call(other, 'save', { fileId: started.fileId, copyRevision: copy.copyRevision, edits: [{ index: 0, values: { del_qty: 1, del_status: '' } }] });
    assert.equal((await fx.read(other, started.fileId))[0].del_qty, 1);
    assert.deepEqual(fx.objects.get(`${started.upload.bucket}/${started.upload.path}`), bytes, 'Source bytes stay unchanged');
    for (const bad of [null, [], {}, { LATITUDE: 'same', LONGITUDE: 'same' }, { LATITUDE: 'Lat', LONGITUDE: '__proto__' }, { LATITUDE: 'Lat', LONGITUDE: 'Lng', bad: 'Address' }]) {
      await assert.rejects(() => fx.call(actor, 'import-start', { ...input, name: 'Bad.xlsx', fieldMapping: bad }), /INVALID_MAPPING/);
    }
    for (const role of ['anon', 'authenticated']) {
      await fx.pg.exec(`set role ${role}`);
      await assert.rejects(() => fx.pg.query('select public.cd_data_import_mapped($1,$2,$3,$4,$5)', [actor.id, 'mapping_test', randomUUID(), 'hash', { ...input, action: 'import-start' }]), /permission denied/);
      await fx.pg.exec('reset role');
    }
    console.log('PASS: suggested/ambiguous/manual mapping, samples, worker imports, weekdays, ignored fields, immutable sources, resumable mapping isolation, cross-profile metadata and server-only permissions.');
  } finally { await fx.pg.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
