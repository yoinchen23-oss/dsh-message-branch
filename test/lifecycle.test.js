import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function load({ confirm = () => true } = {}) {
  let plugin;
  const instances = new Map();
  let rerender = () => {};
  let current = null;
  let hookIndex = 0;
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } };
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const instance = instances.get(current);
      const index = hookIndex++;
      if (!instance.hooks[index]) {
        instance.hooks[index] = { value: getSnapshot() };
        instance.cleanups.push(subscribe(() => {
          instance.hooks[index].value = getSnapshot();
          rerender();
        }));
      } else {
        instance.hooks[index].value = getSnapshot();
      }
      return instance.hooks[index].value;
    },
    useState(initial) {
      const instance = instances.get(current);
      const index = hookIndex++;
      if (!instance.hooks[index]) instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [instance.hooks[index].value, value => {
        instance.hooks[index].value = typeof value === 'function' ? value(instance.hooks[index].value) : value;
        rerender();
      }];
    },
    useRef(initial) {
      const instance = instances.get(current);
      const index = hookIndex++;
      if (!instance.hooks[index]) instance.hooks[index] = { current: initial };
      return instance.hooks[index];
    },
  };
  const context = {
    window: { confirm, __ModuleLoader__: { load({ factory }) { plugin = factory(name => name === 'react' ? React : undefined); } } },
    crypto: { randomUUID: () => 'request-1' },
    confirm,
  };
  const instrumented = source.replace(
    'return {\n    name:',
    'return {\n    __Panel:InlineEditor, __UserRenderer:UserRenderer,\n    name:',
  );
  vm.runInNewContext(instrumented, context, { filename: 'lib/client.js' });

  function render(vnode, key = 'root') {
    if (vnode == null || typeof vnode === 'boolean') return vnode;
    if (Array.isArray(vnode)) return vnode.flatMap(child => render(child, key));
    if (typeof vnode !== 'object' || typeof vnode.type !== 'function') {
      if (typeof vnode !== 'object') return vnode;
      return { ...vnode, children: (vnode.props?.children || []).flatMap((child, i) => {
        const value = render(child, `${key}.h${i}`);
        return Array.isArray(value) ? value : [value];
      }) };
    }
    const instanceKey = `${key}:${vnode.type.name}`;
    if (!instances.has(instanceKey)) instances.set(instanceKey, { hooks: [], cleanups: [] });
    const previous = current;
    current = instanceKey;
    hookIndex = 0;
    const output = vnode.type(vnode.props);
    current = previous;
    return render(output, instanceKey);
  }
  function unmount() {
    rerender = () => {};
    for (const instance of instances.values()) {
      for (const cleanup of instance.cleanups) cleanup();
    }
    instances.clear();
  }
  function mount(vnode) {
    // A mount always discards component-local state and subscriptions; the VM
    // and its module-level operation store survive, just as they do in React.
    unmount();
    let tree;
    rerender = () => { tree = render(vnode); };
    tree = render(vnode);
    return { get tree() { return tree; }, unmount };
  }
  return { plugin, React, mount, render };
}

const event = (seq, type, data = {}, surfaceOp = 'append') => ({ type: 'event', event: { type, seq, data, surfaceOp } });
const user = (seq, text = '原问题') => event(seq, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });

function fixtures({ fork, prompt } = {}) {
  const eventSubscribers = new Set();
  const sessionSubscribers = new Set();
  const snapshot = { running: false, pendingSubmissions: [], openState: 'open', removed: false, loadingOlder: false };
  const entries = [event(1, 'turn/end'), user(2)];
  const eventSnapshot = { entries, hasMore: false };
  const binding = {
    eventSource: { getSnapshot: () => eventSnapshot, subscribe: fn => (eventSubscribers.add(fn), () => eventSubscribers.delete(fn)) },
    session: { getSnapshot: () => snapshot, subscribe: fn => (sessionSubscribers.add(fn), () => sessionSubscribers.delete(fn)), loadOlder: async () => {} },
  };
  const calls = { fork: [], prompt: [], opened: [] };
  const sessions = {
    binding: () => binding,
    fork: async args => { calls.fork.push(args); return fork ? fork(args) : `child-${calls.fork.length}`; },
    using: async (child, options, fn) => fn({ ready: Promise.resolve({ session: { prompt: async (...args) => { calls.prompt.push({ child, args }); return prompt ? prompt(...args) : { ok: true }; } } }) }),
  };
  const workspace = { openSession: id => calls.opened.push(id) };
  return { binding, sessions, workspace, calls, notify: () => { for (const fn of eventSubscribers) fn(); for (const fn of sessionSubscribers) fn(); } };
}

