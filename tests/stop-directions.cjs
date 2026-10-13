const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context = vm.createContext({});
for (const name of ['stopDirectionsDestination', 'stopDirectionsLinks']) vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\r?\\n}`))[0], context);
const destination = row => JSON.parse(JSON.stringify(context.stopDirectionsDestination(row)));
const row = { 'CSADR#': 0, CSSTRT: 'Oak & Pine #5', CSCITY: 'Burnet', CSSTATE: 'TX', CSZIP: '00701', LATITUDE: '30.123456789', LONGITUDE: '-98.987654321' };
assert.equal(destination(row).address, '0 Oak & Pine #5, Burnet TX 00701');
assert.equal(destination(row).coordinates, '30.123456789,-98.987654321');
assert.equal(destination({ ...row, CITY: ' ', STATE: '', ZIP: '' }).address, destination(row).address, 'Blank preferred locality columns still use the alternate columns');
assert.equal(destination({ ...row, LATITUDE: 0, LONGITUDE: 0 }).coordinates, '0,0');
for (const value of [null, undefined, '', ' ', 'no', 91, -91, Infinity, NaN, true, []]) assert.equal(destination({ ...row, LATITUDE: value }).coordinates, '');
assert.equal(destination({ ...row, LONGITUDE: 181 }).coordinates, '');
assert.equal(destination({ ...row, CSSTRT: '' }).address, '', 'A house number and town alone are not a street address');
assert.equal(destination({ CSSTRT: 'Oak Rd' }).address, 'Oak Rd', 'Do not invent locality or substitute coordinates');
const cases = [
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)', 'iPhone', 5, 'geo-navigation:'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X)', 'iPhone', 5, 'https:'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.5 Safari/605.1.15', 'MacIntel', 5, 'geo-navigation:'],
  ['Mozilla/5.0 (Linux; Android 15)', 'Linux armv8l', 5, 'intent:'],
  ['Mozilla/5.0 (Windows NT 10.0)', 'Win32', 0, 'https:']
];
for (const [agent, platform, touch, scheme] of cases) {
  const value = '10 Oak & Pine #5;end <img src=x>, Burnet TX';
  const links = context.stopDirectionsLinks(value, agent, platform, touch);
  assert(links.primary.startsWith(scheme));
  const web = new URL(links.web);
  assert.equal(web.searchParams.get('destination') ?? web.searchParams.get('daddr'), value);
  assert(!links.primary.includes('<img'));
  if (scheme === 'geo-navigation:') assert.equal(new URL(links.primary).searchParams.get('destination'), value);
  if (scheme === 'intent:') {
    assert(!links.primary.includes('package='), 'Allow Android to choose the map app');
    assert.equal(links.primary.split('#Intent;').length, 2);
    assert.equal(decodeURIComponent(links.primary.match(/S.browser_fallback_url=([^;]+)/)[1]), links.web);
  }
}
console.log('PASS: destination completeness, locality, zero/invalid coordinates, full precision, encoded addresses, Apple/Android/desktop links and fallback destinations.');
