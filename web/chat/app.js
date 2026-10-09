'use strict';

const ids=['profile-select','new-chat','app-status','chat-messages','chat-empty','chat-form','chat-input','send-button','char-count','starter-list','init-retry','eval-link','chat-settings','settings-form','model-select','thinking-select','tokens-select','apply-settings','settings-status','active-settings','profile-switch-dialog','profile-switch-description','profile-switch-cancel','conversation-list','conversation-mobile-list','history-open','history-dialog','history-close','conversation-title','settings-open','settings-dialog','settings-close','eval-leave-dialog','eval-leave-cancel'];
const els={};
ids.forEach(id=>{els[id.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=document.getElementById(id);});
const state={config:null,session:null,messages:[],profileId:null,busy:true,remoteBusy:false,initialized:false,expired:false,generation:0,failedAttempt:null,composing:false,settingsError:'',settingsApplying:false,pendingTurn:null,pendingProfileChange:null,conversations:[],historyLoading:false,historyError:'',historyEpoch:0,draftTransfer:null,openIntent:null};
const conversationDrafts=new Map();
let pendingEvaluationLeave=null;
let hydratedMessageIds=new Set();
function draftKey(session=state.session){return session?session.profileId+':'+session.conversationId:null;}
function saveDraft(){const key=draftKey();if(key){if(els.chatInput.value)conversationDrafts.set(key,els.chatInput.value);else conversationDrafts.delete(key);}}
function element(tag,text,className){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;}
function setStatus(text,isError=false){els.appStatus.textContent=text;els.appStatus.classList.toggle('error',isError);}
function setBusy(value){
  state.busy=Boolean(value)||state.remoteBusy;
  els.chatMessages.setAttribute('aria-busy',state.busy?'true':'false');
  const locked=state.busy||!state.initialized;
  els.evalLink.setAttribute("aria-disabled",state.busy||!els.evalLink.getAttribute('href')?"true":"false");
  els.chatInput.disabled=locked;
  els.profileSelect.disabled=locked||state.expired;
  els.initRetry.disabled=state.initializing||state.busy&&!state.remoteBusy;
  els.newChat.disabled=state.busy||state.expired||!state.initialized;
  if(state.expired){els.initRetry.hidden=false;els.initRetry.textContent='重新连接';}
  else if(state.initialized&&!state.remoteBusy){
    const failed=state.failedAttempt;
    els.initRetry.hidden=!(failed&&failed.sessionId===state.session?.id&&failed.text===els.chatInput.value);
    if(!els.initRetry.hidden)els.initRetry.textContent='查看当前记录';
  }
  const draft=els.chatInput.value;
  els.sendButton.disabled=locked||state.expired||state.session?.turns>=20||!draft.trim()||draft.length>2000;
  for(const button of els.chatMessages.querySelectorAll('.order-select-button'))button.disabled=locked||state.expired||state.session?.turns>=20;
  els.historyOpen.disabled=!state.config;
  els.settingsOpen.disabled=!state.config;
  renderConversations();
  if(state.config)updateSettingsControls();
}
function updateCount(){const len=els.chatInput.value.length;els.charCount.textContent=`${len}/2000`;els.charCount.classList.toggle('over',len>2000);setBusy(state.busy);}
const HTTP_ERRORS={400:'请求无效，请检查后重试',401:'会话已失效，请重新连接',403:'没有权限执行此操作',409:'当前消息仍在处理中，请稍后重试',429:'请求过于频繁，请稍后再试',503:'服务暂不可用，请稍后重试'};
const HISTORY_CAPACITY_ERROR='会话记录数量已达上限，已有记录仍可查看。';
async function api(path,body){
  const init=body===undefined?{method:'GET'}:{method:'POST',headers:{'Content-Type':'application/json','X-Chat-Request':'1'},body:JSON.stringify(body)};
  init.credentials='same-origin';
  let response;
  try{response=await fetch(path,init);}catch{throw new Error('网络异常，请稍后重试');}
  let data=null;
  try{data=await response.json();}catch{}
  if(!response.ok){const capacity=path==='/api/chat/session'&&response.status===429&&data?.error===HISTORY_CAPACITY_ERROR;const err=new Error(capacity?HISTORY_CAPACITY_ERROR:HTTP_ERRORS[response.status]||'请求失败，请稍后重试');err.status=response.status;throw err;}
  if(data===null)throw new Error('服务响应异常，请稍后重试');
  return data;
}

const STEP_LABELS=['受理咨询','查询订单详情','查询最近订单','查阅服务规则','整理答复'];
function validateStep(s){
  return s&&typeof s.id==='string'&&s.id.length>0&&s.id.length<=128&&STEP_LABELS.includes(s.label)&&['running','done','error'].includes(s.status);
}
function validateSteps(steps){return Array.isArray(steps)&&steps.length<=64&&steps.every(validateStep);}
async function streamMessage(body,onEvent){
  let response;
  try{response=await fetch('/api/chat/messages/stream',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Chat-Request':'1'},body:JSON.stringify(body)});}
  catch{throw new Error('网络异常，请保留原文重试');}
  if(!response.ok){const error=new Error(HTTP_ERRORS[response.status]||'请求失败，请稍后重试');error.status=response.status;throw error;}
  if(!response.body||!response.headers.get('Content-Type')?.startsWith('text/event-stream'))throw new Error('服务响应异常，请保留原文重试');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer='',started=false;
  function receive(block){
    let event='message';const data=[];
    for(const line of block.split(/\r\n|\r|\n/)){
      if(line.startsWith('event:'))event=line.slice(6).trim();
      else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
    }
    if(!data.length)return;
    let payload;
    try{payload=JSON.parse(data.join('\n'));}catch{throw new Error('服务响应异常，请保留原文重试');}
    if(!payload||payload.sessionId!==body.sessionId||payload.requestId!==body.requestId)throw new Error('响应会话不匹配，请重新连接');
    if(event==='start'){
      if(started||typeof payload.replayed!=='boolean')throw new Error('服务响应异常');
      started=true;
    }else{
      if(!started)throw new Error('服务响应异常');
      if(event==='step'&&!validateStep(payload))throw new Error('处理步骤格式异常');
      if(event==='delta'&&(typeof payload.messageId!=='string'||!payload.messageId||typeof payload.text!=='string'))throw new Error('答复片段格式异常');
      if(event==='result'){
        if(!validateReply(payload.reply)||(payload.steps!==undefined&&!validateSteps(payload.steps))||!['host','agent'].includes(payload.origin)||!Number.isFinite(payload.durationMs)||payload.durationMs<0)throw new Error('响应校验失败');
        return payload;
      }
      if(event==='error'){
        if(!Number.isInteger(payload.status)||payload.status<400||payload.status>599||typeof payload.error!=='string')throw new Error('服务响应异常');
        const error=new Error(HTTP_ERRORS[payload.status]||'本轮未完成，请重试');error.status=payload.status;throw error;
      }
      if(!['step','delta'].includes(event))throw new Error('服务响应异常');
    }
    onEvent(event,payload);
  }
  try{
    while(true){
      let chunk;
      try{chunk=await reader.read();}catch{throw new Error('连接已中断，本轮未完成；请保留原文重试');}
      buffer+=chunk.done?decoder.decode():decoder.decode(chunk.value,{stream:true});
      let boundary;
      while((boundary=/\r\n\r\n|\n\n|\r\r/.exec(buffer))){
        const block=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);
        const result=receive(block);if(result)return result;
      }
      if(chunk.done)throw new Error('连接已中断，本轮未完成；请保留原文重试');
    }
  }finally{await reader.cancel().catch(()=>{});}
}

function validateReply(r){
  if(!r||typeof r!=='object')return false;
  if(!['answer','notice','order'].includes(r.kind))return false;
  if(typeof r.text!=='string')return false;
  if(r.evidenceIds!==undefined&&(!Array.isArray(r.evidenceIds)||!r.evidenceIds.every(x=>typeof x==='string')))return false;
  if(r.hasMore!==undefined&&typeof r.hasMore!=='boolean')return false;
  if(r.kind==='order'){
    if(!Array.isArray(r.orders))return false;
    if(!r.orders.every(o=>o&&typeof o.id==='string'&&typeof o.status==='string'&&Array.isArray(o.couponStatuses)&&o.couponStatuses.every(x=>typeof x==='string')&&['productName','shopName','selectionText'].every(k=>o[k]===undefined||typeof o[k]==='string')&&(o.createdAt===undefined||o.createdAt===null||typeof o.createdAt==='string')))return false;
  }
  return true;
}
function validateSettings(s, config = state.config) {
  const ids = ["configured", "deepseek-flash", "deepseek-v4-pro", "qwen3.7-plus-2026-05-26"];
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  const k = Object.keys(s);
  if (k.length !== 3 || !["modelSelection", "thinkingLevel", "maxTokens"].every(x => k.includes(x))) return false;
  if (!ids.includes(s.modelSelection) || !["off", "high"].includes(s.thinkingLevel)) return false;
  if (!Number.isInteger(s.maxTokens) || ![512, 1024, 2048].includes(s.maxTokens)) return false;
  if (config) {
    const ms = Array.isArray(config.models) ? config.models : [];
    const o = config.options || {};
    if (!ms.some(m => m && m.id === s.modelSelection)) return false;
    if (!Array.isArray(o.thinkingLevels) || !o.thinkingLevels.includes(s.thinkingLevel)) return false;
    if (!Array.isArray(o.maxTokens) || !o.maxTokens.includes(s.maxTokens)) return false;
  }
  return true;
}

function validateConfig(c) {
  const ids = ["configured", "deepseek-flash", "deepseek-v4-pro", "qwen3.7-plus-2026-05-26"];
  if (!c || typeof c !== "object" || c.version !== 2) return false;
  if (c.simulation !== true || c.readOnly !== true) return false;
  if (!c.limits || c.limits.messageCharacters !== 2000) return false;
  if (typeof c.evaluationUrl !== "string" || !c.evaluationUrl) return false;
  if (!Array.isArray(c.profiles) || c.profiles.length !== 2) return false;
  const pids = c.profiles.map(p => p && p.id);
  if (new Set(pids).size !== 2 || !["demo-a", "demo-b"].every(id => pids.includes(id))) return false;
  const strs = v => Array.isArray(v) && v.every(x => typeof x === "string");
  if (!c.profiles.every(p => p && typeof p.label === "string" && p.label.length > 0 && strs(p.examples))) return false;
  if (!Array.isArray(c.models) || c.models.length === 0) return false;
  const mids = c.models.map(m => m && m.id);
  if (new Set(mids).size !== c.models.length || !mids.every(id => ids.includes(id))) return false;
  if (!c.models.every(m => m && typeof m.label === "string" && m.label && typeof m.provider === "string" && m.provider && typeof m.modelId === "string" && m.modelId && typeof m.available === "boolean" && typeof m.supportsThinking === "boolean")) return false;
  const o = c.options;
  if (!o || Object.keys(o).length !== 2 || !Array.isArray(o.thinkingLevels) || o.thinkingLevels.join() !== "off,high") return false;
  if (!Array.isArray(o.maxTokens) || o.maxTokens.join() !== "512,1024,2048") return false;
  return validateSettings(c.defaults, c);
}

function validateSession(d, config = state.config) {
  if (!d || typeof d !== "object" || !Array.isArray(d.messages)) return false;
  const s = d.session;
  if (s === null) return d.messages.length === 0;
  if (!s || typeof s !== "object") return false;
  if (!validUUID(s.id) || typeof s.label !== "string" || !s.label) return false;
  if (!validUUID(s.conversationId) || !Number.isInteger(s.turns) || s.turns<0 || s.turns>20 || typeof s.busy!=='boolean'||typeof s.modelAvailable!=='boolean'
    ||s.modelAvailable===false&&(typeof s.modelUnavailableReason!=='string'||!s.modelUnavailableReason||s.modelUnavailableReason.length>300)) return false;
  const pids = config && Array.isArray(config.profiles) ? config.profiles.map(p => p && p.id) : ["demo-a", "demo-b"];
  if (!pids.includes(s.profileId)) return false;
  if (!validateSettings(s.settings, config)) return false;
  if (!s.model || typeof s.model.provider !== "string" || !s.model.provider || typeof s.model.id !== "string" || !s.model.id) return false;
  return d.messages.every(m => m && typeof m.id === "string" && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && (!("reply" in m) || validateReply(m.reply)) && (m.steps===undefined||validateSteps(m.steps))
    && (m.status===undefined||['pending','interrupted'].includes(m.status)&&!('reply' in m)));
}

function validUUID(id){return typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);}
const historyViews=[];
function validateConversations(data,profileId){
  return data&&data.limit===100&&Array.isArray(data.conversations)&&data.conversations.length<=100
    &&new Set(data.conversations.map(item=>item?.id)).size===data.conversations.length
    &&data.conversations.every(item=>item&&validUUID(item.id)&&item.profileId===profileId&&typeof item.title==='string'&&item.title.length>0
      &&Number.isFinite(Date.parse(item.createdAt))&&Number.isFinite(Date.parse(item.updatedAt))&&Number.isInteger(item.turns)&&item.turns>=0&&item.turns<=20
      &&['ready','busy','interrupted','limit'].includes(item.status)&&typeof item.current==='boolean');
}
function renderConversationTitle(){
  const stored=state.conversations.find(item=>item.id===state.session?.conversationId);
  const first=state.messages.find(message=>message.role==='user');
  els.conversationTitle.textContent=first?.text.trim().slice(0,60)||stored?.title||'新对话';
}
function renderConversations(){
  if(!historyViews.length){
    for(const container of [els.conversationList,els.conversationMobileList]){
      const refresh=element('button','刷新','quiet-button');refresh.type='button';
      refresh.addEventListener('click',()=>{if(!state.busy&&!state.historyLoading)refreshConversations();});
      const note=element('p',null,'conversation-empty');note.setAttribute('role','status');
      const retry=element('button','重试','quiet-button');retry.type='button';
      retry.addEventListener('click',()=>{if(!state.busy&&!state.historyLoading)refreshConversations();});
      const list=element('div',null,'conversation-rows');container.replaceChildren(refresh,note,retry,list);
      historyViews.push({refresh,note,retry,list,rows:new Map()});
    }
  }
  const items=state.conversations.filter(item=>item.profileId===state.profileId);
  for(const view of historyViews){
    view.refresh.disabled=state.busy||state.historyLoading||!state.initialized;
    view.retry.hidden=!state.historyError;view.retry.disabled=view.refresh.disabled;
    view.note.textContent=state.historyError||(state.historyLoading?'正在读取会话记录…':items.length?'':'还没有会话记录。');
    view.note.hidden=!view.note.textContent;view.note.className=state.historyError?'conversation-error':'conversation-empty';
    for(const [id,row] of view.rows)if(!items.some(item=>item.id===id)){row.button.remove();view.rows.delete(id);}
    items.forEach((item,index)=>{
      let row=view.rows.get(item.id);
      if(!row){
        const button=element('button',null,'conversation-button'),name=element('span',null,'conversation-name'),meta=element('span',null,'conversation-meta');button.type='button';button.dataset.conversationId=item.id;
        button.append(name,meta);button.addEventListener('click',()=>openConversation(item.id));row={button,name,meta};view.rows.set(item.id,row);
      }
      const current=item.id===state.session?.conversationId;
      row.button.classList.toggle('active',current);if(current)row.button.setAttribute('aria-current','page');else row.button.removeAttribute('aria-current');
      row.button.disabled=state.busy||!state.initialized||state.expired;
      if(row.name.textContent!==item.title)row.name.textContent=item.title;
      const label={busy:'处理中',interrupted:'未完成',limit:'已达轮数上限'}[item.status];
      const meta=new Date(item.updatedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+(label?' · '+label:'');
      if(row.meta.textContent!==meta)row.meta.textContent=meta;
      if(view.list.children[index]!==row.button)view.list.insertBefore(row.button,view.list.children[index]??null);
    });
  }
  renderConversationTitle();
}
async function refreshConversations(){
  if(!state.initialized||!state.profileId)return;
  const focusView=historyViews.find(view=>view.refresh===document.activeElement||view.retry===document.activeElement);
  const focusSource=focusView?document.activeElement:null;
  const gen=state.generation,profileId=state.profileId,epoch=++state.historyEpoch;
  const current=()=>gen===state.generation&&profileId===state.profileId&&epoch===state.historyEpoch;
  state.historyLoading=true;state.historyError='';renderConversations();
  try{
    const data=await api('/api/chat/sessions?profileId='+encodeURIComponent(profileId));
    if(!current())return;
    if(!validateConversations(data,profileId))throw new Error('会话记录格式异常，请重试');
    state.conversations=data.conversations;
    const active=data.conversations.find(item=>item.id===state.session?.conversationId);
    if(active&&state.session){
      state.session.turns=Math.max(state.session.turns,active.turns);
      if(['ready','limit'].includes(active.status))active.status=state.session.turns>=20?'limit':'ready';
      if(state.session.turns>=20&&!state.busy&&!state.expired){
        setStatus('本次会话已达20轮，请新建对话');
      }
    }
  }catch(error){if(current())state.historyError=error.message;}
  finally{if(current()){
    state.historyLoading=false;updateCount();
    if(focusSource&&(!document.activeElement||document.activeElement===document.body||document.activeElement===focusSource)
      &&window.getSelection?.()?.isCollapsed!==false){
      const target=focusSource===focusView.retry&&!state.historyError?focusView.refresh:focusSource;
      if(target.isConnected&&!target.disabled&&!target.hidden&&target.getClientRects().length)target.focus({preventScroll:true});
    }
  }}
}

function money(cents){
  if(typeof cents!=='number'||!Number.isSafeInteger(cents)||cents<0)return '未知';
  const fen=cents%100;
  const yuan=(cents-fen)/100;
  return `¥${yuan}.${String(fen).padStart(2,'0')}`;
}


function renderSteps(steps,container,pending=false,details){
  if(!steps||!steps.length){details?.remove();return;}
  if(!details){
    details=element('details',null,'processing-steps');details.open=pending;
    details.append(element('summary'),element('ul'));
    container.insertBefore(details,container.querySelector('.message-text'));
  }
  const summary=details.querySelector('summary'),label=pending?'处理步骤':'处理步骤 · '+steps.length;
  if(summary.textContent!==label)summary.textContent=label;
  const list=details.querySelector('ul'),existing=new Map([...list.children].map(item=>[item.dataset.stepId,item]));
  const statuses={running:'处理中',done:'已完成',error:'未完成'};
  for(const [index,step] of steps.entries()){
    let item=existing.get(step.id);
    if(!item){item=element('li');item.dataset.stepId=step.id;item.append(element('span',null,'step-label'),element('span',null,'step-status'));}
    item.className='processing-step '+step.status;
    const name=item.querySelector('.step-label'),status=item.querySelector('.step-status');
    if(name.textContent!==step.label)name.textContent=step.label;
    if(status.textContent!==statuses[step.status])status.textContent=statuses[step.status];
    if(list.children[index]!==item)list.insertBefore(item,list.children[index]??null);
    existing.delete(step.id);
  }
  for(const item of existing.values())item.remove();
  return details;
}
let renderedMessages=null,renderedCount=0,pendingRows=[],renderedPending=null;
function renderMessage(m,row){
  const reused=Boolean(row),focused=reused&&row.contains(document.activeElement);
  row??=element('div',null,'message '+m.role);
  const reply=m.role==='assistant'?m.reply:undefined;
  if(reply?.kind==='notice')row.classList.add('notice');
  const body=reused?row.querySelector('.message-body'):element('div',null,'message-body');
  if(!reused){
    const avatar=element('div',m.role==='user'?'你':'d.','message-avatar');avatar.setAttribute('aria-hidden','true');
    body.append(element('div',m.role==='user'?'你':'Dave客服','message-label'));
    row.append(avatar,body);els.chatMessages.append(row);
  }
  if(!m.pending)body.querySelector('.turn-status')?.remove();
  if(m.status){body.append(element('div',m.status==='pending'?'本轮正在处理 · 答复尚未完成':'本轮未完成 · 未自动重试','turn-status'+(m.status==='interrupted'?' error':'')));}
  if(m.pending)body.append(element('div',m.error?'本轮未完成 · 可保留原文重试':'正在处理 · 答复尚未完成','turn-status'+(m.error?' error':'')));
  if(m.role==='assistant')renderSteps(m.steps,body,Boolean(m.pending),body.querySelector('.processing-steps'));
  let text=body.querySelector('.message-text');
  if(!text){text=element('p',null,'message-text');body.append(text);}
  text.textContent=reply?reply.text:m.text;text.hidden=Boolean(m.pending&&!m.text);
  if(reply?.kind==='order')renderOrderCards(reply,body,hydratedMessageIds.has(m.id));
  if(reply?.evidenceIds?.length){
    const details=element('details',null,'evidence');details.append(element('summary','依据'));
    const list=element('ul');for(const id of reply.evidenceIds)list.append(element('li',id));details.append(list);body.append(details);
  }
  if(focused&&(!document.activeElement||document.activeElement===document.body)&&window.getSelection?.()?.isCollapsed!==false){row.tabIndex=-1;row.focus({preventScroll:true});}
  return row;
}
function renderMessages(scrollToLatest=false){
  const scrollTop=els.chatMessages.scrollTop;
  const followLatest=scrollToLatest||els.chatMessages.scrollHeight-els.chatMessages.clientHeight-scrollTop<=48;
  if(renderedMessages!==state.messages){
    els.chatMessages.replaceChildren();
    renderedMessages=state.messages;renderedCount=0;pendingRows=[];renderedPending=null;
  }
  const pending=state.pendingTurn;
  const current=pending&&state.session&&pending.sessionId===state.session.id&&pending.generation===state.generation;
  if(!current&&renderedPending&&renderedPending.sessionId===state.session?.id&&renderedPending.generation===state.generation
    &&state.messages.length===renderedCount+2&&state.messages[renderedCount].id===renderedPending.requestId+':user'
    &&state.messages[renderedCount+1].id===renderedPending.requestId+':assistant'){
    renderMessage(state.messages[renderedCount+1],pendingRows[1]);
    renderedCount+=2;pendingRows=[];renderedPending=null;
  }
  if(renderedPending!==(current?pending:null)){
    for(const row of pendingRows)row.remove();
    pendingRows=[];renderedPending=current?pending:null;
  }
  if(!state.messages.length&&!current){els.chatMessages.replaceChildren(els.chatEmpty);return;}
  els.chatEmpty.remove();
  for(const message of state.messages.slice(renderedCount))renderMessage(message);
  renderedCount=state.messages.length;
  if(current){
    if(!pendingRows.length){
      pendingRows=[renderMessage({role:'user',text:pending.text}),renderMessage({role:'assistant',text:'',pending:true})];
      pending.displayedMessageId=null;pending.displayedLength=0;
    }
    const body=pendingRows[1].querySelector('.message-body'),text=body.querySelector('.message-text'),status=body.querySelector('.turn-status');
    renderSteps(pending.steps,body,true,body.querySelector('.processing-steps'));
    const label=pending.error?'本轮未完成 · 可保留原文重试':'正在处理 · 答复尚未完成';
    if(status.textContent!==label)status.textContent=label;
    status.className='turn-status'+(pending.error?' error':'');
    if(pending.displayedMessageId!==pending.messageId){text.replaceChildren();pending.displayedMessageId=pending.messageId;pending.displayedLength=0;}
    if(pending.draft.length>pending.displayedLength){text.append(document.createTextNode(pending.draft.slice(pending.displayedLength)));pending.displayedLength=pending.draft.length;}
    text.hidden=!pending.draft;
  }
  els.chatMessages.scrollTop=followLatest?els.chatMessages.scrollHeight:scrollTop;
}
function renderOrderCards(reply,container,historical=false){
  function action(parent,label,text){
    const button=element('button',label,'order-select-button');button.type='button';button.disabled=state.busy||!state.initialized||state.expired||state.session?.turns>=20;
    button.addEventListener('click',()=>{
      if(state.busy||!state.initialized||state.expired||state.session?.turns>=20)return;
      if(els.chatInput.value&&els.chatInput.value!==text){
        setStatus(historical?'请先发送或清空输入框中的问题，再查询最近订单':'请先发送或清空输入框中的问题，再选择订单');
        els.chatInput.focus({preventScroll:true});return;
      }
      els.chatInput.value=text;updateCount();submitMessage();
    });parent.append(button);
  }
  const statuses={paid:'已支付',refunded:'已退款',redeemed:'已核销',partially_redeemed:'部分核销',pending_payment:'待付款',closed:'已关闭'};
  const coupons={unused:'未核销',redeemed:'已核销',expired:'已过期',refunded:'已退款'};
  const cards=element('div',null,'order-cards');
  for(const order of reply.orders){
    const card=element('div',null,'order-card');
    const heading=element('div',null,'order-card-heading');
    heading.append(element('div',order.productName||'团购券订单','order-product'),element('span',Object.hasOwn(statuses,order.status)?statuses[order.status]:'未知状态','order-status'));
    card.append(heading);
    if(order.shopName)card.append(element('div',order.shopName,'order-shop'));
    card.append(element('div','订单号：'+(order.id||'未知'),'order-id'));
    if(order.createdAt){
      const date=new Date(order.createdAt);
      card.append(element('div','下单时间：'+(Number.isNaN(date.getTime())?'未知':date.toLocaleString('zh-CN',{hour12:false})),'order-date'));
    }
    const amount=element('div',null,'order-amounts');
    amount.append(element('span','实付 '+money(order.paidCents),'order-paid'),element('span','已退 '+money(order.refundedCents),'order-refunded'));card.append(amount);
    card.append(element('div','券状态：'+(order.couponStatuses.length?order.couponStatuses.map(status=>Object.hasOwn(coupons,status)?coupons[status]:'未知').join('、'):'无'),'order-coupons'));
    if(!historical&&order.selectionText==='选择订单 '+order.id&&/^选择订单 COUPON-[A-Za-z0-9_-]+$/.test(order.selectionText))action(card,'选择这笔订单',order.selectionText);
    cards.append(card);
  }
  container.append(cards);
  if(historical&&reply.orders.length)action(container,'重新查询最近订单','我有哪些订单');
  if(reply.hasMore)container.append(element('p','当前展示最近3笔，可按订单号继续查询','order-more'));
}

function renderProfileHints() {
  const { profiles } = state.config;
  els.profileSelect.textContent = '';
  for (const p of profiles) {
    els.profileSelect.appendChild(element('option', p.label, '')).value = p.id;
  }
  els.profileSelect.value = state.profileId;
  const profile = profiles.find(p => p.id === state.profileId) || profiles[0];
  els.starterList.textContent = '';
  const descriptions=['查看最近订单、实付金额和券状态','了解预约、有效期与使用条件','先查询订单，再核对退款条件'];
  for (const [index,example] of profile.examples.entries()) {
    const li = element('li', '', '');
    const btn = element('button', null, 'starter-button');
    btn.append(element('span',example,'starter-title'),element('span',descriptions[index]||'','starter-description'));
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (state.busy || !state.initialized || state.expired) return;
      if(els.chatInput.value&&els.chatInput.value!==example){setStatus('请先发送或清空输入框中的问题，再选择示例');els.chatInput.focus({preventScroll:true});return;}
      els.chatInput.value = example;
      saveDraft();updateCount();
      els.chatInput.focus({preventScroll:true});
    });
    li.appendChild(btn);
    els.starterList.appendChild(li);
  }
}

