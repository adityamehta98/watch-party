'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('returning home saves progress before stopping playback and clears pending launch UI', () => {
  const actions = [];
  const context = vm.createContext({
    conn: { send: message => actions.push(['send', message]) },
    pendingCatalogService: { id: 'netflix' },
    saveAnimeProgress: (status, flush) => actions.push(['save', flush]),
    savePlaybackProgress: (status, flush) => actions.push(['save-playback', flush]),
    hideTuneIn: force => actions.push(['loading', force]),
    closeYouTube: () => actions.push(['browser']),
    closePops: () => actions.push(['popovers']),
  });
  const app = require('./app-source');
  vm.runInContext(app.slice(app.indexOf('function returnHome()'), app.indexOf("$('#homeBtn').addEventListener")), context);
  context.returnHome();
  assert.deepEqual(actions[0], ['save', true]);
  assert.deepEqual(JSON.parse(JSON.stringify(actions.at(-1))), ['send', { type: 'select-movie', id: null }]);
  assert.equal(context.pendingCatalogService, null);
  assert.ok(actions.some(action => action[0] === 'loading' && action[1] === true));
});
