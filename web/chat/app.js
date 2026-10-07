'use strict';

const ids=['profile-select','new-chat','app-status','chat-messages','chat-empty','chat-form','chat-input','send-button','char-count','starter-list','order-hints','init-retry'];
const els={};
ids.forEach(id=>{els[id.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=document.getElementById(id);});
const state={config:null,session:null,messages:[],profileId:null,busy:true,initialized:false,expired:false,generation:0,failedAttempt:null,composing:false};
function element(tag,text,className){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;}
function setStatus(text,isError=false){els.appStatus.textContent=text;els.appStatus.classList.toggle('error',isError);}
function setBusy(value){
  state.busy=Boolean(value);
  const locked=state.busy||!state.initialized;
  els.chatInput.disabled=locked;
  els.profileSelect.disabled=locked;
  els.initRetry.disabled=state.busy;
  els.newChat.disabled=state.busy||(!state.initialized&&!state.expired);
  const draft=els.chatInput.value;
  els.sendButton.disabled=locked||state.expired||!draft.trim()||draft.length>2000;
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


function validateReply(r){
  if(!r||typeof r!=='object')return false;
  if(!['answer','notice','order'].includes(r.kind))return false;
  if(typeof r.text!=='string')return false;
  if(r.evidenceIds!==undefined&&(!Array.isArray(r.evidenceIds)||!r.evidenceIds.every(x=>typeof x==='string')))return false;
  if(r.kind==='order'){
    if(!Array.isArray(r.orders))return false;
    if(!r.orders.every(o=>o&&typeof o.id==='string'&&typeof o.status==='string'&&Array.isArray(o.couponStatuses)&&o.couponStatuses.every(x=>typeof x==='string')))return false;
  }
  return true;
}
function validateSession(d){
  if(!d||typeof d!=='object'||!Array.isArray(d.messages))return false;
  const valid=d.messages.every(m=>m&&typeof m.id==='string'&&typeof m.text==='string'&&['user','assistant'].includes(m.role)&&(m.reply===undefined||validateReply(m.reply)));
  if(!valid)return false;
  if(d.session===null)return d.messages.length===0;
  const s=d.session;
  if(!s||typeof s!=='object')return false;
  return typeof s.id==='string'&&typeof s.label==='string'&&['demo-a','demo-b'].includes(s.profileId);
}
function money(cents){
  if(typeof cents!=='number'||!Number.isSafeInteger(cents)||cents<0)return '未知';
  const fen=cents%100;
  const yuan=(cents-fen)/100;
  return `¥${yuan}.${String(fen).padStart(2,'0')}`;
}


function renderMessages(){
  const list=state.messages;
  els.chatMessages.replaceChildren();
  if(!list.length){els.chatMessages.append(els.chatEmpty);return;}
  for(const m of list){
    const div=element('div',null,`message ${m.role}`);
    if(m.role==='assistant'&&m.reply&&m.reply.kind==='notice')div.classList.add('notice');
    div.append(element('div',m.role==='user'?'你':'Dave客服','message-label'));
    const isReply=m.role==='assistant'&&m.reply;
    div.append(element('p',isReply?m.reply.text:m.text,'message-text'));
    if(isReply&&m.reply.kind==='order')renderOrderCards(m.reply,div);
    const ids=m.reply&&m.reply.evidenceIds;
    if(m.role==='assistant'&&Array.isArray(ids)&&ids.length){
      const d=element('details',null,'evidence');
      d.append(element('summary','依据'));
      const ul=document.createElement('ul');
      ids.forEach(id=>ul.append(element('li',id)));
      d.append(ul);
      div.append(d);
    }
    els.chatMessages.append(div);
  }
  els.chatMessages.scrollTop=els.chatMessages.scrollHeight;
}

function renderOrderCards(reply, container) {
  if (!reply || reply.kind !== 'order' || !Array.isArray(reply.orders) || !container) return;
  const S = { paid: '已支付', refunded: '已退款', redeemed: '已核销', partially_redeemed: '部分核销', pending_payment: '待付款', closed: '已关闭' };
  const C = { unused: '未核销', redeemed: '已核销', expired: '已过期', refunded: '已退款' };
  for (const o of reply.orders) {
    if (!o || typeof o !== 'object') continue;
    const card = element('div', '', 'order-card');
    card.appendChild(element('div', '订单号：' + (o.id == null || o.id === '' ? '未知' : String(o.id)), 'order-id'));
    card.appendChild(element('div', '状态：' + (Object.hasOwn(S, o.status) ? S[o.status] : '未知状态'), 'order-status'));
    card.appendChild(element('div', '实付：' + money(o.paidCents), 'order-paid'));
    card.appendChild(element('div', '已退：' + money(o.refundedCents), 'order-refunded'));
    const cs = Array.isArray(o.couponStatuses) ? o.couponStatuses : [];
    card.appendChild(element('div', '券状态：' + (cs.length ? cs.map(c => Object.hasOwn(C, c) ? C[c] : '未知').join('、') : '无'), 'order-coupons'));
    container.appendChild(card);
  }
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

async function initialize() {
  if (state.initializing) return;
  state.initializing = true; state.initialized = false;
  setBusy(true); els.initRetry.hidden = true;
  const gen = ++state.generation;
  setStatus('连接中…');
  const strArr = (a) => Array.isArray(a) && a.every((s) => typeof s === 'string');
  const okProfile = (p) => p && (p.id === 'demo-a' || p.id === 'demo-b') && typeof p.label === 'string' && strArr(p.orderHints) && strArr(p.examples);
  const okConfig = (c) => c && c.version === 1 && c.simulation === true && c.readOnly === true && c.limits && c.limits.messageCharacters === 2000
    && Array.isArray(c.profiles) && c.profiles.length === 2 && c.profiles.every(okProfile) && c.profiles[0].id !== c.profiles[1].id;
  try {
    const config = await api('/api/chat/config');
    if (gen !== state.generation) return;
    if (!okConfig(config)) throw new Error('config');
    let data = await api('/api/chat/session');
    if (gen !== state.generation) return;
    if (data && data.session === null) {
      data = await api('/api/chat/session', { profileId: config.profiles[0].id });
      if (gen !== state.generation) return;
    }
    if (!data || !validateSession(data) || !config.profiles.some((p) => p.id === data.session.profileId)) throw new Error('session');
    state.config = config; state.session = data.session; state.messages = data.messages; state.profileId = data.session.profileId;
    state.initialized = true; state.expired = false; state.failedAttempt = null;
    renderProfileHints(); renderMessages(); updateCount(); setStatus('可咨询');
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
  setBusy(true);
  setStatus('正在查询');
  try {
    const res = await api('/api/chat/messages', { requestId, text });
    if (gen !== state.generation || !state.session || state.session.id !== sid) return;
    if (!res || res.sessionId !== sid || res.requestId !== requestId || !validateReply(res.reply)) throw new Error('响应校验失败');
    state.messages.push({ id: requestId + ':user', role: 'user', text });
    state.messages.push({ id: requestId + ':assistant', role: 'assistant', text: res.reply.text, reply: res.reply });
    input.value = '';
    state.failedAttempt = null;
    renderMessages();
    updateCount();
    setStatus(res.reply.kind === "notice" ? "请核对信息" : "已回复");
  } catch (error) {
    if (gen !== state.generation) return;
    state.failedAttempt = { sessionId: sid, requestId, text };
    input.value = text;
    setStatus(error.message, true);
    if (error.status === 401 || error.status === 503) { state.expired = true; els.initRetry.hidden = false; els.initRetry.textContent = '重新开始'; }
  } finally {
    if (gen === state.generation) { setBusy(false); input.focus(); }
  }
}

async function resetConversation(profileId, preserveDraft = false) {
  var oldProfileId = state.session ? state.session.profileId : state.profileId;
  var restoreSelect = function () { if (els.profileSelect && oldProfileId) els.profileSelect.value = oldProfileId; };
  if (state.busy || !state.initialized || !state.config) { restoreSelect(); return; }
  if (!state.config.profiles.some(function (p) { return p.id === profileId; })) { restoreSelect(); return; }
  var oldSession = state.session, oldMessages = state.messages, oldFailed = state.failedAttempt;
  var oldDraft = els.chatInput.value, oldId = oldSession ? oldSession.id : null;
  setBusy(true);
  var gen = ++state.generation;
  try {
    var data = await api('/api/chat/session', { profileId: profileId });
    if (gen !== state.generation) return;
    var s = data && data.session;
    if (!validateSession(data) || !s || s.profileId !== profileId || !s.id || s.id === oldId || data.messages.length !== 0)
      throw new Error('新会话响应格式错误');
    state.session = s; state.profileId = profileId; state.messages = []; state.failedAttempt = null; state.expired = false;
    if (!(preserveDraft && oldProfileId === profileId)) els.chatInput.value = '';
    renderProfileHints(); renderMessages(); updateCount();
    els.initRetry.hidden = true;
    setStatus('已开始新会话', false);
  } catch (err) {
    if (gen !== state.generation) return;
    restoreSelect();
    state.session = oldSession; state.profileId = oldProfileId; state.messages = oldMessages; state.failedAttempt = oldFailed;
    els.chatInput.value = oldDraft;
    setStatus(err && err.message ? err.message : '重置会话失败', true);
    var st = err ? err.status : undefined;
    if (st == null || st === 401 || st === 503) {
      state.expired = true;
      els.initRetry.hidden = false;
      els.initRetry.textContent = '重新开始';
    }
  } finally {
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
    if (state.expired) resetConversation(state.profileId, true);
    else initialize();
  });
  updateCount();
}

bindUIEvents();
initialize();
