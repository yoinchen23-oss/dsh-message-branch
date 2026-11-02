import fs from 'node:fs';
import vm from 'node:vm';
let plugin;
const React={createElement(){},useState(){return [false,()=>{}]},useSyncExternalStore(){return {}},useRef(){return {current:false}},Fragment:{}};
const context={window:{__ModuleLoader__:{load(x){plugin=x.factory(name=>name==='react'?React:null)}}}};
vm.runInNewContext(fs.readFileSync(new URL('./lib/client.js',import.meta.url),'utf8'),context);
if(plugin?.name!=='local-message-branch') throw new Error('bundle name');
if(JSON.stringify(plugin.inject)!=='["slots","sessions","uiWorkspace"]') throw new Error('inject contract');
console.log('BUNDLE_CONTRACT_OK');