function hosts(tree, type) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === type) found.push(node);
    for (const child of node.children || []) visit(child);
  }
  visit(tree);
  return found;
}
function button(tree, label) { return hosts(tree, 'button').find(x => x.children?.join('') === label); }
function panelVNode(harness, fx, sessionId = 's1') {
  return harness.React.createElement(harness.plugin.__Panel, { binding: fx.binding, sessions: fx.sessions, workspace: fx.workspace, sessionId, seq:2, originalText:'原问题', onClose: () => {} });
}
test('逐消息入口定位该条提问，不显示历史选择器', () => {
  const harness=load(); const fx=fixtures();
  const props={binding:fx.binding,sessions:fx.sessions,workspace:fx.workspace,sessionId:'s1',seq:2,originalText:'原问题',onClose:()=>{}};
  const mounted=harness.mount(harness.React.createElement(harness.plugin.__Panel,props));
  assert.equal(hosts(mounted.tree,'select').length,0);
  assert.equal(hosts(mounted.tree,'textarea')[0].props.value,'原问题');
});

 test('用户消息复用内容factory，复制旁仅有一个编辑入口', () => {
  const harness=load(); const fx=fixtures(); let prepared;
  const mounted=harness.mount(harness.React.createElement(harness.plugin.__UserRenderer,{
    node:{data:{seq:2,time:1793536974225,content:[{type:'text',text:'原问题'},{type:'image',attachment:{id:'image'}}]}},
    sessionId:'s1',sessions:fx.sessions,workspace:fx.workspace,
    renderFactorySlot:(name,props)=>{assert.equal(name,'conversation.chat.user.content');prepared=props;return null;}
  }));
  const buttons=hosts(mounted.tree,'button');
  assert.deepEqual(buttons.map(x=>x.props['aria-label']),['复制','编辑此消息']);
  assert.equal(prepared.content.attachments[0].image.attachment.id,'image');
  assert.equal(prepared.content.text,'原问题');
  buttons[1].props.onClick();
  assert.equal(hosts(mounted.tree,'textarea')[0].props.value,'原问题');
});

test('正文工厂与操作栏同为右对齐容器的直接子项，不嵌套产生右侧空白', () => {
  const harness=load(); const fx=fixtures();
  const mounted=harness.mount(harness.React.createElement(harness.plugin.__UserRenderer,{
    node:{data:{seq:2,content:[{type:'text',text:'短消息'}]}},
    sessionId:'s1',sessions:fx.sessions,workspace:fx.workspace,
    renderFactorySlot:()=>harness.React.createElement('article',{'data-test-content':true,style:{maxWidth:'82%'}}),
  }));
  assert.equal(mounted.tree.props.style.display,'flex');
  assert.equal(mounted.tree.props.style.alignItems,'flex-end');
  assert.equal(mounted.tree.children[0].type,'article');
  assert.equal(mounted.tree.children[1].type,'div');
  assert.equal(hosts(mounted.tree.children[1],'button').length,2);
});

function chooseAndEdit(mounted, text = '修改后') {
  const textarea = hosts(mounted.tree, 'textarea')[0];
  assert.ok(textarea, '原位编辑器应包含 textarea');
  textarea.props.onChange({ target: { value: text, style: { height: '' }, scrollHeight: 26 } });
}


