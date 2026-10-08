'use strict';

const ids=['profile-select','new-chat','app-status','chat-messages','chat-empty','chat-form','chat-input','send-button','char-count','starter-list','order-hints','init-retry','eval-link','chat-settings','settings-form','model-select','thinking-select','tokens-select','apply-settings','settings-status','active-settings'];
const els={};
ids.forEach(id=>{els[id.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=document.getElementById(id);});
const state={config:null,session:null,messages:[],profileId:null,busy:true,initialized:false,expired:false,generation:0,failedAttempt:null,composing:false,settingsError:'',settingsApplying:false,pendingTurn:null};
function element(tag,text,className){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;}
function setStatus(text,isError=false){els.appStatus.textContent=text;els.appStatus.classList.toggle('error',isError);}
function setBusy(value){
  state.busy=Boolean(value);
  els.chatMessages.setAttribute('aria-busy',state.busy?'true':'false');
  const locked=state.busy||!state.initialized;
  els.evalLink.setAttribute("aria-disabled",locked?"true":"false");
  els.chatInput.disabled=locked;
  els.profileSelect.disabled=locked;
  els.initRetry.disabled=state.busy;
  els.newChat.disabled=state.busy||(!state.initialized&&!state.expired);
  const draft=els.chatInput.value;
  els.sendButton.disabled=locked||state.expired||!draft.trim()||draft.length>2000;
  for(const button of els.chatMessages.querySelectorAll('.order-select-button'))button.disabled=locked||state.expired;
  if(state.config)updateSettingsControls();
}
function updateCount(){const len=els.chatInput.value.length;els.charCount.textContent=`${len}/2000`;els.charCount.classList.toggle('over',len>2000);setBusy(state.busy);}
const HTTP_ERRORS={400:'请求无效，请检查后重试',401:'会话已失效，请新建对话',403:'没有权限执行此操作',409:'当前消息仍在处理中，请稍后重试',429:'请求过于频繁，请稍后再试',503:'服务暂不可用，请稍后重试'};
async function api(path,body){
  const init=body===undefined?{method:'GET'}:{method:'POST',headers:{'Content-Type':'application/json','X-Chat-Request':'1'},body:JSON.stringify(body)};
  init.credentials='same-origin';
  let response;
  try{response=await fetch(path,init);}catch{throw new Error('网络异常，请稍后重试');}
  let data=null;
  try{data=await response.json();}catch{}
  if(!response.ok){const err=new Error(HTTP_ERRORS[response.status]||'请求失败，请稍后重试');err.status=response.status;throw err;}
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
      const chunk=await reader.read();
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
  if (!c.profiles.every(p => p && typeof p.label === "string" && p.label.length > 0 && strs(p.orderHints) && strs(p.examples))) return false;
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
  if (typeof s.id !== "string" || !s.id || typeof s.label !== "string" || !s.label) return false;
  const pids = config && Array.isArray(config.profiles) ? config.profiles.map(p => p && p.id) : ["demo-a", "demo-b"];
  if (!pids.includes(s.profileId)) return false;
  if (!validateSettings(s.settings, config)) return false;
  if (!s.model || typeof s.model.provider !== "string" || !s.model.provider || typeof s.model.id !== "string" || !s.model.id) return false;
  return d.messages.every(m => m && typeof m.id === "string" && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && (!("reply" in m) || validateReply(m.reply)) && (m.steps===undefined||validateSteps(m.steps)));
}

function money(cents){
  if(typeof cents!=='number'||!Number.isSafeInteger(cents)||cents<0)return '未知';
  const fen=cents%100;
  const yuan=(cents-fen)/100;
  return `¥${yuan}.${String(fen).padStart(2,'0')}`;
}


function renderSteps(steps,container,pending=false){
  if(!steps||!steps.length)return;
  const details=element('details',null,'processing-steps');details.open=pending;
  details.append(element('summary',pending?'处理步骤':'处理步骤 · '+steps.length));
  const list=element('ul');
  const statuses={running:'处理中',done:'已完成',error:'未完成'};
  for(const step of steps){
    const item=element('li',null,'processing-step '+step.status);
    item.append(element('span',step.label,'step-label'),element('span',statuses[step.status],'step-status'));
    list.append(item);
  }
  details.append(list);container.append(details);
}
function renderMessage(m){
  const row=element('div',null,'message '+m.role);
  const reply=m.role==='assistant'?m.reply:undefined;
  if(reply?.kind==='notice')row.classList.add('notice');
  const avatar=element('div',m.role==='user'?'你':'d.','message-avatar');avatar.setAttribute('aria-hidden','true');
  const body=element('div',null,'message-body');
  body.append(element('div',m.role==='user'?'你':'Dave客服','message-label'));
  if(m.pending)body.append(element('div',m.error?'本轮未完成 · 可保留原文重试':'正在处理 · 答复尚未完成','turn-status'+(m.error?' error':'')));
  if(m.role==='assistant')renderSteps(m.steps,body,Boolean(m.pending));
  if(m.text||!m.pending)body.append(element('p',reply?reply.text:m.text,'message-text'));
  if(reply?.kind==='order')renderOrderCards(reply,body);
  if(reply?.evidenceIds?.length){
    const details=element('details',null,'evidence');details.append(element('summary','依据'));
    const list=element('ul');for(const id of reply.evidenceIds)list.append(element('li',id));details.append(list);body.append(details);
  }
  row.append(avatar,body);els.chatMessages.append(row);
}
function renderMessages(){
  els.chatMessages.replaceChildren();
  const pending=state.pendingTurn;
  const current=pending&&state.session&&pending.sessionId===state.session.id&&pending.generation===state.generation;
  if(!state.messages.length&&!current){els.chatMessages.append(els.chatEmpty);return;}
  for(const message of state.messages)renderMessage(message);
  if(current){
    renderMessage({role:'user',text:pending.text});
    renderMessage({role:'assistant',text:pending.draft,steps:pending.steps,pending:true,error:pending.error});
  }
  els.chatMessages.scrollTop=els.chatMessages.scrollHeight;
}
function renderOrderCards(reply,container){
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
    if(order.selectionText==='选择订单 '+order.id&&/^选择订单 COUPON-[A-Za-z0-9_-]+$/.test(order.selectionText)){
      const select=element('button','选择这笔订单','order-select-button');select.type='button';select.disabled=state.busy||!state.initialized||state.expired;
      select.addEventListener('click',()=>{
        if(state.busy||!state.initialized||state.expired)return;
        els.chatInput.value=order.selectionText;updateCount();submitMessage();
      });card.append(select);
    }
    cards.append(card);
  }
  container.append(cards);
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
  els.orderHints.textContent = '';
  for (const hint of profile.orderHints) {
    els.orderHints.appendChild(element('li', hint, ''));
  }
  els.starterList.textContent = '';
  for (const example of profile.examples) {
    const li = element('li', '', '');
    const btn = element('button', example, 'starter-button');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (state.busy || !state.initialized) return;
      els.chatInput.value = example;
      updateCount();
      els.chatInput.focus();
    });
    li.appendChild(btn);
    els.starterList.appendChild(li);
  }
  els.orderHints.parentElement.open = window.innerWidth > 700;
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
  const locked = state.busy || !state.initialized;
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
  }
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
  updateSettingsControls();
}

