import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
function load() {
  let plugin;
  const React = { Fragment: Symbol('Fragment'), createElement:(type,props,...children)=>({type,props:props||{},children}), useSyncExternalStore:(_s,s)=>s(), useState:v=>[v,()=>{}], useRef:v=>({current:v}) };
  const context = { window:{__ModuleLoader__:{load({factory}){plugin=factory(name=>name==='react'?React:undefined);}}}, crypto:{randomUUID:()=> 'request-1'}, confirm:()=>true };
  const instrumented=source.replace(/return \{\n\s+name:/,"return {\n __candidates:candidates,\n name:");
  vm.runInNewContext(instrumented,context,{filename:'lib/client.js'});
  return {plugin,candidates:plugin.__candidates};
}
const event=(seq,type,data={},surfaceOp='append')=>({type:'event',event:{type,seq,data,surfaceOp}});
const user=(seq,text='原问题',blocks=[{type:'text',text}],source={kind:'user'},surfaceOp='append')=>event(seq,'user/message',{source,content:blocks},surfaceOp);

test('ModuleLoader bundle loads and pure text candidate uses immediate durable predecessor',()=>{
 const {plugin,candidates}=load(); assert.equal(plugin.name,'local-message-branch');
 const rows=candidates([event(1,'turn/end'),user(2),event(3,'assistant/message')]);
 assert.equal(rows.length,1); assert.equal(rows[0].seq,2); assert.equal(rows[0].atSeq,1); assert.equal(rows[0].text,'原问题'); assert.equal(rows[0].reason,'');
});
test('source, attachments and replacement are filtered/fail closed',()=>{
 const {candidates}=load(); const rows=candidates([user(1,'sys',undefined,{kind:'system-prompt'}),user(2,'图',[{type:'image',attachment:{}}]),user(3,'替换',undefined,{kind:'user'},{op:'replace',startSeq:2,endSeq:2})]);
 assert.equal(rows.length,2); assert.equal(rows[0].reason,'含附件，暂不支持重发'); assert.equal(rows[1].reason,'替换事件暂不支持');
});
test('missing predecessor refuses boundary',()=>{
 const {candidates}=load(); const rows=candidates([user(10,'断页')]); assert.equal(rows[0].atSeq,undefined); assert.equal(rows[0].reason,'请加载更早历史以确认分支边界');
});
test('host half is inert and package keeps browser entry separate',async()=>{
 const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')); const host=await import('../lib/index.js');
 assert.equal(typeof host.apply,'function'); assert.equal(host.apply(),undefined); assert.equal(pkg.main,'lib/index.js'); assert.equal(pkg.exports['./client'],'./lib/client.js');
});
test('static audit records client wrapper calls (not evidence of a host/client mismatch)',()=>{
 assert.match(source,/sessions\.using\(created/); assert.match(source,/target\.session\.prompt\(\[\{type:'text',text\}\], 'queue',undefined,crypto\.randomUUID\(\)\)/);
 assert.match(source,/const operations = new Map\(\)/);
 assert.match(source,/previousOperation\.busy/);
});