function readSettingsDraft() {
  return {
    modelSelection: els.modelSelect.value,
    thinkingLevel: els.thinkingSelect.value,
    maxTokens: Number(els.tokensSelect.value),
  };
}

function settingsEqual(a, b) {
  if (!a || !b) return false;
  return a.modelSelection === b.modelSelection
    && a.thinkingLevel === b.thinkingLevel
    && Number(a.maxTokens) === Number(b.maxTokens);
}

function updateSettingsControls() {
  const locked = state.busy || !state.initialized || state.expired;
  const draft = readSettingsDraft();
  const model = ((state.config && state.config.models) || []).find((m) => m.id === draft.modelSelection);
  const noThinking = !!model && model.supportsThinking === false;
  els.modelSelect.disabled = locked;
  els.tokensSelect.disabled = locked;
  els.thinkingSelect.disabled = locked || !model || !model.available || noThinking;
  for (const o of els.thinkingSelect.options) {
    if (o.value === 'high') o.disabled = noThinking;
  }
  els.applySettings.disabled = locked || state.settingsApplying
    || !validateSettings(draft) || !model || !model.available
    || (draft.thinkingLevel === 'high' && noThinking);
  let text = '已应用';
  let cls = '';
  if (state.settingsApplying) text = '应用中…';
  else if (state.expired) text = '会话已失效，请先重新连接';
  else if (state.settingsError) { text = String(state.settingsError); cls = 'error'; }
  else if (model && !model.available) text = '该模型暂不可用';
  else if (!settingsEqual(draft, state.session && state.session.settings)) text = '设置未应用';
  els.settingsStatus.textContent = text;
  els.settingsStatus.className = cls;
}

