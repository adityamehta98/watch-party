'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname,'../public/js/emoji-picker.js'),'utf8');
const valid = 'https://media2.giphy.com/media/abc123/200w.webp?cid=sample&rid=200w.webp&ct=g';
function load(extra={}) { const c=vm.createContext({URL,URLSearchParams,...extra}); vm.runInContext(source,c); return c.WpEmoji; }
test('GIF rendering allows only HTTPS GIPHY media and preserves rendition query parameters',()=>{
 const picker=load(); assert.equal(picker.mediaUrl(valid),valid); assert.ok(picker.chatHtml(valid).includes('cid=sample&amp;rid='));
 for(const bad of ['javascript:alert(1)','data:image/svg+xml,bad','https://127.0.0.1/media/id/a.gif','https://media2.giphy.com.evil.test/media/id/a.gif','https://media2.giphy.com@evil.test/media/id/a.gif','https://x:secret@media2.giphy.com/media/id/a.gif','https://media2.giphy.com:444/media/id/a.gif','https://media2.giphy.com/media/id/a.svg','http://media2.giphy.com/media/id/a.gif','https://media2.giphy.com/../bad.gif']) {
  assert.equal(picker.mediaUrl(bad),null); assert.ok(!picker.chatHtml(bad).includes('<img'));
 }
 assert.equal(picker.chatHtml('<script>bad()</script>'),'&lt;script&gt;bad()&lt;/script&gt;');
 assert.match(picker.chatHtml(valid),/referrerpolicy="no-referrer"/); assert.match(picker.chatHtml(valid),/rel="noopener noreferrer"/);
 assert.ok(!picker.chatHtml(`hello ${valid}`).includes('<img'), 'only standalone media links become images');
});
class Element {
 constructor(){this.children=[];this.listeners={};this.dataset={};this.value='';this.hidden=false;this.attrs={};}
 addEventListener(type,fn){this.listeners[type]=fn;} setAttribute(k,v){this.attrs[k]=v;}
 appendChild(el){this.children.push(el);} replaceChildren(){this.children=[];}
}
function fixture({key='exampleGiphyBetaKey',request}={}) {
 const nodes=new Map(), tabs=[new Element(),new Element()];tabs[0].dataset.mode='emoji';tabs[1].dataset.mode='gif';
 for(const sel of ['.picker input','select','nav','.grid','.heading','.more','.gifs','.gifs input','.gif-grid','.status','.find','.picker','.scroll'])nodes.set(sel,new Element());
 nodes.get('select').value='default'; nodes.get('.gifs').hidden=true;
 const root={querySelector:s=>nodes.get(s),querySelectorAll:()=>tabs}, picked=[];
 const container=new Element(); container.ownerDocument={createElement:()=>new Element()};container.attachShadow=()=>root;
 const api=load().create(container,{load:async()=>({groups:['Faces'],emojis:[['😀','smile',0]]}),onPick:v=>picked.push(v),giphyKey:()=>typeof key === 'function' ? key() : key,request});
 return {api,nodes,tabs,picked};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('GIF search is opt-in, explicit, PG-rated and adds an unsent draft selection',async()=>{
 const calls=[],f=fixture({request:async url=>{calls.push(url);return {data:[{title:'Hello GIF',images:{fixed_width_small:{webp:valid},fixed_height:{webp:valid}}}]};}});
 await f.api.open();assert.equal(calls.length,0,'opening regular emoji never calls GIPHY');
 f.tabs[1].listeners.click(); await tick(); assert.equal(calls.length,1);assert.equal(new URL(calls[0]).pathname,'/v1/gifs/trending');
 assert.equal(new URL(calls[0]).searchParams.get('rating'),'pg');assert.equal(f.nodes.get('.gif-grid').children.length,1);
 f.nodes.get('.gifs input').value='cats & dogs';assert.equal(calls.length,1,'typing alone makes no request');
 await f.nodes.get('.find').listeners.click();assert.equal(new URL(calls[1]).searchParams.get('q'),'cats & dogs');
 f.nodes.get('.gif-grid').children[0].listeners.click();assert.deepEqual(f.picked,[valid]);assert.match(f.nodes.get('.status').textContent,/press Send/);
 f.tabs[1].listeners.click();await tick();assert.equal(calls.length,2,'tab reopen does not automatically refresh results');
});
test('GIF missing-key and quota errors never retry automatically or leak the key into errors',async()=>{
 let count=0;const noKey=fixture({key:'',request:async()=>{count++;}});noKey.tabs[1].listeners.click();await tick();assert.equal(count,0);assert.match(noKey.nodes.get('.status').textContent,/host.*key/);
 const f=fixture({request:async()=>{count++;throw Error('Free GIF search limit reached. Try again later.');}});f.tabs[1].listeners.click();await tick();assert.equal(count,1);assert.match(f.nodes.get('.status').textContent,/limit reached/);assert.equal(f.nodes.get('.find').disabled,false);await tick();assert.equal(count,1);
});
test('direct GIF requests omit credentials and caching, and handle provider quota responses',async()=>{
 const calls=[];const api=load({fetch:async(url,options)=>{calls.push({url,options});return {ok:false,status:429};}});
 const f=fixture(); // reuse fixture DOM with the default network requester below
 const nodes=f.nodes,tabs=f.tabs; const root={querySelector:s=>nodes.get(s),querySelectorAll:()=>tabs};const c=new Element();c.ownerDocument={createElement:()=>new Element()};c.attachShadow=()=>root;
 api.create(c,{load:async()=>({groups:[],emojis:[]}),onPick(){},giphyKey:()=> 'publicGiphyKeyOnly'});tabs[1].listeners.click();await tick();
 assert.equal(calls.length,1);assert.equal(calls[0].options.cache,'no-store');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.referrerPolicy,'no-referrer');assert.match(nodes.get('.status').textContent,/limit reached/);
});

