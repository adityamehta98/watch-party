'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'../public',name),'utf8');
const moduleOf=name=>import('data:text/javascript;base64,'+Buffer.from(read('js/'+name)).toString('base64'));
test('media credentials are never appended to absolute or protocol-relative third-party URLs',async()=>{
 const {deliverySources}=await moduleOf('capabilities.js');
 for(const url of ['https://attacker.example/video','//attacker.example/video','/\\attacker.example/video','javascript:alert(1)']){
   assert.deepEqual(deliverySources({url,hls:url},{hls:true,mse:true},'private-host-key'),[]);
 }
 assert.ok(deliverySources({url:'/media/movie'},{},'key')[0].url.startsWith('/media/movie?'));
});
test('caption loading never sends room credentials to an upstream URL',async()=>{
 const {SubtitleTracks}=await moduleOf('subtitles.js');
 const video={addEventListener(){},ownerDocument:{createElement(){throw Error('unsafe caption created');}}};
 const subtitles=new SubtitleTracks(video);
 subtitles.add({id:'ep4',subs:[{key:'evil',label:'English',url:'https://attacker.example/captions'}]},'private-host-key');
 assert.equal(subtitles.tracks.size,0);
});
test('closing YouTube while its API loads cannot recreate playback after returning home',async()=>{
 const scripts=[],players=[];
 const window={addEventListener(){},postMessage(){}},document={head:{appendChild:s=>scripts.push(s)},createElement:()=>({})};
 const context=vm.createContext({window,document,location:{origin:'http://127.0.0.1:8765'},EventTarget,Event,performance,URL,setInterval(){},setTimeout(){},clearTimeout(){}});
 vm.runInContext(read('js/media.js').replace(/^export /gm,'')+'\nglobalThis.Media=YouTubeMedia;',context);
 const host={innerHTML:'',appendChild(){}},media=new context.Media(host);
 const opening=media.open({videoId:'video'});
 assert.equal(scripts.length,1);media.close();
 window.YT={Player:class{constructor(...args){players.push(args);}}};
 window.onYouTubeIframeAPIReady();await opening;
 assert.equal(players.length,0);assert.equal(media.src,'');
 await media.open({videoId:'next'});
 assert.equal(players[0][1].host,'https://www.youtube-nocookie.com');
});
test('extension messages need the current window and exact page origin',()=>{
 const window={addEventListener(){},postMessage(){}},location={origin:'http://127.0.0.1:8765'};
 const context=vm.createContext({window,location,URL,EventTarget,Event,performance,setInterval(){},setTimeout(){},clearTimeout(){}});
 vm.runInContext(read('js/media.js').replace(/^export /gm,'')+'\nglobalThis.Media=RemoteMedia;',context);
 const media=new context.Media();
 media.onMessage({source:window,origin:'https://attacker.example',data:{source:'wp-ext',type:'hello',version:'99'}});
 assert.equal(media.present,false);
 media.onMessage({source:window,origin:location.origin,data:{source:'wp-ext',type:'hello',version:'99'}});
 assert.equal(media.present,true);
});
test('offline shell cache excludes room HTML, messages, credentials and media',()=>{
 const source=read('sw.js'),cached=/const SHELL = new Set\(\[([\s\S]*?)\]\)/.exec(source)[1];
 const paths=[...cached.matchAll(/'([^']+)'/g)].map(m=>m[1]);
 assert.ok(paths.length>10);
 for(const value of paths) assert.match(value,/^\/(?:js\/|css\/|vendor\/|data\/emoji\.json$|favicon\.svg$|icon-\d+\.png$)/);
});