test('提交成功后重挂载恢复 child，显式开始另一次编辑可第二次 fork', async () => {
  const h = load();
  const fx = fixtures();
  const mounted = h.mount(panelVNode(h, fx));
  chooseAndEdit(mounted, '第一次修改');
  await button(mounted.tree, '保存并重新生成').props.onClick();
  assert.equal(fx.calls.fork.length, 1);
  assert.equal(fx.calls.prompt.length, 1);
  assert.deepEqual(fx.calls.opened, ['child-1']);

  const remounted = h.mount(panelVNode(h, fx));
  assert.equal(button(remounted.tree, '打开已创建的分支')?.props.type, 'button');
  assert.match(remounted.tree.children.find(x => x?.type === 'p' && x.props.role === 'status')?.children.join('') || '', /已创建新分支并发送/);
  button(remounted.tree, '开始另一次编辑').props.onClick();
  chooseAndEdit(remounted, '第二次修改');
  await button(remounted.tree, '保存并重新生成').props.onClick();
  assert.equal(fx.calls.fork.length, 2);
  assert.deepEqual(fx.calls.opened, ['child-1', 'child-2']);
});

test('进行中重挂载不会重复提交', async () => {
  const forkGate = deferred();
  const h = load();
  const fx = fixtures({ fork: () => forkGate.promise });
  const mounted = h.mount(panelVNode(h, fx));
  chooseAndEdit(mounted);
  const firstSubmit = button(mounted.tree, '保存并重新生成').props.onClick;
  const pending = firstSubmit();
  assert.equal(fx.calls.fork.length, 1);
  const remounted = h.mount(panelVNode(h, fx));
  const processing = button(remounted.tree, '保存中…');
  assert.equal(processing.props.disabled, true);
  assert.equal(hosts(remounted.tree, 'textarea')[0].props.disabled, true);
  await firstSubmit();
  assert.equal(fx.calls.fork.length, 1);
  forkGate.resolve('child-1');
  await pending;
});

test('发送失败恢复 child 且不会自动重试', async () => {
  const h = load();
  const fx = fixtures({ prompt: () => ({ ok: false, error: { message: '发送失败' } }) });
  const mounted = h.mount(panelVNode(h, fx));
  chooseAndEdit(mounted);
  await button(mounted.tree, '保存并重新生成').props.onClick();
  assert.equal(fx.calls.fork.length, 1);
  assert.equal(fx.calls.prompt.length, 1);
  assert.equal(fx.calls.opened.length, 0);
  const recovered = h.mount(panelVNode(h, fx));
  assert.equal(hosts(recovered.tree, 'textarea')[0].props.value, '原问题');
  button(recovered.tree, '打开已创建的分支').props.onClick();
  assert.deepEqual(fx.calls.opened, ['child-1']);
  assert.match(hosts(recovered.tree, 'p').find(x => x.props.role === 'status').children.join(''), /分支已创建.*\n发送失败/);
  const retry = button(recovered.tree, '保存并重新生成');
  assert.equal(retry.props.disabled, true);
  chooseAndEdit(recovered);
  await button(recovered.tree, '保存并重新生成').props.onClick();
  assert.equal(fx.calls.fork.length, 1);
  assert.equal(fx.calls.prompt.length, 1);
});

test('铅笔原位替换正文，取消恢复且不提交；保存不弹确认框', async () => {
  const h = load({ confirm: () => { throw Error('不应弹窗'); } });
  const fx = fixtures();
  const mounted = h.mount(h.React.createElement(h.plugin.__UserRenderer, {
    node:{data:{seq:2,content:[{type:'text',text:'原问题'}]}},
    sessionId:'s1',sessions:fx.sessions,workspace:fx.workspace,
    renderFactorySlot:()=>h.React.createElement('article',{},'原问题'),
  }));
  const edit=()=>hosts(mounted.tree,'button').find(x=>x.props['aria-label']==='编辑此消息').props.onClick();
  edit();
  assert.equal(hosts(mounted.tree,'article').length,0,'编辑时原正文必须被替换');
  assert.equal(hosts(mounted.tree,'section').length,1);
  assert.equal(hosts(mounted.tree,'dialog').length,0);
  assert.equal(hosts(mounted.tree,'section')[0].props.style.position,undefined);
  chooseAndEdit(mounted);
  button(mounted.tree,'取消').props.onClick();
  assert.equal(hosts(mounted.tree,'textarea').length,0);
  assert.equal(hosts(mounted.tree,'article').length,1);
  assert.equal(fx.calls.fork.length,0);
  edit();
  await button(mounted.tree,'保存并重新生成').props.onClick();
  assert.equal(fx.calls.fork.length,1);
  assert.equal(fx.calls.prompt.length,1);
});

