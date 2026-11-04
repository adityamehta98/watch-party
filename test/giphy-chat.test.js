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
function fixture({key='exampleGiphyBetaKey',request,catalogLoad,globals}={}) {
 const nodes=new Map(), tabs=[new Element(),new Element(),new Element()];tabs[0].dataset.mode='emoji';tabs[1].dataset.mode='gif';tabs[2].dataset.mode='sticker';
 for(const sel of ['.picker input','select','nav','.grid','.heading','.more','.gifs','.gifs input','.gif-grid','.status','.find','.picker','.scroll','.stickers','.stickers input','.sticker-grid','.sticker-status','.sticker-more'])nodes.set(sel,new Element());
 nodes.get('select').value='default'; nodes.get('.gifs').hidden=true;nodes.get('.stickers').hidden=true;
 const root={querySelector:s=>nodes.get(s),querySelectorAll:()=>tabs}, picked=[];
 const container=new Element(); container.ownerDocument={createElement:()=>new Element()};container.attachShadow=()=>root;
 const api=load(globals).create(container,{load:catalogLoad||(async()=>({groups:['Faces'],emojis:[['😀','smile',0]],stickers:[['😀','Smile',0,'1f600'],['👋','Wave',1,'1f44b']]})),onPick:v=>picked.push(v),giphyKey:()=>typeof key === 'function' ? key() : key,request});
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

test('Google sticker fallback uses no search API and stops repeated quota requests',async()=>{
 let calls=0;const f=fixture({request:async()=>{calls++;throw Object.assign(Error('Free GIF search limit reached.'),{status:429});}});
 await f.api.open();f.tabs[1].listeners.click();await tick();assert.equal(calls,1);
 assert.equal(f.nodes.get('.gifs').hidden,true);assert.equal(f.nodes.get('.stickers').hidden,false);assert.equal(f.nodes.get('.sticker-grid').children.length,2);
 f.tabs[1].listeners.click();await tick();assert.equal(calls,1,'quota cooldown does not keep spending failed requests');
 f.nodes.get('.stickers input').value='wave';f.nodes.get('.stickers input').listeners.input();assert.equal(f.nodes.get('.sticker-grid').children.length,1);assert.equal(calls,1,'sticker search is local');
 f.nodes.get('.sticker-grid').children[0].listeners.click();assert.equal(f.picked[0],'https://fonts.gstatic.com/s/e/notoemoji/latest/1f44b/512.webp');
});
test('Google stickers work without a key and their messages retain safe attribution',async()=>{
 let calls=0;const f=fixture({key:'',request:async()=>{calls++;}});await f.api.open();f.tabs[2].listeners.click();assert.equal(calls,0);assert.equal(f.nodes.get('.sticker-grid').children.length,2);
 const picker=load(),url='https://fonts.gstatic.com/s/e/notoemoji/latest/1f600/512.webp';assert.equal(picker.mediaUrl(url),url);assert.match(picker.chatHtml(url),/Google Noto/);assert.match(picker.chatHtml(url),/CC BY 4.0/);
 for(const bad of ['https://fonts.gstatic.com/evil.svg','https://fonts.gstatic.com/s/e/notoemoji/latest/evil/512.webp','https://fonts.gstatic.com.evil.test/s/e/notoemoji/latest/1f600/512.webp'])assert.equal(picker.mediaUrl(bad),null);
 assert.match(picker.chatHtml('😀'),/font-size:32px/);assert.doesNotMatch(picker.chatHtml('hello 😀'),/font-size:32px/);assert.doesNotMatch(picker.chatHtml('123'),/font-size:32px/);
});
test('media drafts show a removable preview, restore typed text and clear after sending',async()=>{
 class DraftElement extends Element {
  constructor(){super();this.style={};this.value='';this.selectionStart=0;this.selectionEnd=0;}
  append(...children){this.children.push(...children);} removeAttribute(name){delete this[name];} focus(){this.focused=true;}
  dispatchEvent(event){this.listeners[event.type]?.(event);}
  setRangeText(value,start,end){this.value=this.value.slice(0,start)+value+this.value.slice(end);this.selectionStart=this.selectionEnd=start+value.length;}
 }
 const input=new DraftElement(),holder=new DraftElement();holder.insertBefore=child=>holder.children.push(child);input.parentNode=holder;input.ownerDocument={createElement:()=>new DraftElement()};input.form=new DraftElement();const submit=new DraftElement();input.form.querySelector=()=>submit;
 const api=load({queueMicrotask}),draft=api.createDraft(input);input.value='Unsent text';draft.pick(valid);
 const card=holder.children[0];assert.equal(input.hidden,true);assert.equal(submit.focused,true);assert.equal(card.children[0].src,valid);assert.equal(card.children[1].textContent,'GIF ready to send');
 card.children[2].listeners.click();assert.equal(input.value,'Unsent text');assert.equal(input.hidden,false);
 draft.pick(valid);input.value='';input.dispatchEvent({type:'input'});assert.equal(input.hidden,false);assert.equal(card.style.display,'none');
 draft.pick('https://fonts.gstatic.com/s/e/notoemoji/latest/1f600/512.webp');assert.equal(card.children[1].textContent,'Sticker ready to send');
});


test('sent GIFs and stickers contain only the clickable image, with attribution in accessible metadata',()=>{
 const api=load();
 for(const url of [valid,'https://fonts.gstatic.com/s/e/notoemoji/latest/1f600/512.webp']){
  const html=api.chatHtml(url);
  assert.equal(html.replace(/<[^>]*>/g,''),'','no visible link captions');
  assert.match(html,/<a [^>]*title=/);assert.match(html,/<img [^>]*alt=/);assert.doesNotMatch(html,/<small>/);
 }
 assert.match(api.chatHtml(valid),/GIF from GIPHY/);
 assert.match(api.chatHtml('https://fonts.gstatic.com/s/e/notoemoji/latest/1f600/512.webp'),/CC BY 4.0/);
});

test('room, extension sidebar and video overlay clear drafts synchronously in their real send handlers',()=>{
 class DraftElement extends Element {
  constructor(){super();this.style={};this.value='';}
  append(...children){this.children.push(...children);} removeAttribute(name){delete this[name];} focus(){}
  dispatchEvent(event){this.listeners[event.type]?.(event);}
 }
 for(const surface of ['room','sidebar','overlay']){
  const input=new DraftElement(),holder=new DraftElement(),form=new DraftElement();holder.insertBefore=child=>holder.children.push(child);input.parentNode=holder;input.ownerDocument={createElement:()=>new DraftElement()};input.form=form;
  const sent=[],context=vm.createContext({URL,URLSearchParams,Event:class{constructor(type){this.type=type;}},isHost:true,S:{perms:{chat:true}},conn:{send:m=>sent.push(m)},act:m=>sent.push(m),noPerm:()=>{throw Error('unexpected permission failure');},$:selector=>selector==='#chatForm'?form:input,root:{getElementById:id=>id==='form'?form:input}});
  vm.runInContext(source,context);const draft=context.WpEmoji.createDraft(input),card=holder.children[0];
  let handler;
  if(surface==='room'){
   const app=fs.readFileSync(require('node:path').join(__dirname,'../public/js/app.js'),'utf8');
   vm.runInContext(app.match(/function sendChat\(input\) \{[\s\S]*?\n\}/)[0],context);handler=()=>context.sendChat(input);
  }else{
   const file=surface==='sidebar'?'sidebar':'service',js=fs.readFileSync(require('node:path').join(__dirname,'../extension/'+file+'.js'),'utf8');
   const start=js.indexOf(surface==='sidebar'?"$('#chatForm').addEventListener('submit'":"root.getElementById('form').addEventListener('submit'");
   assert.ok(start>=0);const end=js.indexOf('\n'+(surface==='sidebar'?'':'    ')+'});',start);
   assert.ok(end>start);vm.runInContext(js.slice(start,end)+ '\n});',context);handler=()=>form.listeners.submit({preventDefault(){}});
  }
  for(const url of [valid,'https://fonts.gstatic.com/s/e/notoemoji/latest/1f602/512.webp']){
   draft.pick(url);assert.equal(input.hidden,true);handler();
   assert.equal(sent.at(-1).text,url,surface);assert.equal(input.value,'',surface);assert.equal(input.hidden,false,surface);assert.equal(card.style.display,'none',surface);assert.equal(card.children[0].src,undefined,surface);
  }
  if(surface==='room'){
   draft.pick(valid);context.isHost=false;context.S.perms.chat=false;context.noPerm=()=>{};handler();assert.equal(input.value,valid,'permission rejection preserves the draft');assert.equal(card.style.display,'flex');
  }
 }
});


test('idle preload prepares emoji before opening, shares in-flight work and never calls GIPHY',async()=>{
 const idle=[];let loads=0,requests=0,release;
 const f=fixture({globals:{requestIdleCallback:callback=>idle.push(callback)},catalogLoad:()=>{loads++;return new Promise(resolve=>{release=resolve;});},request:async()=>{requests++;return {data:[]};}});
 assert.equal(idle.length,1);assert.equal(loads,0,'work waits until idle');
 const warming=idle[0]();await tick();assert.equal(loads,1);
 const opening=f.api.open(),preloading=f.api.preload();assert.equal(loads,1,'opening during preload shares the catalog request');
 release({groups:['Faces'],emojis:[['😀','smile',0]],stickers:[]});await Promise.all([warming,opening,preloading]);
 const first=f.nodes.get('.grid').children[0];assert.ok(first,'first page is already rendered');
 await f.api.open();assert.equal(f.nodes.get('.grid').children[0],first,'opening reuses the prepared page');assert.equal(loads,1);assert.equal(requests,0,'background preparation spends no GIF calls');
});

test('a failed background emoji preload remains retryable on first open',async()=>{
 let loads=0;const idle=[];const f=fixture({globals:{requestIdleCallback:callback=>idle.push(callback)},catalogLoad:async()=>{if(++loads===1)throw Error('temporary disconnect');return {groups:['Faces'],emojis:[['😀','smile',0]]};}});
 await idle[0]();assert.match(f.nodes.get('.heading').textContent,/reopen to retry/);
 await f.api.open();assert.equal(loads,2);assert.equal(f.nodes.get('.grid').children.length,1);
});