function renderChatSettings(syncForm = false) {
  const config = state.config || {};
  const oldDraft = readSettingsDraft();
  els.modelSelect.textContent = '';
  for (const m of config.models || []) {
    const opt = element('option', m.available ? m.label : m.label + '（未配置）');
    opt.value = m.id;
    opt.disabled = !m.available;
    els.modelSelect.appendChild(opt);
  }
  const s = syncForm
    ? (state.session && state.session.settings) || config.defaults || {}
    : oldDraft;
  els.modelSelect.value = s.modelSelection ?? '';
  els.thinkingSelect.value = s.thinkingLevel ?? 'off';
  els.tokensSelect.value = String(s.maxTokens ?? '');
  const actual = state.session && state.session.settings;
  const sm = state.session && state.session.model;
  els.activeSettings.replaceChildren();
  if (actual && sm) {
    const modelRow = element('div', null, 'settings-row');
    modelRow.append(element('span', '模型', 'settings-row-label'), element('span', sm.provider + '/' + sm.id, 'settings-row-value mono'));
    const thinkRow = element('div', null, 'settings-row');
    thinkRow.append(element('span', '思考模式', 'settings-row-label'), element('span', actual.thinkingLevel === 'high' ? '思考开启' : '思考关闭', 'settings-row-value'));
    const tokensRow = element('div', null, 'settings-row');
    tokensRow.append(element('span', '输出上限', 'settings-row-label'), element('span', String(actual.maxTokens), 'settings-row-value mono'));
    els.activeSettings.append(modelRow, thinkRow, tokensRow);
    if(state.session.modelAvailable===false)els.activeSettings.append(element('p',state.session.modelUnavailableReason,'settings-unavailable'));
  }
  renderEvaluationLink(config);
  updateSettingsControls();
}

