window.__ModuleLoader__.load({ id: 'dsh-message-branch', factory: (require) => {
  const React = require('react');
  const h = React.createElement;
  const SLOT = 'conversation.chat.node';
  const operations = new Map();
  const listeners = new Set();
  const EMPTY = Object.freeze({busy:false,child:null,notice:'',attempted:false});
  function snapshot(id) { return operations.get(id) || EMPTY; }
  function subscribe(fn) { listeners.add(fn); return ()=>listeners.delete(fn); }
  function publish(id, patch) {
    operations.set(id,{...snapshot(id),...patch});
    for (const fn of listeners) fn();
  }
  function useOperation(id) { return React.useSyncExternalStore(subscribe,()=>snapshot(id)); }
  function candidates(entries) {
    const events=entries.filter(x=>x.type==='event').map(x=>x.event).sort((a,b)=>a.seq-b.seq);
    return events.flatMap((e,i)=>{
      if(e.type!=='user/message'||e.data?.source?.kind!=='user') return [];
      const blocks=e.data.content;
      if(!Array.isArray(blocks)) return [];
      const previous=events[i-1];
      const reason=blocks.some(b=>b.type!=='text')?'含附件，暂不支持重发':e.surfaceOp&&e.surfaceOp!=='append'?'替换事件暂不支持':!previous||previous.seq!==e.seq-1?'请加载更早历史以确认分支边界':'';
      return [{seq:e.seq,atSeq:previous?.seq,text:blocks.map(b=>b.text||'').join(''),reason}];
    });
  }
  const secondaryButton={border:0,borderRadius:999,padding:'7px 15px',background:'var(--dsw-alias-bg-base, Canvas)',color:'inherit',font:'inherit',fontSize:13,lineHeight:'20px',cursor:'pointer',whiteSpace:'nowrap'};
  function fitTextarea(element) {
    if(!element)return;
    element.style.height='0px';
    const height=Math.max(26,element.scrollHeight);
    element.style.height=Math.min(320,height)+'px';
    element.style.overflowY=height>320?'auto':'hidden';
  }
  function InlineEditor({binding,sessions,workspace,sessionId,originalText,seq,onClose}) {
    const events=React.useSyncExternalStore(cb=>binding.eventSource.subscribe(cb),()=>binding.eventSource.getSnapshot());
    const state=React.useSyncExternalStore(cb=>binding.session.subscribe(cb),()=>binding.session.getSnapshot());
    const operation=useOperation(sessionId);
    const [text,setText]=React.useState(originalText);
    const lock=React.useRef(false);
    const row=candidates(events.entries).find(x=>x.seq===seq);
    const reason=!row?'请加载更早历史以确认分支边界':row.reason|| (row.text!==originalText?'历史已变化，请取消后重新编辑。':'');
    const idle=!state.running&&!state.pendingSubmissions.length&&state.openState==='open'&&!state.removed;
    async function submit(){
      const previousOperation=snapshot(sessionId);
      if(previousOperation.busy||previousOperation.attempted||lock.current||!text.trim())return;
      // Recheck live state, not the render snapshot, before forking.
      const current=binding.session.getSnapshot();
      if(current.running||current.pendingSubmissions.length||current.openState!=='open'||current.removed){
        publish(sessionId,{notice:'请等原会话停止且队列为空后操作。'});return;
      }
      const fresh=candidates(binding.eventSource.getSnapshot().entries).find(x=>x.seq===seq);
      if(!fresh||fresh.reason||fresh.text!==originalText){publish(sessionId,{notice:fresh?.reason||'历史已变化，请取消后重新编辑。'});return;}
      lock.current=true;
      publish(sessionId,{busy:true,attempted:true,notice:'',child:null});
      let created;
      try {
        created=await sessions.fork({sessionId,atSeq:fresh.atSeq,increaseTitle:false});
        publish(sessionId,{child:created});
        await sessions.using(created,{source:'controllerOperation'},async ref=>{
          const target=await ref.ready;
          const result=await target.session.prompt([{type:'text',text}], 'queue',undefined,crypto.randomUUID());
          if(!result.ok)throw Error(result.error?.message||'发送未被接受');
        });
        publish(sessionId,{notice:'已创建新分支并发送。'});
        workspace.openSession(created);
      } catch(e) {
        publish(sessionId,{notice:(created?'分支已创建，请打开检查；为避免重复发送，不自动重试。\n':'创建结果未确认，请先检查会话列表；不自动重试。\n')+(e?.message||String(e))});
      } finally {publish(sessionId,{busy:false});lock.current=false;}
    }
    return h('section',{'aria-label':'原位编辑提问','data-message-branch-editor':true,style:{width:'100%',maxWidth:820,marginLeft:'auto',boxSizing:'border-box',padding:'14px 16px 10px',borderRadius:20,border:0,background:'var(--dsw-alias-bg-layer-2, #f2f2f2)',color:'var(--dsw-alias-label-primary, CanvasText)'}},
      h('textarea',{'aria-label':'编辑历史提问',ref:fitTextarea,autoFocus:true,value:text,disabled:operation.busy,onChange:e=>{fitTextarea(e.target);setText(e.target.value);},onKeyDown:e=>{if(e.key==='Escape'&&!snapshot(sessionId).busy){e.preventDefault();onClose();}else if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!e.nativeEvent?.isComposing){e.preventDefault();submit();}},rows:1,style:{display:'block',width:'100%',boxSizing:'border-box',resize:'none',minHeight:26,maxHeight:320,padding:0,border:0,outline:'none',boxShadow:'none',background:'transparent',color:'inherit',font:'inherit',fontSize:14,lineHeight:'26px',overflowY:'hidden'}}),
      reason&&h('p',{role:'status',style:{fontSize:12,margin:'6px 0',color:'var(--dsw-alias-label-secondary)'}},reason),
      reason&&events.hasMore&&h('button',{type:'button',style:secondaryButton,disabled:operation.busy||state.loadingOlder,onClick:async()=>{try{await binding.session.loadOlder();}catch(e){publish(sessionId,{notice:String(e)});}}},'加载更早历史'),
      operation.notice&&h('p',{role:'status',style:{whiteSpace:'pre-wrap'}},operation.notice),
      operation.child&&h('button',{type:'button',style:secondaryButton,onClick:()=>workspace.openSession(operation.child)},'打开已创建的分支'),
      operation.attempted&&h('button',{type:'button',style:secondaryButton,disabled:operation.busy,onClick:()=>{if(!snapshot(sessionId).busy)publish(sessionId,{attempted:false,notice:'',child:null});}},'开始另一次编辑'),
      h('div',{style:{display:'flex',alignItems:'center',justifyContent:'flex-end',flexWrap:'wrap',gap:8,marginTop:12}},
        h('span',{role:!idle?'status':undefined,title:'保存后创建新分支，原会话保留；不撤销已执行的文件修改或命令。',style:{marginRight:'auto',fontSize:11,color:'var(--dsw-alias-label-secondary)',opacity:.75}},!idle?'会话结束后可保存':'保存为新分支'),
        h('button',{type:'button',style:secondaryButton,disabled:operation.busy,onClick:onClose},'取消'),
        h('button',{type:'button',title:'保存修改并在新分支重新生成（Ctrl / ⌘ + Enter）；原会话保留，不撤销工具操作。',style:{...secondaryButton,background:'#242424',color:'#fff',cursor:operation.busy||operation.attempted||!idle||!!reason||!text.trim()?'not-allowed':'pointer',opacity:operation.busy||operation.attempted||!idle||!!reason||!text.trim()?0.38:1},onClick:submit,disabled:operation.busy||operation.attempted||!idle||!!reason||!text.trim()},operation.busy?'保存中…':'保存并重新生成')));
  }
  function UserRenderer({node,sessionId,renderFactorySlot,loadImage,sessions,workspace}) {
    const [open,setOpen]=React.useState(false);
    const data=node?.data||{};
    const content=Array.isArray(data.content)?data.content:[];
    const text=content.filter(b=>b.type==='text').map(b=>b.text||'').join('');
    const prepared={text,attachments:content.filter(b=>b.type==='image'||b.type==='file').map(b=>b.type==='image'?{type:'image',image:{attachment:b.attachment}}:{type:'file',file:b.attachment}),referenceLabels:data.referenceLabels,extraBlocks:content.filter(b=>!['text','image','file'].includes(b.type))};
    const binding=sessions.binding(sessionId);
    const [copyStatus,setCopyStatus]=React.useState('');
    const copy=async()=>{try{if(!navigator.clipboard)throw Error('当前环境不支持剪贴板');await navigator.clipboard.writeText(text);setCopyStatus('已复制');}catch{setCopyStatus('复制失败');}};
    const actionStyle={display:'inline-flex',alignItems:'center',justifyContent:'center',width:28,height:28,border:0,borderRadius:6,background:'transparent',color:'inherit',cursor:'pointer',padding:4};
    const icon=path=>h('svg',{width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true},h('path',{d:path}));
    const date=new Date(data.time);const validTime=data.time!=null&&!Number.isNaN(date.getTime());
    if(open&&binding)return h('div',{'data-message-branch-row':true,style:{width:'100%'}},h(InlineEditor,{key:String(data.seq),binding,sessions,workspace,sessionId,originalText:text,seq:data.seq,onClose:()=>setOpen(false)}));
    return h('div',{'data-message-branch-row':true,style:{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6}},
      // Keep the factory stack as a direct flex child, as in the host renderer.
      // An extra block wrapper left-aligns its width-limited stack and leaves a right-hand gap.
      renderFactorySlot('conversation.chat.user.content',{content:prepared,loadImage,facts:{sessionLabels:data.referenceLabels,skillNames:data.skillNames},interactive:true}),
      h('div',{style:{display:'flex',alignItems:'center',gap:4,color:'var(--dsw-alias-label-tertiary)',fontSize:12}},
        validTime&&h('time',{dateTime:date.toISOString(),title:date.toLocaleString()},date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})),
        h('button',{type:'button','aria-label':'复制',title:copyStatus||'复制',style:actionStyle,onClick:copy},icon('M9 9h11v11H9z M15 9V4H4v11h5')),
        h('button',{type:'button','aria-label':'编辑此消息',title:binding?'编辑此消息':'会话尚未就绪',disabled:!binding,style:actionStyle,onClick:()=>setOpen(true)},icon('M15 4l5 5 M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16z'))));
  }
  return {
    name:'local-message-branch',inject:['slots','sessions','uiWorkspace'],
    apply(ctx){
      const slots=ctx.slots,sessions=ctx.sessions,workspace=ctx.uiWorkspace;
      if(!slots||!sessions||!workspace)return;
      // Both ordinary and admitted in-flight human messages use the same data contract.
      // Pending submissions remain under the host's queue editor.
      for (const key of ['user','steering']) {
        slots.inject(SLOT,()=>slots.register({name:SLOT,id:'local-message-branch-'+key,key,priority:-100},props=>h(UserRenderer,{...props,sessions,workspace})));
      }
    }
  };
} });