test('GIF key editing requires local host authentication and validates before saving',async()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../server/index.js'),'utf8');
 const config={adminKey:'host-only-secret'};let saves=0,broadcasts=0;
 const context=vm.createContext({config,isLocal:req=>req.local,safeEq:(a,b)=>a===b,notFound:(_req,res)=>{res.status=404;},sendJson:(res,status,body)=>{res.status=status;res.body=body;},readBody:async req=>req.body,save:()=>{saves++;},room:{broadcastSettings:()=>{broadcasts++;}},info:async()=>({ok:true})});
 vm.runInContext(source.slice(source.indexOf('async function api('),source.indexOf('function media(')),context);
 const call=async(local,key,value)=>{const res={};await context.api({local,method:'POST',headers:{'x-admin-key':key,'content-type':'application/json'},body:{giphyKey:value}},res,'/api/settings');return res;};
 assert.equal((await call(false,'host-only-secret','examplePublicKey123')).status,404);
 assert.equal((await call(true,'guest-key','examplePublicKey123')).status,404);assert.equal(saves,0);
 assert.equal((await call(true,'host-only-secret','invalid<script>')).status,400);assert.equal(saves,0);
 assert.equal((await call(true,'host-only-secret','examplePublicKey123')).status,200);assert.equal(config.giphyKey,'examplePublicKey123');assert.equal(broadcasts,1);
 assert.equal((await call(true,'host-only-secret','')).status,200);assert.equal(config.giphyKey,'');assert.equal(saves,2);
});

test('an open GIF tab automatically loads trending after a key arrives or changes',async()=>{
 let key='',calls=[];const f=fixture({key:()=>key,request:async url=>{calls.push(new URL(url));return {data:[]};}});
 await f.api.open();f.tabs[1].listeners.click();await tick();assert.equal(calls.length,0);
 key='firstPublicGiphyKey';await f.api.open();await tick();assert.equal(calls.length,1);assert.equal(calls[0].pathname,'/v1/gifs/trending');
 await f.api.open();await f.api.open();assert.equal(calls.length,1,'extension refreshes do not consume more quota');
 f.nodes.get('.gifs input').value='old search';key='replacementPublicKey';await f.api.open();await tick();assert.equal(calls.length,2);assert.equal(calls[1].pathname,'/v1/gifs/trending');assert.equal(f.nodes.get('.gifs input').value,'');
});
test('extension refreshes do not repeatedly retry a failed automatic trending load',async()=>{
 let key='',calls=0;const f=fixture({key:()=>key,request:async()=>{calls++;throw Error('Free GIF search limit reached. Try again later.');}});
 f.tabs[1].listeners.click();key='publicGiphyBetaKey';await f.api.open();await tick();assert.equal(calls,1);
 await f.api.open();await f.api.open();await tick();assert.equal(calls,1);
 f.tabs[1].listeners.click();await tick();assert.equal(calls,2,'an explicit user click can retry');
});
