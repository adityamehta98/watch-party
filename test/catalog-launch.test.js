'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { identify } = require('../server/services');
const { Room } = require('../server/room');

const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const launchSource = app.slice(app.indexOf('function launchCatalogService('), app.indexOf('\nfunction onCatalogResponse('));
const mediaModule = () => import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(path.join(__dirname, '../public/js/media.js'), 'utf8')).toString('base64')}`);

async function fixture(t, { newTab = false, isTheater = false, installed = true, platform = 'chromium' } = {}) {
  const { SERVICE_SEARCH, SERVICE_HOMES, extOutdated, REQUIRED_EXT_VERSION } = await mediaModule();
  const sent = [], opened = [], hidden = [];
  const room = new Room({ config: { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234', room: {} }, library: {} });
  t.after(() => room.shutdown());
  const context = vm.createContext({ URL, Date, encodeURIComponent, SERVICE_SEARCH, SERVICE_HOMES, extOutdated,
    pendingCatalogService: null, S: { movie: null }, isTheater,
    kindOf: movie => movie?.kind || 'file',
    $: () => ({ checked: newTab }), hideTuneIn: force => hidden.push(force),
    conn: { send: message => sent.push(message) },
    remote: { present: installed, platform, version: REQUIRED_EXT_VERSION,
      post: message => opened.push(JSON.parse(JSON.stringify(message))), openPanel: () => opened.push({ type: 'panel' }) },
    togglePip: () => opened.push({ type: 'pip' }), enterTheater: () => opened.push({ type: 'theater' }),
    theaterPost: message => opened.push(JSON.parse(JSON.stringify(message))),
  });
  vm.runInContext(launchSource, context);
  return { context, sent, opened, hidden, room,
    acknowledge() {
      const message = sent.at(-1);
      room.onMessage({ admitted: true, name: 'Host', role: 'host' }, message);
      context.S.movie = room.publicMovie();
      context.finishCatalogServiceLaunch();
    } };
}

test('catalog Netflix click opens the selected service after the room accepts it, with no stream overlay', async t => {
  const f = await fixture(t);
  f.context.launchCatalogService('netflix', { title: "India's Got Latent" });
  assert.deepEqual(f.hidden, [true]);
  assert.equal(f.sent[0].type, 'select-url');
  assert.equal(f.sent[0].browsing, true);
  assert.equal(f.sent[0].launchTitle, "India's Got Latent");
  assert.deepEqual(f.opened, [], 'wait for the accepted service before opening the theater');
  f.acknowledge();
  assert.equal(f.room.movie.kind, 'service');
  assert.equal(f.room.movie.service, 'netflix');
  assert.equal(f.room.publicMovie().launchTitle, "India's Got Latent");
  assert.equal(new URL(f.room.movie.url).searchParams.get('q'), "India's Got Latent");
  assert.deepEqual(f.opened, [{ type: 'theater' }]);
  f.context.finishCatalogServiceLaunch();
  assert.equal(f.opened.length, 1, 'repeated state/extension messages cannot open twice');
  f.context.launchCatalogService('netflix', { title: "India's Got Latent" });
  assert.equal(f.opened.length, 2, 'clicking the already-selected service can reopen it without another movie broadcast');
});

test('every supported catalog service launches through the shared theater path', async t => {
  const { SERVICE_SEARCH } = await mediaModule();
  for (const service of Object.keys(SERVICE_SEARCH)) {
    const f = await fixture(t);
    f.context.launchCatalogService(service, { title: 'A requested title' });
    f.acknowledge();
    assert.equal(f.room.movie.service, service);
    assert.deepEqual(f.opened, [{ type: 'theater' }], service);
    assert.deepEqual(f.hidden, [true], service);
  }
});

test('a service selected inside the theater navigates the service frame directly', async t => {
  const f = await fixture(t, { isTheater: true });
  f.context.launchCatalogService('netflix', { title: 'Another title' });
  f.acknowledge();
  assert.equal(f.opened[0].wpTheater, 'goto');
  assert.equal(new URL(f.opened[0].url).searchParams.get('q'), 'Another title');
});

test('separate-tab preference and Safari launch the service using the requested search', async t => {
  for (const options of [{ newTab: true }, { platform: 'safari' }]) {
    const f = await fixture(t, options);
    f.context.launchCatalogService('prime', { title: 'A movie & friends' });
    f.acknowledge();
    const open = f.opened.find(message => message.type === 'open');
    assert.equal(open.service, 'prime');
    assert.equal(new URL(open.url).searchParams.get('phrase'), 'A movie & friends');
  }
});

test('missing extensions and unrelated movie confirmations do not launch the wrong service', async t => {
  const missing = await fixture(t, { installed: false });
  missing.context.launchCatalogService('netflix', { title: 'A title' });
  missing.acknowledge();
  assert.deepEqual(missing.opened, []);
  assert.deepEqual(missing.hidden, [true], 'setup can be shown without an unfinishable native player overlay');
  const other = await fixture(t);
  other.context.launchCatalogService('netflix', { title: 'A title' });
  other.context.S.movie = { kind: 'service', service: 'netflix', url: 'https://www.netflix.com/search?q=different' };
  other.context.finishCatalogServiceLaunch();
  assert.deepEqual(other.opened, []);
});

test('all service search terms survive server URL cleaning while tracking parameters are removed', async () => {
  const { SERVICE_SEARCH } = await mediaModule();
  for (const [service, search] of Object.entries(SERVICE_SEARCH)) {
    const original = new URL(search(encodeURIComponent("India's Got Latent & more")));
    const [key, value] = [...original.searchParams][0];
    original.searchParams.set('tracking', 'discard-me');
    const result = identify(original.href);
    assert.equal(result.service, service);
    const actual = new URL(result.url);
    assert.equal(actual.searchParams.get(key), value, service);
    assert.equal(actual.searchParams.has('tracking'), false, service);
  }
  assert.equal(identify('https://www.netflix.com/watch/123?trackId=7&q=irrelevant').url, 'https://www.netflix.com/watch/123');
});

test('catalog identity reaches the accepted movie and remains available after playback follow', async t => {
  const f = await fixture(t), item = { title:'A series',type:'tv',tmdbId:123,year:'2024' };
  f.context.launchCatalogService('netflix',item); f.acknowledge();
  assert.deepEqual(f.room.publicMovie().playbackRef, item);
  f.room.selectUrl({ admitted:true,role:'host',name:'Host' },'https://www.netflix.com/watch/555',false,{follow:true,title:'A series · S2:E3',position:300,playing:true});
  assert.deepEqual(f.room.publicMovie().playbackRef,item);
  assert.equal(f.room.publicMovie().launchTitle,'');
});