test('编辑框单行起步、随内容伸缩，不显示原生边框及拖动柄', () => {
  const h=load(); const fx=fixtures();
  const mounted=h.mount(panelVNode(h,fx));
  const textarea=hosts(mounted.tree,'textarea')[0];
  assert.equal(textarea.props.rows,1);
  assert.equal(textarea.props.style.outline,'none');
  assert.equal(textarea.props.style.resize,'none');
  const element={style:{},scrollHeight:26};
  textarea.props.ref(element);
  assert.equal(element.style.height,'26px');
  element.scrollHeight=500;
  textarea.props.ref(element);
  assert.equal(element.style.height,'320px');
  assert.equal(element.style.overflowY,'auto');
  element.scrollHeight=52;
  textarea.props.ref(element);
  assert.equal(element.style.height,'52px');
  assert.equal(element.style.overflowY,'hidden');
});

test('正式注册覆盖 user 和 steering，最新追加消息同样有编辑入口', async () => {
  const h=load(); const fx=fixtures(); const registrations=[];
  h.plugin.apply({sessions:fx.sessions,uiWorkspace:fx.workspace,slots:{
    inject:(name,callback)=>callback(),
    register:(options,component)=>{registrations.push({options,component});return ()=>{};},
  }});
  assert.deepEqual(registrations.map(x=>x.options.key),['user','steering']);
  assert.equal(new Set(registrations.map(x=>x.options.id)).size,2);
  for(const {options,component} of registrations){
    const mounted=h.mount(h.React.createElement(component,{
      sessionId:options.key,node:{data:{kind:options.key,seq:2,content:[{type:'text',text:'原问题'}]}},
      renderFactorySlot:()=>null,
    }));
    hosts(mounted.tree,'button').find(x=>x.props['aria-label']==='编辑此消息').props.onClick();
    chooseAndEdit(mounted,'修改追加消息');
    await button(mounted.tree,'保存并重新生成').props.onClick();
  }
  assert.equal(fx.calls.fork.length,2);
  assert.equal(fx.calls.fork[1].atSeq,1);
});

test('带图 steering 消息显示编辑入口但明确禁止丢弃附件重发', async () => {
  const h=load(); const fx=fixtures(); let component;
  h.plugin.apply({sessions:fx.sessions,uiWorkspace:fx.workspace,slots:{
    inject:(_name,cb)=>cb(),register:(options,render)=>{if(options.key==='steering')component=render;return ()=>{};},
  }});
  const content=[{type:'image',attachment:{attachmentId:'image'}},{type:'text',text:'原问题'}];
  fx.binding.eventSource.getSnapshot().entries[1].event.data.content=content;
  const mounted=h.mount(h.React.createElement(component,{sessionId:'s1',node:{data:{kind:'steering',seq:2,content}},renderFactorySlot:()=>null}));
  hosts(mounted.tree,'button').find(x=>x.props['aria-label']==='编辑此消息').props.onClick();
  assert.ok(hosts(mounted.tree,'p').some(x=>x.children.join('').includes('含附件')));
  const save=button(mounted.tree,'保存并重新生成');
  assert.equal(save.props.disabled,true);
  await save.props.onClick();
  assert.equal(fx.calls.fork.length,0);
});

test('提交时重新核对运行状态和历史内容，拒绝过期快照', async () => {
  const h=load(); const fx=fixtures();
  const mounted=h.mount(panelVNode(h,fx));
  const submit=button(mounted.tree,'保存并重新生成').props.onClick;
  fx.binding.session.getSnapshot().running=true;
  await submit();
  assert.equal(fx.calls.fork.length,0);
  fx.binding.session.getSnapshot().running=false;
  fx.binding.eventSource.getSnapshot().entries[1]=user(2,'已变更');
  await submit();
  assert.equal(fx.calls.fork.length,0);
});