function renderEvaluationLink(config) {
  let href = '';
  try {
    const u = new URL(config.evaluationUrl);
    const port = Number(u.port);
    if (u.protocol === 'http:'
      && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
      && u.port !== '' && Number.isInteger(port) && port >= 1024 && port <= 65535
      && !u.username && !u.password
      && u.pathname === '/' && !u.search && !u.hash) {
      const current = new URL(window.location.origin);
      if (current.hostname === '127.0.0.1' || current.hostname === 'localhost') {
        u.hostname = current.hostname;
        href = u.href;
      }
    }
  } catch (e) {}
  if (href) {
    els.evalLink.href = href;
    els.evalLink.hidden = false;
  } else {
    els.evalLink.removeAttribute('href');
    els.evalLink.hidden = true;
  }
}

async function openConversation(conversationId){
  if(state.busy||!state.initialized||state.expired||!state.session||conversationId===state.session.conversationId)return;
  if(state.session.turns===0&&els.chatInput.value){setStatus('请先发送或清空当前问题，再打开其他会话');if(els.historyDialog.open)els.historyDialog.close('draft-blocked');els.chatInput.focus({preventScroll:true});return;}
  const item=state.conversations.find(item=>item.id===conversationId&&item.profileId===state.profileId);
  if(!item)return;
  const oldSession=state.session,profileId=state.profileId,source=document.activeElement;
  const mobile=els.historyDialog.open;
  const intent={sessionId:oldSession.id,profileId,targetId:conversationId};
  state.openIntent=intent;state.draftTransfer=null;saveDraft();setBusy(true);setStatus('正在打开会话…');
  const gen=++state.generation;
  state.historyEpoch++;state.historyLoading=false;state.historyError='';
  let opened=false,failureHandoff=false;
  try{
    const data=await api('/api/chat/session/open',{conversationId,profileId,sessionId:oldSession.id});
    if(gen!==state.generation)return;
    if(!validateSession(data)||data.session.conversationId!==conversationId||data.session.profileId!==profileId
      ||data.session.id===oldSession.id||data.session.busy)throw new Error('会话响应格式异常，请重新连接');
    state.session=data.session;state.messages=data.messages;hydratedMessageIds=new Set(data.messages.map(message=>message.id));state.profileId=profileId;state.pendingTurn=null;
    state.failedAttempt=null;state.expired=false;state.remoteBusy=false;state.settingsError='';
    if(state.openIntent===intent)state.openIntent=null;
    els.chatInput.value=conversationDrafts.get(draftKey())||'';
    renderMessages(true);renderChatSettings(true);updateCount();
    els.initRetry.hidden=true;
    setStatus(data.session.turns>=20?'本次会话已达20轮，请新建对话':data.session.modelAvailable===false?data.session.modelUnavailableReason:data.messages.some(message=>message.status==='interrupted')?'已打开会话，未完成的问题不会自动重发':'已打开会话，可以继续咨询');
    opened=true;
    if(mobile)els.historyDialog.close('opened');
  }catch(error){
    if(gen!==state.generation)return;
    if(error.status!=null&&error.status!==503&&state.openIntent===intent)state.openIntent=null;
    setStatus(error.status===404?'此客户的会话记录已不可用，请刷新记录或选择其他会话':error.message,true);
    if(error.status==null||error.status===401||error.status===503){state.expired=true;els.initRetry.hidden=false;els.initRetry.textContent='重新连接';}
    if(mobile&&els.historyDialog.open){
      failureHandoff=!document.activeElement||document.activeElement===document.body||document.activeElement===source||document.activeElement===els.historyDialog;
      els.historyDialog.close('open-failed');
    }
  }finally{
    if(gen===state.generation){
      setBusy(false);refreshConversations();
      if(window.getSelection?.()?.isCollapsed!==false){
        if(opened&&(!document.activeElement||document.activeElement===document.body||document.activeElement===source
          ||mobile&&(document.activeElement===els.historyOpen||els.historyDialog.contains(document.activeElement))))els.chatInput.focus({preventScroll:true});
        else if(!opened&&failureHandoff&&(!document.activeElement||document.activeElement===document.body||document.activeElement===els.historyOpen)){
          const target=state.expired?els.initRetry:els.historyOpen;
          if(target.isConnected&&!target.disabled&&!target.hidden&&target.getClientRects().length)target.focus({preventScroll:true});
        }else if(!opened&&(!document.activeElement||document.activeElement===document.body)&&source?.isConnected&&!source.disabled&&!source.hidden&&source.getClientRects().length)source.focus({preventScroll:true});
      }
    }
  }
}

