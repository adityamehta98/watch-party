'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function helpers() {
  const context = vm.createContext({ URL });
  for (const file of ['services.js','playback-history.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',file),'utf8'),context);
  return context.WPPlayback;
}
test('history preserves separate episodes, the latest actually watched episode and sanitized positions across instances', async()=>{
  const p=helpers(), data=new Map(), storage={get:async key=>({[key]:data.get(key)}),set:async values=>{for(const[key,value]of Object.entries(values))data.set(key,value);}};
  const key=p.key('netflix','A show',{type:'tv',tmdbId:4}), history=new p.History(storage,key,'netflix');
  await history.load();
  await history.record({assetId:'1',showId:'4',url:'https://www.netflix.com/watch/1',season:1,episode:1,position:600,duration:1800,lastWatched:10});
  await history.record({assetId:'2',showId:'4',url:'https://www.netflix.com/watch/2',season:1,episode:2,position:120,duration:1800,lastWatched:20});
  const reloaded=new p.History(storage,key,'netflix'), latest=await reloaded.load();
  assert.equal(latest.assetId,'2');assert.equal(latest.position,120);assert.equal(reloaded.entries['1'].position,600);
  assert.notEqual(key,p.key('netflix','A show',{type:'movie',tmdbId:4}));
  assert.notEqual(key,p.key('prime','A show',{type:'tv',tmdbId:4}));
});
test('progress never trusts foreign, login, search, credentialed or invalid asset URLs',()=>{
  const p=helpers();
  for(const url of ['https://evil.test/watch/123','https://netflix.com.evil.test/watch/123','http://www.netflix.com/watch/123','https://name:secret@www.netflix.com/watch/123','https://www.netflix.com/search?q=123','https://www.netflix.com/login'])assert.equal(p.asset(url,'netflix'),null,url);
  assert.equal(p.asset('https://www.netflix.com/watch/123?trackId=4','netflix').url,'https://www.netflix.com/watch/123');
});
test('native playback routes identify assets for all automated streaming services',()=>{
  const p=helpers();
  const routes={netflix:'https://www.netflix.com/watch/123',prime:'https://www.primevideo.com/detail/B01234',hulu:'https://www.hulu.com/watch/abcd-123',peacock:'https://www.peacocktv.com/watch/playback/vod/abcd-123',crunchyroll:'https://www.crunchyroll.com/watch/ABCD123/title',paramount:'https://www.paramountplus.com/shows/video/abcd-123/',max:'https://play.max.com/video/watch/abcd-123',disney:'https://www.disneyplus.com/play/abcd-123',appletv:'https://tv.apple.com/us/episode/title/umc.cmc.123'};
  for(const[service,url]of Object.entries(routes))assert.ok(p.asset(url,service),service);
});
test('a rejected storage write is observable and a later write can recover',async()=>{
  const p=helpers();let fail=true,stored;
  const history=new p.History({get:async()=>({}),set:async value=>{if(fail)throw new Error('quota');stored=value;}},'key','netflix');
  const entry={assetId:'1',url:'https://www.netflix.com/watch/1',position:30,duration:120,lastWatched:1};
  await assert.rejects(history.record(entry),/quota/);fail=false;await history.record({...entry,position:40});
  assert.equal(stored.key.entries['1'].position,40);
});