async function initialize(preferredProfileId) {
  if (state.initializing) return;
  state.initializing = true; state.initialized = false;
  setBusy(true); els.initRetry.hidden = true;
  const gen = ++state.generation;
  setStatus('连接中…');
  try {
    const config = await api('/api/chat/config');
    if (gen !== state.generation) return;
    if (!validateConfig(config)) throw new Error('config');
    let data = await api('/api/chat/session');
    if (gen !== state.generation) return;
    if (data && data.session === null) {
      const pid = config.profiles.some((p) => p.id === preferredProfileId) ? preferredProfileId : config.profiles[0].id;
      const body = { profileId: pid, sessionId: null };
      const oldSettings = state.session && state.session.profileId === preferredProfileId && validateSettings(state.session.settings, config) ? state.session.settings : null;
      if (oldSettings) {
        const dm = (Array.isArray(config.models) ? config.models : []).find((m) => m.id === 'configured');
        const isDefault = settingsEqual(oldSettings, { modelSelection: 'configured', thinkingLevel: 'off', maxTokens: 2048 });
        if (!(isDefault && (!dm || dm.available === false))) body.settings = oldSettings;
      }
      data = await api('/api/chat/session', body);
      if (gen !== state.generation) return;
    }
    if (!data || !data.session || !validateSession(data, config) || !config.profiles.some((p) => p.id === data.session.profileId)) throw new Error('session');
    if (state.profileId && state.profileId !== data.session.profileId) els.chatInput.value = '';
    state.config = config; state.session = data.session; state.messages = data.messages; state.profileId = data.session.profileId;
    state.pendingTurn = null;
    state.initialized = true; state.expired = false; state.failedAttempt = null;
    state.settingsError = ''; state.settingsApplying = false;
    renderProfileHints(); renderMessages(); renderChatSettings(true); updateCount(); setStatus('可咨询');
  } catch (error) {
    if (gen !== state.generation) return;
    setStatus(error.status ? error.message : '连接失败，请重试。', true);
    els.initRetry.hidden = false; els.initRetry.textContent = '重试连接';
  } finally {
    if (gen === state.generation) { setBusy(false); state.initializing = false; }
  }
}