async function initialize(preferredProfileId) {
  if (state.initializing) return;
  const previousSession=state.session,previousDraft=els.chatInput.value;
  saveDraft();
  const focusSource = [els.newChat, els.initRetry].includes(document.activeElement) ? document.activeElement : null;
  state.initializing = true; state.initialized = false;
  setBusy(true); els.initRetry.hidden = true;
  const gen = ++state.generation;
  state.historyEpoch++;state.historyLoading=false;state.historyError='';
  setStatus('连接中…');
  try {
    const config = await api('/api/chat/config');
    if (gen !== state.generation) return;
    if (!validateConfig(config)) throw new Error('config');
    renderEvaluationLink(config);
    let data = await api('/api/chat/session');
    if (gen !== state.generation) return;
    if(!validateSession(data,config))throw new Error('session');
    const open=state.openIntent?.sessionId===previousSession?.id?state.openIntent:null;
    const reset=state.draftTransfer?.sessionId===previousSession?.id?state.draftTransfer:null;
    const pid=open?.profileId||reset?.profileId||previousSession?.profileId||(config.profiles.some(p=>p.id===preferredProfileId)?preferredProfileId:config.profiles[0].id);
    let targetId=open?.targetId||reset?.targetId||(!reset?previousSession?.conversationId:null),created=false,mutated=false;
    const freshId=data.session?.id??null;
    const sameTarget=data.session&&data.session.profileId===pid&&data.session.conversationId===targetId;
    if(!data.session||previousSession&&(!sameTarget||reset&&!reset.targetId)){
      if(data.session?.busy)throw Object.assign(new Error('其他页面正在处理咨询，请等待完成后重新连接'),{status:409});
      if(previousSession&&!open&&!reset&&previousSession.turns===0){
        const history=await api('/api/chat/sessions?profileId='+encodeURIComponent(pid));
        if(gen!==state.generation)return;
        if(!validateConversations(history,pid))throw Object.assign(new Error('会话记录格式异常，请重试连接'),{status:502});
        const accepted=history.conversations.some(item=>item.id===previousSession.conversationId&&item.turns>0);
        const uncertain=state.failedAttempt?.sessionId===previousSession.id&&state.failedAttempt.mayBeAccepted!==false
          ||state.pendingTurn?.sessionId===previousSession.id&&!state.pendingTurn.error;
        if(!accepted&&!uncertain)targetId=null;
      }
      if(targetId){
        data=await api('/api/chat/session/open',{conversationId:targetId,profileId:pid,sessionId:freshId});
      }else{
        created=true;
        const body={profileId:pid,sessionId:freshId};
        const oldSettings=reset?.settings||(previousSession?.profileId===pid&&validateSettings(previousSession.settings,config)?previousSession.settings:null);
        if(reset){if(reset.sendSettings||!settingsEqual(reset.settings,config.defaults))body.settings=reset.settings;}
        else if(oldSettings){
          const dm=config.models.find(m=>m.id==='configured'),isDefault=settingsEqual(oldSettings,{modelSelection:'configured',thinkingLevel:'off',maxTokens:2048});
          if(!(isDefault&&(!dm||dm.available===false)))body.settings=oldSettings;
        }
        data=await api('/api/chat/session',body);
      }
      mutated=true;
      if(gen!==state.generation)return;
    }
    if (!data || !data.session || !validateSession(data, config) || !config.profiles.some((p) => p.id === data.session.profileId)) throw new Error('session');
    if((previousSession||mutated)&&data.session.profileId!==pid||targetId&&data.session.conversationId!==targetId
      ||mutated&&(data.session.id===freshId||data.session.busy)||created&&data.messages.length!==0||reset&&!settingsEqual(data.session.settings,reset.settings))throw new Error('历史会话恢复失败，请重试连接');
    if (state.profileId && state.profileId !== data.session.profileId) {els.chatInput.value = '';conversationDrafts.clear();}
    else if(previousSession?.conversationId!==data.session.conversationId){
      const transfer=previousSession?.profileId===data.session.profileId&&(reset?reset.preserveDraft:created);
      els.chatInput.value=transfer?previousDraft:conversationDrafts.get(draftKey(data.session))||'';
      if(transfer)conversationDrafts.delete(draftKey(previousSession));
    }
    if(previousSession?.conversationId!==data.session.conversationId||!state.draftTransfer?.pending)state.draftTransfer=null;
    if(state.openIntent===open)state.openIntent=null;
    state.config = config; state.session = data.session; state.messages = data.messages;hydratedMessageIds=new Set(data.messages.map(message=>message.id)); state.profileId = data.session.profileId;
    state.pendingTurn = null;
    state.initialized = true; state.expired = false; state.failedAttempt = null;
    state.remoteBusy=data.session.busy;
    state.settingsError = ''; state.settingsApplying = false;
    saveDraft();renderProfileHints(); renderMessages(true); renderChatSettings(true); updateCount();
    setStatus(state.remoteBusy?'当前会话正在处理，请稍后查看结果':data.session.turns>=20?'本次会话已达20轮，请新建对话':data.session.modelAvailable===false?data.session.modelUnavailableReason:'可咨询');
    if(state.remoteBusy){els.initRetry.hidden=false;els.initRetry.textContent='查看处理结果';}
    refreshConversations();
  } catch (error) {
    if (gen !== state.generation) return;
    setStatus(error.status ? error.message : '连接失败，请重试。', true);
    els.initRetry.hidden = false; els.initRetry.textContent = '重新连接';
  } finally {
    if (gen === state.generation) {
      state.initializing = false;setBusy(false);
      if ((!document.activeElement || document.activeElement === document.body) && window.getSelection?.()?.isCollapsed !== false
        && focusSource?.isConnected) {
        const target = focusSource === els.initRetry && state.initialized && focusSource.hidden ? els.chatInput : focusSource;
        if (target.isConnected && !target.hidden && !target.disabled && target.getClientRects().length) target.focus({preventScroll:true});
      }
    }
  }
}

