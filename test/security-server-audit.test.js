'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{Readable}=require('node:stream');
const {fetchPublic,isPublicIp,boundedText}=require('../server/upstream');
const {createSessions}=require('../server/sessions');
const {Room}=require('../server/room');
test('private, loopback, mapped and transition IP addresses cannot be proxy targets',async()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2002:7f00:1::'])assert.equal(isPublicIp(ip),false,ip);
 let requested=false;
 await assert.rejects(fetchPublic('https://media.example/a',{lookup:async()=>[{address:'8.8.8.8'},{address:'127.0.0.1'}],request(){requested=true;}}),/blocked host/);
 assert.equal(requested,false);
});
function response(status,headers={},body=''){
 const incoming=Readable.from([Buffer.from(body)]);incoming.statusCode=status;incoming.headers=headers;return incoming;
}
function transport(responses,calls){
 return (url,options,done)=>{calls.push({url,options});const req=new EventEmitter();req.end=()=>queueMicrotask(()=>done(responses.shift()));return req;};
}
test('validated DNS is pinned to the actual socket and redirects into a private network are blocked',async()=>{
 const calls=[];let lookups=0;
 await assert.rejects(fetchPublic('https://media.example/a',{lookup:async()=>{lookups++;return[{address:'8.8.8.8',family:4}]},
 request:transport([response(302,{location:'http://127.0.0.1/private'})],calls)}),/blocked host/);
 assert.equal(calls.length,1);assert.equal(lookups,1);
 calls[0].options.lookup('media.example',{},(error,address)=>{assert.ifError(error);assert.equal(address,'8.8.8.8');});
});
test('cross-origin redirects cannot carry configured upstream cookies or authorization',async()=>{
 const calls=[];
 const result=await fetchPublic('https://media.example/a',{headers:{Authorization:'private',Cookie:'private','X-Token':'private',Range:'bytes=0-2'},
 lookup:async()=>[{address:'8.8.8.8',family:4}],request:transport([response(302,{location:'https://cdn.example/b'}),response(200,{},'abc')],calls)});
 assert.equal(calls[1].options.headers.Authorization,undefined);assert.equal(calls[1].options.headers.Cookie,undefined);assert.equal(calls[1].options.headers['X-Token'],undefined);
 assert.equal(calls[1].options.headers.Range,'bytes=0-2');assert.equal(await result.text(),'abc');
});
test('playlist/text response caps reject oversized headers and streamed bodies',async()=>{
 await assert.rejects(boundedText(new Response('data',{headers:{'content-length':'100'}}),3),/too large/);
 await assert.rejects(boundedText(new Response('abcd'),3),/too large/);
});
test('room session cookies must have an authentic server signature',()=>{
 const sessions=createSessions('private-test-secret'),token=sessions.issue();
 assert.equal(sessions.read({headers:{cookie:'wp_s='+token}}),token);
 assert.equal(sessions.read({headers:{cookie:'wp_s='+token.slice(0,-1)+(token.endsWith('a')?'b':'a')}}),null);
 assert.equal(createSessions('different-secret').read({headers:{cookie:'wp_s='+token}}),null);
});
test('knowing a public client ID cannot resume approval or replace a host',t=>{
 const room=new Room({config:{adminKey:'admin-secret',roomKey:'guestsecretkey1234',room:{requireApproval:true}},library:{list:()=>({items:[]})}});
 t.after(()=>room.shutdown());
 const ws=()=>({readyState:1,send(){},close(){this.closed=true;}});
 const victim=room.hello(ws(),'guest','guestsecretkey1234',{clientId:'victim01',name:'Victim'},{session:'victim-session'});
 victim.admitted=true;room.memory.get(victim.id).admitted=true;
 assert.equal(room.hasAdmittedSession('victim-session'),true);assert.equal(room.hasAdmittedSession('attacker-session'),false);
 const attacker=room.hello(ws(),'guest','guestsecretkey1234',{clientId:'victim01',name:'Attacker'},{session:'attacker-session'});
 assert.notEqual(attacker.id,victim.id);assert.equal(attacker.admitted,false);assert.equal(victim.ws.closed,undefined);
 const host=room.hello(ws(),'host','admin-secret',{clientId:'host0001',name:'Host'},{session:'host-session'});
 const impostor=room.hello(ws(),'guest','guestsecretkey1234',{clientId:host.id,name:'Impostor'},{session:'attacker-session'});
 assert.notEqual(impostor.id,host.id);assert.equal(host.ws.closed,undefined);assert.equal(impostor.admitted,false);
});
test('same browser session can resume an admitted guest without losing approval',t=>{
 const room=new Room({config:{adminKey:'admin-secret',roomKey:'guestsecretkey1234',room:{requireApproval:true}},library:{list:()=>({items:[]})}});
 t.after(()=>room.shutdown());
 const ws=()=>({readyState:1,send(){},close(){this.readyState=3;}});
 const first=room.hello(ws(),'guest','guestsecretkey1234',{clientId:'viewer01',name:'Viewer'},{session:'same-session'});
 first.admitted=true;room.memory.get(first.id).admitted=true;
 const next=room.hello(ws(),'guest','guestsecretkey1234',{clientId:'viewer01',name:'Viewer'},{session:'same-session'});
 assert.equal(next.id,first.id);assert.equal(next.admitted,true);
});
test('DNS-rebinding hostnames that merely begin with 127 are not local host headers',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../server/index.js'),'utf8');
 const text=source.slice(source.indexOf('function isLocalHostHeader('),source.indexOf('const PUBLIC_STUN'));
 const context=vm.createContext({net:require('node:net'),process:{env:{}}});vm.runInContext(text,context);
 assert.equal(context.isLocalHostHeader('127.attacker.example'),false);assert.equal(context.isLocalHostHeader('127.0.0.1:8765'),true);
});