async function submitMessage(event) {
  if (event && event.preventDefault) event.preventDefault();
  if (state.busy || !state.initialized || !state.session || state.expired) return;
  const input = els.chatInput;
  const text = input.value;
  if (text.trim().length === 0 || text.length > 2000) return;
  const sid = state.session.id, gen = state.generation;
  const f = state.failedAttempt;
  const requestId = (f && f.sessionId === sid && f.text === text) ? f.requestId : crypto.randomUUID();
  const pending={sessionId:sid,generation:gen,requestId,text,draft:'',messageId:null,steps:[],error:false};
  state.pendingTurn=pending;
  const current=()=>gen===state.generation&&state.session?.id===sid&&state.pendingTurn===pending;
  setBusy(true);
  setStatus('正在处理');renderMessages();
  try {
    const res = await streamMessage({requestId,sessionId:sid,text},(event,data)=>{
      if(!current())return;
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
    state.failedAttempt = null;
    renderMessages();
    updateCount();
    setStatus(res.reply.kind === "notice" ? "请核对信息" : "已回复");
  } catch (error) {
    if (!current()) return;
    pending.error=true;
    for(const step of pending.steps)if(step.status==='running')step.status='error';
    state.failedAttempt = { sessionId: sid, requestId, text };
    input.value = text;
    setStatus(error.message, true);
    renderMessages();
    if (error.status === 401 || error.status === 503) { state.expired = true; els.initRetry.hidden = false; els.initRetry.textContent = '重新开始'; }
  } finally {
    if (gen === state.generation) { setBusy(false); input.focus(); }
  }
}

async function resetConversation(profileId, preserveDraft = false, newSettings = undefined) {
  var applying = newSettings !== undefined;
  var oldProfileId = state.session ? state.session.profileId : state.profileId;
  var restoreSelect = function () { if (els.profileSelect && oldProfileId) els.profileSelect.value = oldProfileId; };
  if (state.busy || !state.initialized || !state.config) { restoreSelect(); return; }
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
  if (applying) state.settingsApplying = true;
  setBusy(true);
  if (applying) { state.settingsError = ''; setStatus('正在应用设置…', false); }
  var gen = ++state.generation;
  try {
    var body = { profileId: profileId, sessionId: oldId };
    if (sendSettings) body.settings = reqSettings;
    var data = await api('/api/chat/session', body);
    if (gen !== state.generation) return;
    var s = data && data.session;
    if (!validateSession(data) || !s || s.profileId !== profileId || !s.id || s.id === oldId || data.messages.length !== 0)
      throw new Error('新会话响应格式错误');
    if (reqSettings && !settingsEqual(s.settings, reqSettings)) throw new Error('新会话设置与预期不一致');
    state.session = s; state.profileId = profileId; state.messages = []; state.failedAttempt = null; state.expired = false;
    state.pendingTurn=null;
    if (!(preserveDraft && oldProfileId === profileId)) els.chatInput.value = '';
    state.settingsError = '';
    renderProfileHints(); renderMessages(); renderChatSettings(applying); updateCount();
    els.initRetry.hidden = true;
    setStatus(applying ? '设置已应用，已开始新会话' : '已开始新会话', false);
  } catch (err) {
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
      els.initRetry.textContent = '重新开始';
    }
  } finally {
    if (applying) state.settingsApplying = false;
    if (gen === state.generation) setBusy(false);
  }
}

function bindUIEvents() {
  els.chatForm.addEventListener("submit", submitMessage);
  els.chatInput.addEventListener("input", function () {
    updateCount();
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
    if (state.busy) {
      els.profileSelect.value = state.profileId;
      return;
    }
    resetConversation(els.profileSelect.value, false);
  });
  els.newChat.addEventListener("click", function () {
    if (!state.busy) resetConversation(state.profileId, false);
  });
  els.initRetry.addEventListener("click", function () {
    if (state.busy) return;
    if (state.expired) initialize(state.profileId);
    else initialize();
  });
  els.settingsForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (state.busy || !state.initialized) return;
    resetConversation(state.profileId, false, readSettingsDraft());
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
    if (state.busy || !state.initialized) {
      event.preventDefault();
    }
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