async function submitMessage(event) {
  if (event && event.preventDefault) event.preventDefault();
  if (state.busy || !state.initialized || !state.session || state.expired || state.session.turns>=20) return;
  const input = els.chatInput;
  const text = input.value;
  if (text.trim().length === 0 || text.length > 2000) return;
  const sid = state.session.id, gen = state.generation;
  const f = state.failedAttempt;
  const requestId = (f && f.sessionId === sid && f.text === text) ? f.requestId : crypto.randomUUID();
  const pending={sessionId:sid,generation:gen,requestId,text,draft:'',messageId:null,steps:[],error:false,accepted:false};
  state.pendingTurn=pending;
  const current=()=>gen===state.generation&&state.session?.id===sid&&state.pendingTurn===pending;
  setBusy(true);
  setStatus('正在处理');renderMessages(true);
  try {
    const res = await streamMessage({requestId,sessionId:sid,text},(event,data)=>{
      if(!current())return;
      if(event==='start'){pending.accepted=true;if(!data.replayed)state.session.turns=Math.min(20,state.session.turns+1);}
      if(event==='step'){
        const index=pending.steps.findIndex(step=>step.id===data.id);
        const step={id:data.id,label:data.label,status:data.status};
        if(index<0){if(pending.steps.length>=64)throw new Error('处理步骤超出上限');pending.steps.push(step);}
        else pending.steps[index]=step;
      }else if(event==='delta'){
        if(pending.messageId!==data.messageId){pending.messageId=data.messageId;pending.draft='';}
        pending.draft+=data.text;
      }
      renderMessages();
    });
    if (!current()) return;
    state.messages.push({ id: requestId + ':user', role: 'user', text });
    state.messages.push({ id: requestId + ':assistant', role: 'assistant', text: res.reply.text, reply: res.reply,steps:res.steps??pending.steps });
    state.pendingTurn=null;
    input.value = '';
    conversationDrafts.delete(draftKey());
    state.failedAttempt = null;
    renderMessages();
    updateCount();
    setStatus(state.session.turns>=20?"本次会话已达20轮，请新建对话":res.reply.kind === "notice" ? "请核对信息" : "已回复");
  } catch (error) {
    if (!current()) return;
    pending.error=true;
    for(const step of pending.steps)if(step.status==='running')step.status='error';
    state.failedAttempt = { sessionId: sid, requestId, text, mayBeAccepted:pending.accepted||error.status==null||Boolean(f&&f.sessionId===sid&&f.requestId===requestId&&f.mayBeAccepted!==false) };
    input.value = text;
    saveDraft();
    setStatus(error.message, true);
    renderMessages();
    if (error.status === 401 || error.status === 503) { state.expired = true; els.initRetry.hidden = false; els.initRetry.textContent = '重新连接'; }
  } finally {
    if (gen === state.generation) {
      setBusy(false);
      refreshConversations();
      if ((!document.activeElement || [document.body, input, els.sendButton].includes(document.activeElement))
        && window.getSelection?.()?.isCollapsed !== false) input.focus({preventScroll:true});
    }
  }
}

