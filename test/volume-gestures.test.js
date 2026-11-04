'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
function gesture(){
 const listeners={},changes=[],brightness=[],seeks=[],M={volume:.5,muted:false};
 const stage={clientWidth:1000,clientHeight:600,getBoundingClientRect:()=>({left:0}),dataset:{idle:'false'},addEventListener:(name,fn)=>{(listeners[name]??=[]).push(fn)}};
 const context=vm.createContext({stage,M,pictureBrightness:.8,changeBrightness:delta=>{context.pictureBrightness=Math.max(.2,Math.min(1,context.pictureBrightness+delta));brightness.push(context.pictureBrightness);},video:{},window:{ontouchstart:null},performance:{now:()=>100},idleTimer:null,setIdle(){},clearTimeout(){},
 changeVolume:delta=>{M.volume=Math.max(0,Math.min(1,M.volume+delta));changes.push(M.volume);return true;},seekBy:delta=>seeks.push(delta)});
 vm.runInContext(source.slice(source.indexOf('const SWIPE_SKIP ='),source.indexOf('const onStageClick =')),context);
 const target={closest:()=>null},emit=(name,x,y,extra={})=>listeners[name]?.forEach(fn=>fn({target,touches:[{clientX:x,clientY:y}],changedTouches:[{clientX:x,clientY:y}],cancelable:true,preventDefault(){},...extra}));
 return {M,changes,brightness,seeks,emit};
}
test('up/down swipes adjust local volume continuously without seeking',()=>{
 const f=gesture();f.emit('touchstart',800,300);f.emit('touchmove',802,180);assert.ok(Math.abs(f.M.volume-.7)<.001);
 f.emit('touchend',802,180);assert.equal(f.seeks.length,0);
 f.emit('touchstart',800,200);f.emit('touchmove',800,380);f.emit('touchend',800,380);assert.ok(Math.abs(f.M.volume-.4)<.001);
});
test('horizontal seeking remains separate from volume and diagonal movement is ignored',()=>{
 const f=gesture();f.emit('touchstart',100,300);f.emit('touchmove',260,302);f.emit('touchend',260,302);
 assert.deepEqual(f.seeks,[20]);assert.equal(f.changes.length,0);
 f.emit('touchstart',100,100);f.emit('touchend',150,150);assert.equal(f.seeks.length,1);assert.equal(f.changes.length,0);
});
test('swipes over controls and multi-touch do not change volume',()=>{
 const f=gesture();const target={closest:()=>({})};
 f.emit('touchstart',100,300,{target});f.emit('touchmove',100,100,{target});f.emit('touchend',100,100,{target});assert.equal(f.changes.length,0);
 f.emit('touchstart',100,300,{touches:[{},{}]});f.emit('touchend',100,100);assert.equal(f.changes.length,0);
});
test('read-only native volume reports device control rather than a false percentage',()=>{
 const hints=[];const M={muted:false,get volume(){return 1},set volume(value){}};
 const context=vm.createContext({M,player:{autoMuted:false},osd:value=>hints.push(value),unblock(){},scheduleUi(){},store:{set(){throw Error('must not persist fictitious volume')}},$:()=>({})});
 vm.runInContext(source.slice(source.indexOf('function changeVolume('),source.indexOf('function unblock()')),context);
 assert.equal(context.changeVolume(-.2),false);assert.deepEqual(hints,['Use your device volume buttons']);
});

test('left-side vertical swipes adjust brightness and stay on their starting side',()=>{
 const f=gesture();f.emit('touchstart',200,300);f.emit('touchmove',202,420);f.emit('touchend',202,420);
 assert.ok(Math.abs(f.brightness.at(-1)-.6)<.001);assert.equal(f.changes.length,0);assert.equal(f.seeks.length,0);
 f.emit('touchstart',200,300);f.emit('touchmove',202,220);f.emit('touchmove',700,100);f.emit('touchend',700,100);
 assert.equal(f.changes.length,0);assert.equal(f.seeks.length,0);assert.ok(f.brightness.at(-1)>.6);
});
