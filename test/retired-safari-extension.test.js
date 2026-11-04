'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const panelSource = app.slice(app.indexOf('function serviceName('), app.indexOf("$('#servicePanel').addEventListener"));
function panel(platform, remote = { present: false }) {
  const element = { hidden: false, innerHTML: '' };
  const context = vm.createContext({ PLATFORM: platform, remote, S: { movie: { kind: 'service', service: 'netflix', title: 'Example', url: 'https://www.netflix.com/watch/123' }, people: [] },
    $: () => element, stage: { classList: { toggle() {} } }, SERVICE_NAMES: { netflix: 'Netflix' }, kindOf: movie => movie.kind,
    esc: value => String(value), isHost: false, isTheater: false, isCustom: () => false, navigator: { userAgent: 'Chrome/130' }, extOutdated: () => false });
  vm.runInContext(panelSource + '\nrenderServicePanel();', context);
  return element.innerHTML;
}
test('Safari/mobile service setup shows a live clock without retired extension installation', () => {
  for (const platform of [{ mobile: true, appleMobile: true, safari: true }, { safari: true }, { mobile: true, android: true }]) {
    const html = panel(platform);
    assert.match(html, /id="followTime"/);
    assert.match(html, /Open Netflix/);
    assert.doesNotMatch(html, /TestFlight|App Store|Download.*extension|safari-source/);
  }
});
test('Chromium installation and linked controls remain available', () => {
  assert.match(panel({}), /watch-party-sync.zip/);
  const html = panel({}, { present: true, linked: true, version: '1.15.2', st: {} });
  assert.match(html, /Synced with your Netflix tab/);
  assert.match(html, /Show the party next to Netflix/);
});