async function resetConversation(profileId, preserveDraft = false, newSettings = undefined) {
  var applying = newSettings !== undefined;
  var oldProfileId = state.session ? state.session.profileId : state.profileId;
  var restoreSelect = function () { if (els.profileSelect && oldProfileId) els.profileSelect.value = oldProfileId; };
  if (state.busy || !state.initialized || !state.config || state.expired) { restoreSelect(); return; }
  if (!state.config.profiles.some(function (p) { return p.id === profileId; })) { restoreSelect(); return; }
  var models = state.config.models || [], reqSettings, sendSettings;
  if (applying) {
    reqSettings = { modelSelection: newSettings.modelSelection, thinkingLevel: newSettings.thinkingLevel, maxTokens: newSettings.maxTokens };
    var reject = function (m) { state.settingsError = m; restoreSelect(); renderChatSettings(); setStatus(m, true); };
    if (!validateSettings(reqSettings)) { reject('设置无效'); return; }
    var cm = models.find(function (m) { return m.id === reqSettings.modelSelection; });
    if (!cm || cm.available === false) { reject('所选模型当前不可用'); return; }
    if (reqSettings.thinkingLevel === 'high' && !cm.supportsThinking) { reject('当前模型不支持此思考等级'); return; }
    sendSettings = true;
  } else {
    reqSettings = state.session && validateSettings(state.session.settings) ? state.session.settings : null;
    var dm = models.find(function (m) { return m.id === 'configured'; });
    var isDefault = !!(reqSettings && settingsEqual(reqSettings, { modelSelection: 'configured', thinkingLevel: 'off', maxTokens: 2048 }));
    sendSettings = !!reqSettings && !(isDefault && (!dm || dm.available === false));
  }
  var oldSession = state.session, oldMessages = state.messages, oldFailed = state.failedAttempt;
  var oldDraft = els.chatInput.value, oldId = oldSession ? oldSession.id : null;
  var focusSource = document.activeElement;
  if (applying) state.settingsApplying = true;
  setBusy(true);
  if (applying) state.settingsError = '';
  setStatus(applying ? '正在应用设置…' : profileId === oldProfileId ? '正在新建对话…' : '正在切换客户…', false);
  var gen = ++state.generation;
  var transfer = {sessionId:oldId,profileId:profileId,pending:true,targetId:null,settings:{...(sendSettings?reqSettings:state.config.defaults)},sendSettings:sendSettings,preserveDraft:preserveDraft&&oldProfileId===profileId};
  state.openIntent=null;state.draftTransfer=transfer;
  state.historyEpoch++;state.historyLoading=false;state.historyError='';
  try {
    var body = { profileId: profileId, sessionId: oldId };
    if (sendSettings) body.settings = reqSettings;
    var data = await api('/api/chat/session', body);
    if(transfer&&state.draftTransfer===transfer){transfer.pending=false;if(validUUID(data?.session?.conversationId))transfer.targetId=data.session.conversationId;}
    if (gen !== state.generation) return;
    var s = data && data.session;
    if (!validateSession(data) || !s || s.profileId !== profileId || !s.id || s.id === oldId || data.messages.length !== 0)
      throw new Error('新会话响应格式错误');
    if (reqSettings && !settingsEqual(s.settings, reqSettings)) throw new Error('新会话设置与预期不一致');
    state.session = s; state.profileId = profileId; state.messages = []; state.failedAttempt = null; state.expired = false;
    state.draftTransfer=null;hydratedMessageIds=new Set();state.remoteBusy=false;if(oldProfileId!==profileId)conversationDrafts.clear();else conversationDrafts.delete(draftKey(oldSession));
    state.pendingTurn=null;
    if (!(preserveDraft && oldProfileId === profileId)) els.chatInput.value = '';
    saveDraft();
    state.settingsError = '';
    renderProfileHints(); renderMessages(true); renderChatSettings(applying); updateCount();
    els.initRetry.hidden = true;
    setStatus(applying ? '设置已应用，已开始新会话' : '已开始新会话', false);
  } catch (err) {
    if(transfer&&state.draftTransfer===transfer){transfer.pending=false;if(err?.status!=null&&err.status!==503)state.draftTransfer=null;}
    if (gen !== state.generation) return;
    restoreSelect();
    state.session = oldSession; state.profileId = oldProfileId; state.messages = oldMessages; state.failedAttempt = oldFailed;
    els.chatInput.value = oldDraft;
    var msg = err && err.message ? err.message : (applying ? '应用设置失败' : '重置会话失败');
    if (applying) { state.settingsError = msg; renderChatSettings(); }
    setStatus(msg, true);
    var st = err ? err.status : undefined;
    if (st == null || st === 401 || st === 503) {
      state.expired = true;
      els.initRetry.hidden = false;
      els.initRetry.textContent = '重新连接';
    }
  } finally {
    if (applying) state.settingsApplying = false;
    if (gen === state.generation) {
      setBusy(false);
      refreshConversations();
      if ((!document.activeElement || document.activeElement === document.body) && window.getSelection?.()?.isCollapsed !== false
        && focusSource?.isConnected && !focusSource.hidden && !focusSource.disabled && focusSource.getClientRects().length) {
        focusSource.focus({preventScroll:true});
      }
    }
  }
}

