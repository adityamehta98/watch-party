'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { Room } = require('../server/room');
const catalog = require('../public/data/emoji.json');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
test('local Unicode catalog covers categories and complete multi-codepoint sequences', () => {
  assert.equal(catalog.version, '18.0'); assert.equal(catalog.emojis.length, 3963);
  assert.equal(new Set(catalog.emojis.map(row => row[0])).size, catalog.emojis.length);
  assert.ok(catalog.emojis.some(([emoji]) => emoji === '🇮🇳')); assert.ok(catalog.emojis.some(([emoji]) => emoji === '👍🏽'));
  assert.ok(catalog.emojis.some(([emoji, name]) => name.includes('family') && emoji.includes('\u200d')));
  assert.ok(Math.max(...catalog.emojis.map(row => row[0].length)) <= 64);
  assert.equal(read('extension/emoji-data.json'), read('public/data/emoji.json'));
  assert.equal(read('extension/emoji-picker.js'), read('public/js/emoji-picker.js'));
  assert.match(read('extension/emoji.LICENSE.txt'), /UNICODE LICENSE V3/);
});
test('emoji search, categories and skin tones expose the full catalog', () => {
  const context = vm.createContext({}); vm.runInContext(read('public/js/emoji-picker.js'), context);
  const search = context.WpEmoji.search;
  assert.ok(search(catalog, 'giraffe', 0).some(([emoji]) => emoji === '🦒'));
  assert.ok(search(catalog, 'thumbs up', 0, '🏽').some(([emoji]) => emoji === '👍🏽'));
  assert.ok(search(catalog, '', catalog.groups.indexOf('Flags')).length > 200);
  assert.equal(search(catalog, 'no-such-emoji-name').length, 0);
  assert.ok(search(catalog, '', 1, 'all').length > search(catalog, '', 1, 'default').length);
});
test('room keeps reactions compact while chat preserves complete emoji sequences', t => {
  const room = new Room({ config: { adminKey: 'host-secret', roomKey: 'guestsecretkey1234', room: {} }, library: {} }); t.after(() => room.shutdown());
  const messages = [], guest = { id: 'guest1', name: 'Guest', role: 'guest', admitted: true, perms: { react: true, chat: true }, lastReact: [], ws: { readyState: 1, send: raw => messages.push(JSON.parse(raw)) } };
  room.clients.set(guest.id, guest);
  const longest = catalog.emojis.reduce((a, b) => a[0].length > b[0].length ? a : b)[0];
  room.onMessage(guest, { type: 'react', emoji: '😂' }); assert.equal(messages[0].emoji, '😂');
  for (const emoji of [longest, '🇮🇳', 'not-an-emoji', '<script>', '👍👍']) room.onMessage(guest, { type: 'react', emoji });
  assert.equal(messages.length, 1); guest.perms.react = false;
  room.onMessage(guest, { type: 'react', emoji: '😂' }); assert.equal(messages.length, 1);
  room.onMessage(guest, { type: 'chat', text: `Hello ${longest} 🇮🇳 👍🏽` });
  assert.equal(messages.at(-1).message.text, `Hello ${longest} 🇮🇳 👍🏽`);
});

test('skin tones keep neutral emoji visible and select matching variants in every category',()=>{
 const context=vm.createContext({});vm.runInContext(read('public/js/emoji-picker.js'),context);const search=context.WpEmoji.search;
 for(const tone of ['🏻','🏼','🏽','🏾','🏿']){
  assert.ok(search(catalog,'',0,tone).some(([emoji])=>emoji==='😀'),'faces remain visible for '+tone);
  assert.ok(search(catalog,'',catalog.groups.indexOf('Animals & Nature'),tone).some(([emoji])=>emoji==='🦒'));
  const thumbs=search(catalog,'thumbs up',-1,tone).map(([emoji])=>emoji);
  assert.ok(thumbs.includes('👍'+tone));assert.ok(!thumbs.includes('👍'));
  assert.ok(thumbs.every(emoji=>(emoji.match(/[\u{1f3fb}-\u{1f3ff}]/gu)||[]).every(value=>value===tone)));
  const hands=search(catalog,'',catalog.groups.indexOf('People & Body'),tone).map(([emoji])=>emoji);
  assert.ok(hands.includes('☝'+tone));assert.ok(!hands.includes('☝️'),'variation selectors do not duplicate the neutral hand');
 }
 assert.ok(search(catalog,'',-1,'all').some(([emoji])=>emoji==='👍🏿'));
 assert.ok(search(catalog,'',-1,'default').every(([emoji])=>!/[\u{1f3fb}-\u{1f3ff}]/u.test(emoji)));
});

test('bundled animated sticker metadata references only official Google assets',()=>{
 assert.equal(catalog.stickers.length,881);assert.equal(new Set(catalog.stickers.map(row=>row[3])).size,catalog.stickers.length);
 for(const row of catalog.stickers){assert.equal(typeof row[1],'string');assert.match(row[3],/^[a-f0-9]{4,6}(?:_[a-f0-9]{4,6})*$/);}
 assert.match(read('public/data/noto.LICENSE.txt'),/Attribution 4.0 International/);assert.equal(read('extension/noto.LICENSE.txt'),read('public/data/noto.LICENSE.txt'));
});