function bindUIEvents() {
  els.chatForm.addEventListener("submit", submitMessage);
  els.chatInput.addEventListener("input", function () {
    saveDraft();updateCount();
  });
  els.chatInput.addEventListener("compositionstart", function () {
    state.composing = true;
  });
  els.chatInput.addEventListener("compositionend", function () {
    state.composing = false;
  });
  els.chatInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !state.composing && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      submitMessage(event);
    }
  });
  els.profileSelect.addEventListener("change", function () {
    const profileId = els.profileSelect.value;
    els.profileSelect.value = state.profileId;
    if (state.busy || !state.initialized || state.expired || els.profileSwitchDialog.open || profileId === state.profileId) return;
    const profile = state.config.profiles.find(p => p.id === profileId);
    if (!profile) return;
    saveDraft();
    if (conversationDrafts.size) {
      state.pendingProfileChange = { profileId, fromProfileId: state.profileId, sessionId: state.session.id };
      els.profileSwitchDescription.textContent = `切换到${profile.label}后，本页所有会话中未发送的问题会清空，已有会话记录会保留。`;
      els.profileSwitchDialog.returnValue = 'cancel';
      els.profileSwitchDialog.showModal();
      els.profileSwitchCancel.focus({preventScroll:true});
      return;
    }
    resetConversation(profileId, false);
  });
  els.profileSwitchDialog.addEventListener("close", function () {
    const change = state.pendingProfileChange;
    state.pendingProfileChange = null;
    els.profileSelect.focus({preventScroll:true});
    if (els.profileSwitchDialog.returnValue === 'switch' && change && !state.busy && state.initialized
      && state.profileId === change.fromProfileId && state.session?.id === change.sessionId) {
      resetConversation(change.profileId, false);
    }
  });
  els.newChat.addEventListener("click", function () {
    if (state.busy||state.expired) return;
    resetConversation(state.profileId, true);
  });
  els.initRetry.addEventListener("click", function () {
    if (state.busy&&!state.remoteBusy) return;
    if (state.expired||state.remoteBusy||state.failedAttempt) initialize(state.profileId);
    else initialize();
  });
  for(const [open,dialog,close] of [[els.historyOpen,els.historyDialog,els.historyClose],[els.settingsOpen,els.settingsDialog,els.settingsClose]]){
    open.addEventListener('click',()=>{
      if(!state.config||dialog.open)return;
      dialog.returnValue='cancel';dialog.showModal();close.focus({preventScroll:true});
      if(dialog===els.historyDialog&&!state.busy&&!state.historyLoading)refreshConversations();
    });
    close.addEventListener('click',()=>dialog.close('cancel'));
    dialog.addEventListener('close',()=>{
      if(!['opened','open-failed'].includes(dialog.returnValue)&&(!document.activeElement||document.activeElement===document.body||dialog.contains(document.activeElement))
        &&window.getSelection?.()?.isCollapsed!==false){
        const target=dialog===els.historyDialog&&!open.getClientRects().length?els.newChat:open;
        if(target.isConnected&&!target.disabled&&!target.hidden&&target.getClientRects().length)target.focus({preventScroll:true});
      }
    });
  }
  els.settingsForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (state.busy || !state.initialized || state.expired) return;
    resetConversation(state.profileId, true, readSettingsDraft());
  });
  function onSettingsChange() {
    state.settingsError = null;
    updateSettingsControls();
  }
  els.modelSelect.addEventListener("change", function () {
    var model = state.config.models.find(function (m) { return m.id === els.modelSelect.value; });
    if (model && model.supportsThinking === false) els.thinkingSelect.value = "off";
    onSettingsChange();
  });
  els.thinkingSelect.addEventListener("change", onSettingsChange);
  els.tokensSelect.addEventListener("change", onSettingsChange);
  els.evalLink.addEventListener("click", function (event) {
    if (state.busy || els.evalLink.hidden || !els.evalLink.getAttribute('href')) {
      event.preventDefault();
      return;
    }
    saveDraft();
    if(!conversationDrafts.size)return;
    event.preventDefault();
    if(els.evalLeaveDialog.open)return;
    pendingEvaluationLeave={href:els.evalLink.href,generation:state.generation,sessionId:state.session?.id,initialized:state.initialized};
    els.evalLeaveDialog.returnValue='cancel';
    els.evalLeaveDialog.showModal();
    els.evalLeaveCancel.focus({preventScroll:true});
  });
  els.evalLeaveDialog.addEventListener('close',()=>{
    const leave=pendingEvaluationLeave;
    pendingEvaluationLeave=null;
    if(els.evalLeaveDialog.returnValue==='leave'&&leave&&!state.busy&&leave.initialized===state.initialized
      &&leave.generation===state.generation&&leave.sessionId===state.session?.id&&leave.href===els.evalLink.href){
      window.location.assign(leave.href);
      return;
    }
    const target=els.chatInput.value&&!els.chatInput.disabled?els.chatInput:els.evalLink;
    if((!document.activeElement||document.activeElement===document.body||document.activeElement===els.settingsOpen||document.activeElement===els.evalLink||els.evalLeaveDialog.contains(document.activeElement))
      &&window.getSelection?.()?.isCollapsed!==false&&target.isConnected&&!target.hidden&&!target.disabled&&target.getClientRects().length)target.focus({preventScroll:true});
  });
  window.addEventListener("pageshow", function (event) {
    if (event.persisted === true) {
      window.location.reload();
    }
  });
  updateCount();
}


bindUIEvents();
initialize();
