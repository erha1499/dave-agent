import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Exercise actual UI code with synthetic HTTP, independently of Kimi's implementation.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.events = new Map(); this.attrs = new Map();
    this.value = ''; this.disabled = false; this.hidden = false; this.className = ''; this.dataset = {}; this.style = {};
    this.open = false; this.returnValue = '';
    this.isConnected = true;
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 600;
    this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => { const add = force ?? !this.className.split(' ').includes(name); this.classList[add ? 'add' : 'remove'](name); },
      contains: name => this.className.split(' ').includes(name) };
  }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get textContent() { return (this.text ?? '') + this.children.map(node => node.textContent).join(''); }
  set innerHTML(value) { assert.equal(value, '', 'dynamic HTML must never be evaluated'); this.replaceChildren(); }
  get innerHTML() { return ''; }
  get parentElement() { return this.parentNode ?? null; }
  get options() { return this.children.filter(node => node.tagName === 'OPTION'); }
  set disabled(value) { this._disabled = Boolean(value); if (this._disabled && this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  get disabled() { return this._disabled ?? false; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, reference) { if (typeof node === 'string') { const text = new Element(); text.textContent = node; node = text; } if (node === reference) return node; node.remove(); node.parentNode = this; this.children.splice(reference ? this.children.indexOf(reference) : this.children.length, 0, node); for (const child of walk(node)) child.isConnected = this.isConnected; return node; }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...nodes); }
  remove() { if (this.contains(this.ownerDocument?.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; for (const child of walk(this)) child.isConnected = false; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); if (name === 'id') this.id = value; }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  set href(value) { this.setAttribute('href', String(value)); }
  get href() { return this.getAttribute('href') ?? ''; }
  removeAttribute(name) { this.attrs.delete(name); }
  addEventListener(name, fn) { this.events.set(name, fn); }
  focus(options) { this.focusCalls = (this.focusCalls ?? 0) + 1; this.focusOptions = options; if (!this.disabled && this.getClientRects().length && this.ownerDocument) this.ownerDocument.activeElement = this; } scrollIntoView() {}
  getClientRects() { for(let node=this;node;node=node.parentNode)if(!node.isConnected||node.hidden||node.style.display==='none'||node.tagName==='DIALOG'&&!node.open)return [];return [{}]; }
  showModal() { this.open = true; this.showModalCalls = (this.showModalCalls ?? 0) + 1; }
  close(value = this.returnValue) { if (!this.open) return; this.open = false; this.returnValue = value; if(this.contains(this.ownerDocument?.activeElement))this.ownerDocument.activeElement=this.ownerDocument.body;this.fire('close'); }
  fire(name, event = {}) { let prevented=false;const result=this.events.get(name)?.({ target: this, currentTarget: this, preventDefault() {prevented=true;}, ...event });if(name==='cancel'&&this.tagName==='DIALOG'&&!prevented)this.close();return result; }
  querySelectorAll(selector) { return walk(this).filter(node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : selector.startsWith('#') ? node.id === selector.slice(1) : node.tagName.toLowerCase() === selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(node) { return walk(this).includes(node); }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const tick = async () => { await setImmediate(); await setImmediate(); };
const profile = id => ({ id, label: `客户 ${id}`, examples: ['我有哪些订单','团购券需要预约吗？','我要退款'] });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => structuredClone(body) });
const frame = (event, data, newline = '\n') => `event: ${event}${newline}data: ${JSON.stringify(data)}${newline}${newline}`;
function streamResponse(text) {
  const bytes = new TextEncoder().encode(text);
  // Byte-sized chunks exercise split UTF-8, CRLF and event boundaries.
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
function openStream() {
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }),
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  return { response, write: text => controller.enqueue(new TextEncoder().encode(text)), close: () => controller.close(), fail:error=>controller.error(error) };
}
const defaults = { modelSelection: 'configured', thinkingLevel: 'off', maxTokens: 2048 };
const models = [
  { id: 'configured', label: '当前配置', provider: 'deepseek', modelId: 'deepseek-flash', available: true, supportsThinking: true },
  { id: 'deepseek-flash', label: 'DeepSeek Flash', provider: 'deepseek', modelId: 'deepseek-flash', available: true, supportsThinking: true },
  { id: 'deepseek-v4-pro', label: 'DeepSeek Pro', provider: 'deepseek', modelId: 'deepseek-v4-pro', available: true, supportsThinking: true },
  { id: 'qwen3.7-plus-2026-05-26', label: '千问', provider: 'bailian', modelId: 'qwen3.7-plus-2026-05-26', available: false, supportsThinking: true }
];
const config = { version: 2, simulation: true, readOnly: true, profiles: [profile('demo-a'), profile('demo-b')], limits: { messageCharacters: 2000 },
  defaults, models, options: { thinkingLevels: ['off', 'high'], maxTokens: [512, 1024, 2048] }, evaluationUrl: 'http://127.0.0.1:3001/' };

export async function checkWebChatUI() {
  const ids = ['profile-select', 'new-chat', 'app-status', 'init-retry', 'chat-messages', 'chat-empty', 'starter-list', 'chat-form', 'chat-input', 'char-count', 'send-button',
    'eval-link', 'chat-settings', 'settings-form', 'model-select', 'thinking-select', 'tokens-select', 'apply-settings', 'settings-status', 'active-settings',
    'profile-switch-dialog', 'profile-switch-description', 'profile-switch-cancel','conversation-list','conversation-mobile-list','history-open','history-dialog','history-close','conversation-title','settings-open','settings-dialog','settings-close','eval-leave-dialog','eval-leave-cancel'];
  const html = await readFile(new URL('../web/chat/index.html', import.meta.url), 'utf8');
  assert.ok(/<dialog\b[^>]*\bid=["']profile-switch-dialog["']/.test(html), 'customer draft confirmation must use a page-local native dialog');
  assert.match(html, /<dialog\b[^>]*aria-labelledby="profile-switch-title"[^>]*aria-describedby="profile-switch-description"/);
  assert.match(html, /<form\b[^>]*method="dialog"/);
  assert.match(html, /<button\b[^>]*id="profile-switch-cancel"[^>]*value="cancel"[^>]*autofocus[^>]*>保留当前客户<\/button>/);
  assert.match(html, /<button\b[^>]*value="switch"[^>]*>切换并清空草稿<\/button>/);
  for(const id of ['history-dialog','settings-dialog'])assert.match(html,new RegExp(`<dialog\\b[^>]*id=["']${id}["']`));
  assert.doesNotMatch(html,/order-hints|团购券使用 · 本人订单 · 到账规则/);
  const permanentNavigation=html.match(/<div\b[^>]*class=["']sidebar-bottom["'][^>]*>[\s\S]*?<\/div>/)?.[0];
  assert.match(permanentNavigation??'',/<a\b[^>]*id=["']eval-link["'][^>]*>[\s\S]*?评测工作台[\s\S]*?<\/a>/,'evaluation has one visible-text entry in permanent navigation');
  assert.doesNotMatch(html.match(/<dialog\b[^>]*id=["']settings-dialog["'][^>]*>[\s\S]*?<\/dialog>/)?.[0]??'',/id=["']eval-link["']/,'independent navigation is outside the settings modal');
  const stylesheets = [...html.matchAll(/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/g)].map(match => match[1]);
  assert.equal(stylesheets[0], '/ui.css', 'chat must load the actual evaluation theme first');
  assert.ok(stylesheets.length === 2 && /^(?:\.\/|\/)?style\.css$/.test(stylesheets[1]), 'only the shared theme and local chat layout stylesheet are loaded');
  const chatCSS=await readFile(new URL('../web/chat/style.css',import.meta.url),'utf8');
  assert.match(chatCSS,/\.chat-page \.conversation-list\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/,'long history titles cannot size the outer grid beyond its sidebar');
  assert.match(chatCSS,/\.chat-page \.conversation-rows\s*\{[^}]*min-width\s*:\s*0(?:[;}])/,'the generated history wrapper must also be shrinkable');
  assert.doesNotMatch(html, /target=["']_blank["']|模拟数据|演示客户/, 'ordinary chat chrome uses product language and same-tab navigation');
  const evaluationHtml = await readFile(new URL('../web/evaluation/index.html', import.meta.url), 'utf8');
  const mainNavigation = evaluationHtml.match(/<nav\b[^>]*aria-label=["']主导航["'][^>]*>[\s\S]*?<\/nav>/)?.[0];
  assert.ok(mainNavigation, 'evaluation retains the same top-level product navigation');
  assert.match(mainNavigation, /href=["']\/chat["'][^>]*>客服问答<\/a>/, 'evaluation exposes a fixed return path');
  assert.match(mainNavigation, /<span\b(?![^>]*\bhref\s*=)[^>]*aria-current=["']page["'][^>]*>评测工作台<\/span>/, 'current evaluation navigation must be static to preserve unsent experiment settings');
  assert.doesNotMatch(mainNavigation, /<a\b[^>]*aria-current=["']page["']/, 'current evaluation navigation cannot reload the same page');
  assert.doesNotMatch(mainNavigation, /target=["']_blank["']/);
  for (const id of ids) assert.equal([...html.matchAll(new RegExp(`\\bid=["']${id}["']`, 'g'))].length, 1, `actual HTML must bind ${id} exactly once`);
  for (const [tag, id] of [['form', 'chat-form'], ['form', 'settings-form'], ['textarea', 'chat-input'],
    ['select', 'profile-select'], ['select', 'model-select'], ['select', 'thinking-select'], ['select', 'tokens-select']])
    assert.match(html, new RegExp(`<${tag}\\b[^>]*\\bid=["']${id}["']`), `${id} must keep its native semantics`);
  for (const id of ['chat-input', 'profile-select', 'model-select', 'thinking-select', 'tokens-select'])
    assert.match(html, new RegExp(`<label\\b[^>]*\\bfor=["']${id}["']`), `${id} must retain an accessible label`);
  const nodes = new Map(ids.map(id => [id, Object.assign(new Element(id === 'chat-input' ? 'textarea' : id.endsWith('-select') ? 'select' : id.endsWith('-dialog')?'dialog':'div'), { id })]));
  nodes.get('chat-messages').append(nodes.get('chat-empty'));
  nodes.get('chat-empty').append(nodes.get('starter-list'));
  nodes.get('settings-dialog').append(nodes.get('settings-close'),nodes.get('active-settings'),nodes.get('chat-settings'));
  nodes.get('chat-settings').append(nodes.get('settings-form'));
  nodes.get('settings-form').append(...['model-select','thinking-select','tokens-select','apply-settings','settings-status'].map(id=>nodes.get(id)));
  nodes.get('history-dialog').append(nodes.get('history-close'),nodes.get('conversation-mobile-list'));
  nodes.get('eval-leave-dialog').append(nodes.get('eval-leave-cancel'));
  for(const id of ['conversation-list','conversation-mobile-list'])nodes.get(id).textContent='正在读取会话…';
  const docEvents = new Map(), windowEvents = new Map(), pending = [], calls = [];
  let navigationReloads = 0;const evaluationNavigations=[];
  let session = null, resetError = 0, resetErrorMessage = '当前消息仍在处理中', serverMessages = [];
  const conversations = new Map(),acceptedRequests=new Set();
  let historyError=0,historyOverride=null,historyWait=null,releaseHistory=null,openError=0,openWait=null,releaseOpen=null,openBodyFailure='',resetBodyFailure='',sessionReadOverride=null;
  const pauseHistory=()=>{historyWait=new Promise(resolve=>{releaseHistory=resolve;});};
  const resumeHistory=()=>{const release=releaseHistory;historyWait=null;releaseHistory=null;release();};
  const pauseOpen=()=>{openWait=new Promise(resolve=>{releaseOpen=resolve;});};
  const resumeOpen=()=>{const release=releaseOpen;openWait=null;releaseOpen=null;release();};
  let fixtureTime=0;
  const recordCurrent=()=>{
    if(!session)return;
    const prior=conversations.get(session.conversationId);
    const updatedAt=new Date(Date.parse('2026-10-09T00:00:00.000Z')+fixtureTime++*1000).toISOString();
    conversations.set(session.conversationId,{session:structuredClone(session),messages:structuredClone(serverMessages),
      title:serverMessages.find(message=>message.role==='user')?.text.trim().slice(0,60)||'新对话',createdAt:prior?.createdAt??updatedAt,updatedAt,
      status:session.busy?'busy':session.turns>=20?'limit':serverMessages.some(message=>message.status==='interrupted')?'interrupted':'ready'});
  };
  let configFailure = false, configWait = null, releaseConfig = null;
  let resetWait = null, releaseReset = null;
  const pauseReset = () => { resetWait = new Promise(resolve => { releaseReset = resolve; }); };
  const resumeReset = () => { const release = releaseReset; resetWait = null; releaseReset = null; release(); };
  const fetch = async (url, options = {}) => {
    const path = String(url), body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, body });
    if (body) { assert.equal(new Headers(options.headers).get('X-Chat-Request'), '1'); assert.equal(new Headers(options.headers).get('Content-Type'), 'application/json'); }
    if (path === '/api/chat/config') {
      if (configWait) await configWait;
      if (configFailure) { configFailure = false; throw new TypeError('synthetic config interruption'); }
      return response(config);
    }
    if (path === '/api/chat/session' && body === undefined) {recordCurrent();return response(sessionReadOverride??{ session, messages: session?serverMessages:[] });}
    if (path.startsWith('/api/chat/sessions?profileId=')) {
      const requestedProfile=new URL(path,'http://localhost').searchParams.get('profileId');
      if(historyWait)await historyWait;
      if(historyError)return response({error:'synthetic history failure'},historyError);
      if(historyOverride)return response(historyOverride);
      recordCurrent();
      return response({conversations:[...conversations.values()].filter(record=>record.session.profileId===requestedProfile&&record.session.turns>0)
        .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(record=>({id:record.session.conversationId,profileId:record.session.profileId,title:record.title,
          createdAt:record.createdAt,updatedAt:record.updatedAt,turns:record.session.turns,status:record.status,current:record.session.conversationId===session?.conversationId})),limit:100});
    }
    if(path==='/api/chat/session/open'){
      assert.deepEqual(Object.keys(body).sort(),['conversationId','profileId','sessionId']);
      if(body.sessionId!==(session?.id??null))return response({error:'页面会话已失效'},401);
      const waitingOpen=openWait;openWait=null;if(waitingOpen)await waitingOpen;
      if(body.sessionId!==(session?.id??null))return response({error:'页面会话已失效'},401);
      if(openError)return response({error:'synthetic history open failure'},openError);
      const record=conversations.get(body.conversationId);
      if(!record||record.session.profileId!==body.profileId)return response({error:'没有此会话'},404);
      recordCurrent();if(session?.turns===0)conversations.delete(session.conversationId);
      session={...structuredClone(record.session),id:randomUUID(),busy:false};serverMessages=structuredClone(record.messages);recordCurrent();
      if(openBodyFailure==='throw')return {ok:true,status:200,json:async()=>{throw new TypeError('synthetic committed open body loss');}};
      if(openBodyFailure==='malformed')return response({session:{...session,conversationId:'invalid'},messages:serverMessages});
      return response({session,messages:serverMessages});
    }

    if (path === '/api/chat/session') {
      assert.ok(Object.hasOwn(body, 'sessionId'), 'creation/reset always declares UUID or null');
      if (body.sessionId !== (session?.id ?? null)) return response({ error: '页面会话已失效，请重新连接。' }, 401);
      if (resetWait) await resetWait;
      if (resetError) return response({ error: resetErrorMessage }, resetError);
      const settings = body.settings ?? defaults;
      const selected = models.find(model => model.id === settings.modelSelection);
      recordCurrent();if(session?.turns===0)conversations.delete(session.conversationId);serverMessages = [];
      session = { id: randomUUID(), conversationId: randomUUID(), turns: 0, busy:false, modelAvailable:true, profileId: body.profileId, label: profile(body.profileId).label,
        settings: structuredClone(settings), model: { provider: selected.provider, id: selected.modelId } };
      recordCurrent();
      if(resetBodyFailure)return {ok:true,status:200,json:async()=>{throw new TypeError('synthetic committed reset body loss');}};
      return response({ session, messages: [] });
    }
    assert.equal(path, '/api/chat/messages/stream');
    assert.equal(body.sessionId, session.id, 'every message declares the page session before HTTP execution');
    return new Promise((resolve, reject) => pending.push({ body, resolve, reject })).then(async res => {
      if(!res.ok)return res;
      const receipt=body.sessionId+':'+body.requestId,replayed=acceptedRequests.has(receipt);
      if(!replayed&&session?.id===body.sessionId){acceptedRequests.add(receipt);session.turns++;recordCurrent();}
      if(res instanceof Response)return res;
      const result = await res.json();
      if(session?.id===result.sessionId&&!serverMessages.some(message=>message.id===result.requestId+':user')){
        serverMessages.push({id:result.requestId+':user',role:'user',text:body.text},
          {id:randomUUID(),role:'assistant',text:result.reply.text,reply:result.reply,...(result.steps?{steps:result.steps}:{})});
        recordCurrent();
      }
      return streamResponse(frame('start', { sessionId: result.sessionId, requestId: result.requestId, replayed }, '\r\n')
        + frame('result', result, '\r\n'));
    });
  };
  const document = { body: new Element('body'), getElementById: id => nodes.get(id), createElement: tag => Object.assign(new Element(tag), { ownerDocument: document }), createTextNode: text => Object.assign(new Element('#text'), { nodeType: 3, textContent: text, ownerDocument: document }),
    querySelector: selector => nodes.get(selector.replace(/^#/, '')), addEventListener: (name, fn) => docEvents.set(name, fn), readyState: 'complete' };
  document.activeElement = document.body;
  for (const node of nodes.values()) node.ownerDocument = document;
  const context = createContext({ document, fetch, crypto: { randomUUID }, console, Headers, Response, ReadableStream, TextDecoder, TextEncoder, URL, AbortController, setTimeout, clearTimeout, structuredClone,
    window: { addEventListener: (name, fn) => windowEvents.set(name, fn), innerWidth: 1440,
      location: { origin: 'http://127.0.0.1:3002', reload: () => { navigationReloads++; },assign:href=>evaluationNavigations.push(href) } } });
  const source = await readFile(new URL('../web/chat/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /window\.confirm\(/, 'confirmation remains inspectable inside the page');
  runInContext(source, context); docEvents.get('DOMContentLoaded')?.(); await tick();
  // A fresh page may read a valid catalog while the independent chat session service fails.
  const navigationState=runInContext('({...state})',context),navigationFetch=context.fetch;
  assert.equal(runInContext('conversationDrafts.size',context),0);
  for(const failure of ['session503','config503','bad-config','unsafe-url']){
    const navigationCalls=[];
    context.fetch=async(path,options={})=>{
      navigationCalls.push({path,method:options.method??'GET'});
      if(path==='/api/chat/config')return failure==='config503'?response({error:'synthetic config unavailable'},503)
        :response(failure==='bad-config'?{...config,version:99}:failure==='unsafe-url'?{...config,evaluationUrl:'https://evil.test/'}:config);
      assert.equal(path,'/api/chat/session');return response({error:'synthetic session unavailable'},503);
    };
    nodes.get('eval-link').removeAttribute('href');nodes.get('eval-link').hidden=true;
    runInContext('state.session=null;state.config=null;state.profileId=null;state.remoteBusy=false;state.initialized=false;initialize()',context);await tick();
    assert.equal(runInContext('state.initialized',context),false);assert.equal(runInContext('state.busy',context),false);
    assert.equal(nodes.get('chat-input').disabled,true,'failed chat initialization keeps all business submission guards');
    let blocked=false;nodes.get('eval-link').fire('click',{preventDefault:()=>{blocked=true;}});
    if(failure==='session503'){
      assert.equal(nodes.get('eval-link').hidden,false,'validated evaluation navigation survives chat session GET503');
      assert.equal(nodes.get('eval-link').href,'http://127.0.0.1:3001/');
      assert.equal(nodes.get('eval-link').getAttribute('aria-disabled'),'false');
      assert.equal(blocked,false,'an idle session failure cannot block independent evaluation navigation');
    }else{
      assert.equal(nodes.get('eval-link').hidden,true);assert.equal(nodes.get('eval-link').getAttribute('href'),null);
      assert.equal(nodes.get('eval-link').getAttribute('aria-disabled'),'true');
      assert.equal(blocked,true,'no valid local href means even synthetic activation cannot navigate');
    }
    assert.deepEqual(navigationCalls.map(call=>call.path),failure==='config503'||failure==='bad-config'?['/api/chat/config']:['/api/chat/config','/api/chat/session']);
    assert.ok(navigationCalls.every(call=>call.method==='GET'),'navigation never creates a session or sends a message');
    assert.equal(evaluationNavigations.length,0);assert.equal(nodes.get('eval-leave-dialog').showModalCalls??0,0);
  }
  context.fetch=navigationFetch;context.navigationState=navigationState;
  runInContext('Object.assign(state,navigationState);renderEvaluationLink(state.config);setBusy(false)',context);delete context.navigationState;
  assert.ok(document.activeElement===document.body);
  assert.ok(calls.some(call => call.path === '/api/chat/sessions?profileId=demo-a'), 'first connection reads the real server conversation list');
  for(const id of ['conversation-list','conversation-mobile-list'])assert.ok(!nodes.get(id).textContent.includes('正在读取会话…'),'successful history reads replace the initial placeholder');
  assert.ok(document.activeElement === document.body, 'first load must not automatically move keyboard focus');
  for (const invalid of [
    { productName: 7 }, { shopName: {} }, { createdAt: false }, { selectionText: 123 }
  ]) {
    context.invalidReply = { kind: 'order', text: '错误卡片', orders: [{ id: 'COUPON-1', status: 'paid', paidCents: 1, refundedCents: 0, couponStatuses: [], ...invalid }] };
    assert.equal(runInContext('validateReply(invalidReply)', context), false, 'optional order fields retain type validation');
  }
  context.invalidReply = { kind: 'order', text: '', orders: [], hasMore: 'yes' };
  assert.equal(runInContext('validateReply(invalidReply)', context), false, 'truncation flag must be boolean');
  const input = nodes.get('chat-input'), form = nodes.get('chat-form'), select = nodes.get('profile-select');
  const profileDialog = nodes.get('profile-switch-dialog');
  const confirmations = () => profileDialog.showModalCalls ?? 0;
  assert.equal(select.value, 'demo-a'); assert.equal(input.disabled, false);
  const initialSessionId = session.id;
  input.value = '新对话保留未发送原文 \n'; input.fire('input');
  pauseReset();
  const beforeNewChat = calls.length;
  nodes.get('new-chat').focus();
  nodes.get('new-chat').fire('click'); await tick();
  assert.equal(nodes.get('app-status').textContent, '正在新建对话…', 'a pending reset shows the current operation');
  assert.equal(input.disabled, true); assert.equal(session.id, initialSessionId);
  assert.equal(document.activeElement.tagName, 'BODY', 'disabling the focused initiating control drops focus to body');
  nodes.get('new-chat').fire('click'); await tick();
  assert.equal(calls.length, beforeNewChat + 1, 'repeated new-chat clicks cannot duplicate a pending reset');
  assert.equal(input.value, '新对话保留未发送原文 \n');
  resumeReset(); await tick();
  assert.equal(document.activeElement.id, 'new-chat', 'reset completion restores the initiating control after it is enabled');
  assert.notEqual(session.id, initialSessionId, 'new chat replaces history and session');
  assert.equal(input.value, '新对话保留未发送原文 \n', 'same-customer new chat preserves the exact unsent draft');
  assert.equal(confirmations(), 0, 'same-customer new chat needs no identity confirmation');
  for (const status of [400, 409]) {
    resetError = status; pauseReset();
    const currentSessionId = session.id;
    nodes.get('new-chat').focus(); nodes.get('new-chat').fire('click'); await tick();
    assert.equal(document.activeElement.tagName, 'BODY');
    resumeReset(); await tick();
    assert.equal(document.activeElement.id, 'new-chat', 'failed new-chat requests restore their initiating button');
    assert.equal(session.id, currentSessionId); assert.equal(input.value, '新对话保留未发送原文 \n');
    assert.equal(nodes.get('new-chat').focusOptions.preventScroll, true);
  }
  resetError = 0;
  const capacityMessage='会话记录数量已达上限，已有记录仍可查看。';
  for(const [serverError,expected] of [[capacityMessage,capacityMessage],['请求过于频繁，请稍后再试','请求过于频繁，请稍后再试'],['内部错误 <script>secret</script>','请求过于频繁，请稍后再试']]){
    resetError=429;resetErrorMessage=serverError;
    const beforeCapacity=runInContext('({session:state.session,messages:state.messages,failedAttempt:state.failedAttempt,profileId:state.profileId})',context);
    const capacityCalls=calls.filter(call=>call.body).length,rawDraft=input.value;
    nodes.get('new-chat').focus();nodes.get('new-chat').fire('click');await tick();
    assert.equal(nodes.get('app-status').textContent,expected,'controlled history capacity is distinct from ordinary rate limiting and unknown server text');
    assert.equal(input.value,rawDraft);assert.equal(calls.filter(call=>call.body).length,capacityCalls+1,'capacity failure cannot automatically retry or send');
    for(const key of Object.keys(beforeCapacity))assert.ok(runInContext('state.'+key,context)===beforeCapacity[key],`capacity failure preserves ${key}`);
    assert.equal(runInContext('state.expired',context),false);assert.ok(document.activeElement===nodes.get('new-chat'));
  }
  resetError=0;resetErrorMessage='当前消息仍在处理中';
  const capacityFetch=context.fetch;
  for(const [path,status,expected] of [['/api/chat/session/open',429,'请求过于频繁，请稍后再试'],['/api/chat/session',500,'请求失败，请稍后重试']]){
    context.fetch=async()=>response({error:capacityMessage},status);context.capacityPath=path;
    assert.equal(await runInContext('api(capacityPath,{}).catch(error=>error.message)',context),expected,'capacity wording is restricted to its status and creation endpoint');
  }
  context.fetch=capacityFetch;
  const posts = () => calls.filter(call => call.path === '/api/chat/messages/stream');
  const send = async text => { input.value = text; input.fire('input'); form.fire('submit'); await tick(); };
  input.value='';input.fire('input');
  nodes.get('starter-list').querySelector('.starter-button').fire('click'); await tick();
  assert.equal(input.value, '我有哪些订单'); assert.equal(posts().length, 0, 'examples only fill the composer');
  await send(' '.repeat(2)); await send('字'.repeat(2001)); assert.equal(posts().length, 0, 'invalid drafts do not send');
  const draft = '查询到账 银行卡 ';
  await send(draft); assert.equal(posts().length, 1); assert.equal(select.disabled, true);
  let preventedNavigation = false;
  nodes.get('eval-link').fire('click', { preventDefault: () => { preventedNavigation = true; } });
  assert.equal(preventedNavigation, true, 'in-flight chat does not lose its active page through the evaluation link');
  assert.equal(nodes.get('eval-leave-dialog').showModalCalls??0,0,'locked chat cannot offer a misleading leave confirmation');
  assert.equal(nodes.get('eval-link').getAttribute('aria-disabled'), 'true');
  assert.equal(nodes.get('model-select').disabled, true, 'settings cannot change during a turn');
  assert.equal(nodes.get('apply-settings').disabled, true);
  form.fire('submit'); input.fire('keydown', { key: 'Enter', isComposing: true }); await tick(); assert.equal(posts().length, 1);
  const first = pending.shift(), originalId = first.body.requestId;
  assert.equal(first.body.text, draft, 'original text must not be trimmed or normalized');
  first.reject(new TypeError('synthetic network interruption')); await tick(); assert.equal(input.value, draft);
  assert.equal(nodes.get('init-retry').hidden,false,'every current failed turn exposes an explicit read-only recovery');
  assert.equal(nodes.get('init-retry').textContent,'查看当前记录');
  const leaveDialog=nodes.get('eval-leave-dialog'),leaveCancel=nodes.get('eval-leave-cancel'),evaluationLink=nodes.get('eval-link');
  const clickEvaluation=()=>{let prevented=false;evaluationLink.fire('click',{preventDefault:()=>{prevented=true;}});return prevented;};
  const leaveState=runInContext('({session:state.session,messages:state.messages,failedAttempt:state.failedAttempt,generation:state.generation,profileId:state.profileId})',context);
  const leaveCalls=calls.length,leaveDrafts=runInContext('JSON.stringify([...conversationDrafts])',context);
  nodes.get('settings-dialog').close();
  assert.equal(clickEvaluation(),true,'unsent raw text cannot leave through the evaluation link without an explicit decision');
  assert.equal(nodes.get('settings-dialog').open,false);assert.ok(leaveDialog.open&&document.activeElement===leaveCancel);
  assert.equal(leaveCancel.focusOptions.preventScroll,true);leaveDialog.fire('cancel');await tick();
  assert.ok(!leaveDialog.open&&document.activeElement===input);assert.equal(input.value,draft);
  for(const key of Object.keys(leaveState))assert.ok(runInContext('state.'+key,context)===leaveState[key],`cancel evaluation navigation preserves ${key}`);
  assert.equal(runInContext('JSON.stringify([...conversationDrafts])',context),leaveDrafts);assert.equal(calls.length,leaveCalls);
  assert.deepEqual(evaluationNavigations,[],'cancelling navigation cannot replay or replace the failed request');
  const leaveHTML=html.match(/<dialog\b[^>]*id="eval-leave-dialog"[^>]*>[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(leaveHTML);assert.match(leaveHTML,/aria-labelledby="eval-leave-title"[^>]*aria-describedby="eval-leave-description"/);
  assert.match(leaveHTML,/<form\b[^>]*method="dialog"/);
  assert.match(leaveHTML,/<button\b[^>]*id="eval-leave-cancel"[^>]*value="cancel"[^>]*autofocus[^>]*>继续编辑<\/button>/);
  assert.match(leaveHTML,/<button\b[^>]*value="leave"[^>]*>离开并丢弃草稿<\/button>/);
  assert.ok(leaveHTML.includes('本页各个会话的草稿')&&leaveHTML.includes('已有会话记录会保留'));
  for(const raw of ['先问预约规则\n再问到账时间  ',' \n  ']){
    input.value=raw;input.fire('input');const rawDrafts=runInContext('JSON.stringify([...conversationDrafts])',context),beforeLeaveCalls=calls.length;
    assert.equal(clickEvaluation(),true);const promptCount=leaveDialog.showModalCalls;
    assert.equal(clickEvaluation(),true);assert.equal(leaveDialog.showModalCalls,promptCount,'repeated link activation keeps one decision');
    leaveDialog.close('cancel');await tick();assert.equal(input.value,raw);assert.ok(document.activeElement===input);
    assert.equal(runInContext('JSON.stringify([...conversationDrafts])',context),rawDrafts);assert.equal(calls.length,beforeLeaveCalls);
  }
  input.value=draft;input.fire('input');
  const confirmCalls=calls.length,confirmDrafts=runInContext('JSON.stringify([...conversationDrafts])',context),safeHref=evaluationLink.href;
  assert.equal(clickEvaluation(),true);leaveDialog.close('leave');leaveDialog.fire('close');await tick();
  assert.deepEqual(evaluationNavigations,[safeHref],'only an explicit current decision navigates exactly once');
  assert.equal(calls.length,confirmCalls);assert.equal(input.value,draft);assert.equal(runInContext('JSON.stringify([...conversationDrafts])',context),confirmDrafts,'confirmation does not clear drafts before actual navigation');
  assert.ok(runInContext('state.failedAttempt',context)===leaveState.failedAttempt);assert.equal(runInContext('state.failedAttempt.requestId',context),originalId);
  assert.equal(clickEvaluation(),true);assert.equal(leaveDialog.returnValue,'cancel','a reopened prompt cannot reuse the previous leave choice');
  leaveDialog.fire('cancel');await tick();assert.equal(evaluationNavigations.length,1);
  const focusGuardCalls=calls.length,focusGuardDrafts=runInContext('JSON.stringify([...conversationDrafts])',context);
  for(const decision of ['cancel','stale-leave'])for(const guard of ['moved','selection','disconnected','hidden','disabled']){
    assert.equal(clickEvaluation(),true);const gen=runInContext('state.generation',context);
    if(decision==='stale-leave')runInContext('state.generation++',context);
    // Native close is queued after the modal is removed; the browser/user may already have restored focus.
    leaveDialog.open=false;leaveDialog.returnValue=decision==='cancel'?'cancel':'leave';document.activeElement=document.body;
    if(guard==='moved')nodes.get('new-chat').focus();
    if(guard==='selection')context.window.getSelection=()=>({isCollapsed:false,anchorNode:input});
    if(guard==='disconnected')input.remove();
    if(guard==='hidden')input.hidden=true;
    if(guard==='disabled')input.disabled=true;
    const protectedFocus=document.activeElement,guardInputFocus=input.focusCalls,guardSettingsFocus=nodes.get('settings-open').focusCalls,guardEvaluationFocus=evaluationLink.focusCalls??0;
    leaveDialog.fire('close');await tick();
    assert.ok(document.activeElement===(guard==='disabled'?evaluationLink:protectedFocus),`${decision}/${guard} close preserves the user focus or hands an unavailable composer back to navigation`);
    assert.equal(input.focusCalls,guardInputFocus);assert.equal(nodes.get('settings-open').focusCalls,guardSettingsFocus);
    assert.equal(evaluationLink.focusCalls??0,guardEvaluationFocus+(guard==='disabled'?1:0));
    assert.equal(evaluationNavigations.length,1,'a guarded cancelled or stale close cannot navigate');
    delete context.window.getSelection;input.isConnected=true;input.hidden=false;input.disabled=false;
    context.leaveGuardGeneration=gen;runInContext('state.generation=leaveGuardGeneration',context);delete context.leaveGuardGeneration;
  }
  assert.equal(clickEvaluation(),true);leaveDialog.open=false;leaveDialog.returnValue='cancel';nodes.get('settings-open').focus();
  leaveDialog.fire('close');await tick();assert.ok(document.activeElement===input,'UA restoration to settings-open still hands a current draft back to its composer');
  assert.equal(input.focusOptions.preventScroll,true);assert.equal(input.value,draft);assert.equal(calls.length,focusGuardCalls);
  assert.equal(runInContext('JSON.stringify([...conversationDrafts])',context),focusGuardDrafts);
  assert.ok(runInContext('state.failedAttempt',context)===leaveState.failedAttempt);assert.equal(runInContext('state.failedAttempt.requestId',context),originalId);
  for(const stale of ['generation','session','href','busy','initialized']){
    assert.equal(clickEvaluation(),true);const before=runInContext('({generation:state.generation,session:state.session,initialized:state.initialized})',context),href=evaluationLink.href;
    if(stale==='generation')runInContext('state.generation++',context);
    if(stale==='session')runInContext('state.session={...state.session,id:crypto.randomUUID()}',context);
    if(stale==='href')evaluationLink.href=href+'?changed';
    if(stale==='busy')runInContext('setBusy(true)',context);
    if(stale==='initialized')runInContext('state.initialized=false;setBusy(false)',context);
    const staleCalls=calls.length;leaveDialog.close('leave');await tick();assert.equal(evaluationNavigations.length,1,`${stale} rejects a stale leave decision`);assert.equal(calls.length,staleCalls);
    if(stale==='busy'){
      const prompts=leaveDialog.showModalCalls;assert.equal(clickEvaluation(),true);assert.equal(leaveDialog.showModalCalls,prompts,'locked navigation cannot open a new prompt');
    }
    if(stale==='initialized'){
      const prompts=leaveDialog.showModalCalls;
      assert.equal(clickEvaluation(),true);assert.equal(leaveDialog.showModalCalls,prompts+1,'an idle failed connection permits a new current draft decision');
      leaveDialog.fire('cancel');await tick();assert.ok(document.activeElement===evaluationLink,'a disabled composer returns cancellation focus to permanent navigation');
      assert.equal(evaluationNavigations.length,1);assert.equal(input.value,draft);assert.equal(calls.length,staleCalls);
      assert.equal(clickEvaluation(),true);leaveDialog.close('leave');await tick();
      assert.deepEqual(evaluationNavigations,[safeHref,safeHref],'an explicit decision whose initialized=false snapshot remains current can navigate once');
      assert.equal(calls.length,staleCalls);assert.equal(input.value,draft);assert.ok(runInContext('state.failedAttempt',context)===leaveState.failedAttempt);
    }
    context.restoreLeaveState=before;runInContext('state.generation=restoreLeaveState.generation;state.session=restoreLeaveState.session;state.initialized=restoreLeaveState.initialized;setBusy(false)',context);delete context.restoreLeaveState;evaluationLink.href=href;
  }
  const confirmedLeaveCount=evaluationNavigations.length;
  assert.equal(input.value,draft);assert.equal(runInContext('JSON.stringify([...conversationDrafts])',context),confirmDrafts);
  const beforeEditedRead=calls.length,failedBeforeEdit=runInContext('state.failedAttempt',context);
  input.value=draft+'修改';input.fire('input');assert.equal(nodes.get('init-retry').hidden,true,'the read action belongs to the exact current failed draft');
  assert.ok(runInContext('state.failedAttempt',context)===failedBeforeEdit);assert.equal(calls.length,beforeEditedRead);
  input.value=draft;input.fire('input');assert.equal(nodes.get('init-retry').hidden,false);
  await send(draft); assert.equal(posts().at(-1).body.requestId, originalId, 'same draft retries the same request instead of another model turn');
  const retry = pending.shift();
  const focusBeforeRetry = input.focusCalls ?? 0;
  retry.resolve(response({ sessionId: session.id, requestId: originalId, reply: { kind: 'notice', text: '<img src=x onerror=alert(1)> 不能核实', evidenceIds: ['<script>'] }, durationMs: 1, origin: 'host' }));
  await tick();
  assert.equal(input.focusCalls, focusBeforeRetry + 1, 'ordinary completion restores composer focus');
  preventedNavigation = false;
  nodes.get('eval-link').fire('click', { preventDefault: () => { preventedNavigation = true; } });
  assert.equal(preventedNavigation, false, 'completed chat can navigate to evaluation');
  assert.equal(nodes.get('eval-link').getAttribute('aria-disabled'), 'false');
  assert.ok(nodes.get('chat-messages').textContent.includes('<img src=x onerror=alert(1)>'));
  assert.ok(walk(nodes.get('chat-messages')).some(node => node.className.split(' ').includes('notice')), 'business notice is visibly distinct');
  await send('本人订单'); const order = pending.shift();
  order.resolve(response({ sessionId: session.id, requestId: order.body.requestId, reply: { kind: 'order', text: '合成工具订单', orders: [
    { id: 'COUPON-1001', status: 'paid', paidCents: 12345, refundedCents: 0, couponStatuses: ['unused'] },
    { id: '<img src=x>', status: 'unknown', paidCents: -1, refundedCents: 'bad', couponStatuses: [] }
  ] }, durationMs: 1, origin: 'agent' }));
  await tick();
  const cards = () => walk(nodes.get('chat-messages')).filter(node => node.className.split(' ').includes('order-card'));
  assert.equal(cards().length, 2); assert.ok(cards()[0].textContent.includes('123.45'));
  assert.ok(cards()[1].textContent.includes('未知')); assert.ok(cards()[1].textContent.includes('<img src=x>'));
  await send('普通回复'); const plain = pending.shift();
  plain.resolve(response({ sessionId: session.id, requestId: plain.body.requestId,
    reply: { kind: 'answer', text: '{"kind":"order","paidCents":99999}' }, durationMs: 1, origin: 'agent' }));
  await tick(); assert.equal(cards().length, 2, 'model prose cannot forge another order card');
  const old = nodes.get('chat-messages').textContent;
  const identityDraft = '客户 A 的未发送问题 \n';
  input.value = identityDraft; input.fire('input');
  const previousSessionId = session.id, beforeCancelledSwitch = calls.length;
  select.value = 'demo-b'; select.fire('change'); await tick();
  assert.equal(profileDialog.open, true); assert.equal(select.value, 'demo-a', 'the chooser keeps the active identity while confirmation is open');
  assert.equal(nodes.get('profile-switch-cancel').focusCalls, 1, 'the non-destructive action receives initial focus');
  assert.match(nodes.get('profile-switch-description').textContent, /客户 demo-b.*未发送.*清空.*已有会话记录.*保留/);
  assert.equal(calls.length, beforeCancelledSwitch, 'opening confirmation sends no HTTP request');
  profileDialog.close('cancel'); await tick();
  assert.equal(calls.length, beforeCancelledSwitch, 'cancelled customer switch makes no HTTP request');
  assert.equal(session.id, previousSessionId); assert.equal(select.value, 'demo-a');
  assert.equal(input.value, identityDraft); assert.equal(nodes.get('chat-messages').textContent, old);
  assert.equal(confirmations(), 1, 'a nonempty draft requires confirmation before crossing customers');
  assert.equal(select.focusOptions.preventScroll, true, 'cancellation restores the chooser without scrolling the page');
  for (const [invalidate, restore] of [
    ['state.busy = true', 'state.busy = false'],
    ['state.initialized = false', 'state.initialized = true'],
    ['state.profileId = "demo-b"', 'state.profileId = "demo-a"']
  ]) {
    select.value = 'demo-b'; select.fire('change'); await tick();
    assert.equal(profileDialog.open, true);
    const beforeStaleDecision = calls.length;
    runInContext(invalidate, context); profileDialog.close('switch'); await tick();
    assert.equal(calls.length, beforeStaleDecision, 'a stale or busy dialog decision cannot reset the session');
    assert.equal(input.value, identityDraft);
    runInContext(restore, context);
  }
  select.value = 'demo-b'; select.fire('change'); await tick();
  assert.equal(profileDialog.open, true);
  const beforeExpiredConfirmation = calls.length, liveSessionBeforeExpiry = session;
  const expiredConfirmationState = runInContext('({generation:state.generation,session:state.session,profileId:state.profileId,messages:state.messages,failedAttempt:state.failedAttempt})', context);
  session = null;
  runInContext('state.expired=true; setBusy(false)', context);
  profileDialog.close('switch'); await tick();
  assert.equal(calls.length, beforeExpiredConfirmation, 'confirmation opened before expiry cannot submit an invalid session UUID');
  for (const key of Object.keys(expiredConfirmationState)) assert.ok(runInContext(`state.${key}`, context) === expiredConfirmationState[key], `expired confirmation preserves ${key}`);
  assert.equal(input.value, identityDraft); assert.equal(select.value, 'demo-a');
  assert.equal(runInContext('state.pendingProfileChange', context), null);
  session = liveSessionBeforeExpiry;
  runInContext('state.expired=false; setBusy(false)', context);
  resetError = 400; select.value = 'demo-b'; select.fire('change'); await tick();
  pauseReset(); const beforeFailedSwitch = calls.length;
  profileDialog.close('switch'); await tick();
  assert.equal(nodes.get('app-status').textContent, '正在切换客户…');
  assert.equal(input.disabled, true); assert.equal(session.id, previousSessionId);
  profileDialog.fire('close'); nodes.get('new-chat').fire('click'); await tick();
  assert.equal(calls.length, beforeFailedSwitch + 1, 'busy dialog and reset actions cannot duplicate the pending customer switch');
  resumeReset(); await tick();
  assert.equal(session.id, previousSessionId); assert.equal(select.value, 'demo-a');
  assert.equal(document.activeElement.id, 'profile-select', 'a rejected customer switch restores its chooser focus');
  assert.equal(input.value, identityDraft, 'confirmed but rejected customer switch preserves the old draft');
  assert.equal(input.disabled, false); assert.equal(nodes.get('app-status').classList.contains('error'), true);
  resetError = 409; select.value = 'demo-b'; select.fire('change'); await tick();
  pauseReset();
  profileDialog.close('switch'); await tick();
  assert.equal(nodes.get('app-status').textContent, '正在切换客户…');
  assert.equal(nodes.get('app-status').classList.contains('error'), false, 'the active operation clears the previous failure styling');
  resumeReset(); await tick();
  assert.equal(select.value, 'demo-a'); assert.equal(nodes.get('chat-messages').textContent, old, 'failed identity change must preserve prior conversation');
  assert.equal(document.activeElement.id, 'profile-select', 'a busy customer-switch rejection also restores its chooser');
  assert.equal(input.value, identityDraft, 'busy rejection also retains the exact identity-bound draft');
  assert.equal(input.disabled, false); assert.equal(nodes.get('app-status').classList.contains('error'), true);
  resetError = 0; select.value = 'demo-b'; select.fire('change'); await tick();
  pauseReset();
  const beforeConfirmedSwitch = calls.length;
  profileDialog.close('switch'); profileDialog.fire('close'); await tick();
  assert.equal(nodes.get('app-status').textContent, '正在切换客户…');
  assert.equal(session.id, previousSessionId); assert.equal(select.value, 'demo-a'); assert.equal(input.value, identityDraft);
  assert.equal(calls.length, beforeConfirmedSwitch + 1, 'repeated confirmation executes a single reset POST');
  resumeReset(); await tick();
  assert.equal(document.activeElement.id, 'profile-select', 'successful customer switching restores the active chooser');
  assert.equal(select.value, 'demo-b'); assert.ok(!nodes.get('chat-messages').textContent.includes('不能核实'));
  assert.equal(input.value, '', 'confirmed customer switch clears the prior identity draft');
  input.value = '客户 B 的未发送问题'; input.fire('input');
  const beforeEscape = calls.length;
  select.value = 'demo-a'; select.fire('change'); await tick();
  assert.equal(profileDialog.returnValue, 'cancel', 'reopening after confirmation resets the previous switch decision');
  profileDialog.fire('cancel'); profileDialog.close(); await tick();
  assert.equal(calls.length, beforeEscape, 'Escape after a previous confirmation cannot send a reset POST');
  assert.equal(select.value, 'demo-b'); assert.equal(input.value, '客户 B 的未发送问题');
  input.value = '查询到账 电子钱包'; input.fire('input'); const before = posts().length;
  input.fire('keydown', { key: 'Enter', isComposing: true }); input.fire('keydown', { key: 'Enter', shiftKey: true }); await tick();
  assert.equal(posts().length, before, 'IME and multiline Enter must not send');
  await send('查询到账 电子钱包'); const stale = pending.shift();
  stale.resolve(response({ sessionId: 'old-session', requestId: stale.body.requestId, reply: { kind: 'answer', text: '旧客户数据' }, durationMs: 1, origin: 'host' }));
  await tick(); assert.ok(!nodes.get('chat-messages').textContent.includes('旧客户数据'), 'mismatched session receipt is not displayed');
  const expiredDraft = '服务故障样例 \n';
  await send(expiredDraft); const unavailable = pending.shift();
  session = null; // The actual server invalidates the failed conversation before returning 503.
  unavailable.resolve(response({ error: '本轮未能完成，会话已清空。' }, 503)); await tick();
  assert.equal(input.value, expiredDraft); const attempts = posts().length;
  form.fire('submit'); await tick(); assert.equal(posts().length, attempts, '503-invalidated context requires a new conversation');
  for (const id of ['model-select', 'thinking-select', 'tokens-select', 'apply-settings']) {
    assert.equal(nodes.get(id).disabled, true, `${id} must wait for reconnection after a 503-invalidated context`);
  }
  assert.equal(nodes.get('settings-status').textContent, '会话已失效，请先重新连接');
  const expiredSettingsState = runInContext('({generation:state.generation,session:state.session,failedAttempt:state.failedAttempt,messages:state.messages})', context);
  const beforeExpiredSettings = calls.length;
  nodes.get('settings-form').fire('submit'); await tick();
  assert.equal(calls.length, beforeExpiredSettings, 'an expired settings submission cannot send the invalid session UUID or create a null session');
  for (const key of Object.keys(expiredSettingsState)) assert.ok(runInContext(`state.${key}`, context) === expiredSettingsState[key], `blocked settings preserve ${key}`);
  assert.equal(input.value, expiredDraft, 'blocked settings retain the exact failed draft');
  const expiredProfileState = runInContext('({generation:state.generation,session:state.session,profileId:state.profileId,messages:state.messages,failedAttempt:state.failedAttempt})', context);
  for (const draft of [expiredDraft, '恢复前的另一个问题', ' \n', '']) {
    input.value = draft; input.fire('input');
    assert.equal(select.disabled, true, 'customer selection waits for explicit reconnection');
    const beforeExpiredSwitch = calls.length, beforeExpiredPrompt = confirmations();
    select.value = 'demo-a'; select.fire('change'); await tick();
    assert.equal(calls.length, beforeExpiredSwitch, 'expired customer changes cannot send a reset or recovery request');
    assert.equal(confirmations(), beforeExpiredPrompt, 'expired drafts cannot open a misleading discard confirmation');
    assert.equal(select.value, 'demo-b'); assert.equal(input.value, draft);
    for (const key of Object.keys(expiredProfileState)) assert.ok(runInContext(`state.${key}`, context) === expiredProfileState[key], `blocked customer change preserves ${key}`);
  }
  input.value = expiredDraft; input.fire('input'); select.value = 'demo-a';
  const beforeExpiredReset = calls.length;
  runInContext('resetConversation("demo-a", false)', context); await tick();
  assert.equal(calls.length, beforeExpiredReset, 'the shared reset guard also rejects direct expired calls');
  assert.equal(select.value, 'demo-b'); assert.equal(input.value, expiredDraft);
  for (const key of Object.keys(expiredProfileState)) assert.ok(runInContext(`state.${key}`, context) === expiredProfileState[key], `blocked direct reset preserves ${key}`);
  const invalidId = unavailable.body.requestId;
  assert.equal(nodes.get('new-chat').disabled,true,'expired new-chat waits for explicit reconnection');assert.equal(nodes.get('init-retry').hidden,false);assert.equal(nodes.get('init-retry').textContent,'重新连接');
  const beforeBlockedNew=calls.length;nodes.get('new-chat').fire('click');await tick();assert.equal(calls.length,beforeBlockedNew,'expired new-chat cannot recover or reset a session');
  const headerRecoveryStart = calls.length;
  configWait = new Promise(resolve => { releaseConfig = resolve; });
  nodes.get('init-retry').focus();
  nodes.get('init-retry').fire('click');
  assert.equal(calls[headerRecoveryStart]?.path, '/api/chat/config', 'expired header action must reread config before replacing any session');
  nodes.get('init-retry').fire('click'); await tick();
  assert.equal(calls.length, headerRecoveryStart + 1, 'a busy header recovery cannot duplicate initialization');
  assert.equal(input.value, expiredDraft); assert.equal(input.disabled, true);
  const finishConfig = releaseConfig; configWait = null; releaseConfig = null; finishConfig(); await tick();
  assert.deepEqual(calls.slice(headerRecoveryStart).filter(call => !call.path.startsWith('/api/chat/sessions?')).map(call => [call.path, call.body?.sessionId]),
    [['/api/chat/config', undefined], ['/api/chat/session', undefined], ['/api/chat/session/open', null]], 'a reread null binding reopens known accepted history with an explicit null UUID');
  assert.equal(select.value, 'demo-b'); assert.equal(input.value, expiredDraft); assert.equal(input.disabled, false);
  assert.equal(select.disabled, false, 'successful reconnection restores healthy customer switching');
  for (const id of ['model-select', 'thinking-select', 'tokens-select', 'apply-settings']) assert.equal(nodes.get(id).disabled, false, `${id} unlocks after header reconnection`);
  assert.ok(document.activeElement === input, 'successful reconnection hands focus from its hidden retry source to the composer');
  assert.equal(input.focusOptions.preventScroll, true);
  form.fire('submit'); await tick(); const recovered = pending.shift();
  assert.notEqual(recovered.body.requestId, invalidId, 'recreated context starts a new request');
  recovered.resolve(response({ sessionId: session.id, requestId: recovered.body.requestId,
    reply: { kind: 'answer', text: '合成恢复结果' }, durationMs: 1, origin: 'host' })); await tick();
  assert.equal(input.value, '');
  const recoveredProfileSession = session.id, recoveredProfileDraft = '恢复后的客户 B 草稿 \n';
  input.value = recoveredProfileDraft; input.fire('input');
  const beforeRecoveredSwitch = calls.length;
  select.value = 'demo-a'; select.fire('change'); await tick();
  assert.equal(profileDialog.open, true); assert.equal(calls.length, beforeRecoveredSwitch);
  profileDialog.close('cancel'); await tick();
  assert.equal(session.id, recoveredProfileSession); assert.equal(input.value, recoveredProfileDraft);
  select.value = 'demo-a'; select.fire('change'); await tick(); profileDialog.close('switch'); await tick();
  assert.equal(session.profileId, 'demo-a'); assert.equal(input.value, '', 'healthy switching after reconnection still clears the prior customer draft after confirmation');
  assert.equal(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.sessionId, recoveredProfileSession, 'healthy switching uses the recovered UUID');
  select.value = 'demo-b'; select.fire('change'); await tick();
  assert.equal(session.profileId, 'demo-b', 'empty-draft healthy switching remains available after recovery');

  await fetch('/api/chat/session',{method:'POST',headers:{'Content-Type':'application/json','X-Chat-Request':'1'},body:JSON.stringify({profileId:'demo-a',sessionId:session.id})});
  const external = session;input.value = '旧客户 B 草稿\n  '; input.fire('input');
  const creationsBefore = calls.filter(call => call.path === '/api/chat/session' && call.body).length;
  nodes.get('new-chat').fire('click'); await tick();
  assert.equal(session.id, external.id, 'stale reset never deletes the external replacement');
  assert.equal(input.value, '旧客户 B 草稿\n  ', 'rejected reset retains the old draft');
  const externalRecoveryStart = calls.length;
  nodes.get('init-retry').fire('click'); await tick();
  assert.deepEqual(calls.slice(externalRecoveryStart).filter(call => !call.path.startsWith('/api/chat/sessions?')).map(call => [call.path, call.body?.sessionId]),
    [['/api/chat/config', undefined], ['/api/chat/session', undefined], ['/api/chat/session', external.id]], 'reconnection uses the fresh external UUID only as the original-customer creation precondition');
  assert.notEqual(session.id, external.id); assert.equal(select.value, 'demo-b'); assert.equal(input.value, '旧客户 B 草稿\n  ', 'an unsolicited customer change cannot clear or replace the current customer draft');
  assert.equal(calls.filter(call => call.path === '/api/chat/session' && call.body).length, creationsBefore + 2);
  assert.equal(calls.filter(call=>call.path.startsWith('/api/chat/sessions?')).at(-2).path,'/api/chat/sessions?profileId=demo-b','empty recovery checks the original customer accepted history');
  input.value='';input.fire('input');select.value='demo-a';select.fire('change');await tick();

  const modelSelect = nodes.get('model-select'), thinkingSelect = nodes.get('thinking-select'), tokensSelect = nodes.get('tokens-select');
  const settingsForm = nodes.get('settings-form'), active = nodes.get('active-settings');
  nodes.get('settings-open').fire('click');
  assert.ok(modelSelect.children.find(node => node.value === 'qwen3.7-plus-2026-05-26')?.disabled, 'unconfigured choices are disabled');
  assert.equal(nodes.get('eval-link').getAttribute('href') ?? nodes.get('eval-link').href, config.evaluationUrl);
  assert.ok(active.textContent.includes('deepseek-flash'), 'resolved server model is visible');
  const activeBefore = active.textContent, beforeSession = session.id, historyBefore = nodes.get('chat-messages').textContent;
  input.value = '保留的草稿'; input.fire('input');
  modelSelect.value = 'deepseek-v4-pro'; modelSelect.fire('change');
  thinkingSelect.value = 'high'; thinkingSelect.fire('change'); tokensSelect.value = '512'; tokensSelect.fire('change');
  assert.equal(active.textContent, activeBefore, 'unsaved editor must not replace active settings');
  resetError = 400; pauseReset();
  nodes.get('apply-settings').focus(); settingsForm.fire('submit'); await tick();
  assert.equal(document.activeElement.tagName, 'BODY'); resumeReset(); await tick();
  assert.equal(document.activeElement.id, 'apply-settings', 'invalid settings replies restore the initiating control');
  assert.equal(session.id, beforeSession); assert.equal(active.textContent, activeBefore);
  assert.equal(nodes.get('chat-messages').textContent, historyBefore); assert.equal(input.value, '保留的草稿');
  assert.equal(modelSelect.value, 'deepseek-v4-pro'); assert.equal(tokensSelect.value, '512', 'failed settings retain editor draft');
  resetError = 409; pauseReset();
  nodes.get('apply-settings').focus(); settingsForm.fire('submit'); await tick();
  assert.equal(document.activeElement.tagName, 'BODY'); resumeReset(); await tick();
  assert.equal(document.activeElement.id, 'apply-settings', 'busy settings replies restore the initiating control');
  assert.equal(session.id, beforeSession); assert.equal(input.value, '保留的草稿');
  resetError = 0; pauseReset();
  const beforeApplyingSettings = calls.length;
  nodes.get('apply-settings').focus();
  settingsForm.fire('submit'); await tick();
  assert.equal(nodes.get('app-status').textContent, '正在应用设置…');
  assert.equal(nodes.get('settings-status').textContent, '应用中…');
  assert.equal(input.disabled, true); assert.equal(session.id, beforeSession);
  settingsForm.fire('submit'); await tick();
  assert.equal(calls.length, beforeApplyingSettings + 1, 'pending settings application cannot duplicate its reset POST');
  resumeReset(); await tick();
  assert.equal(document.activeElement.id, 'apply-settings', 'successful settings application restores the initiating control');
  assert.equal(nodes.get('apply-settings').focusOptions.preventScroll, true);
  assert.notEqual(session.id, beforeSession); assert.equal(input.value, '保留的草稿', 'same-customer settings apply preserves the unsent question');
  const applied = { modelSelection: 'deepseek-v4-pro', thinkingLevel: 'high', maxTokens: 512 };
  assert.deepEqual(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, applied);
  assert.ok(active.textContent.includes('deepseek-v4-pro')); assert.ok(active.textContent.includes('512'));
  assert.ok(!nodes.get('chat-messages').textContent.includes('合成恢复结果'), 'successful settings start a clean context');
  serverMessages = [{ id: randomUUID(), role: 'assistant', text: '用于查看的已完成答复',
    reply: { kind: 'answer', text: '用于查看的已完成答复', evidenceIds: ['FAQ-FOCUS'] } }];
  runInContext('initialize()', context); await tick();
  const savedHistorySummary = nodes.get('chat-messages').querySelector('.evidence').querySelector('summary');
  const settingsSummary = document.createElement('summary'); nodes.get('chat-settings').append(settingsSummary);
  const newChat = nodes.get('new-chat');
  for (const target of [savedHistorySummary, settingsSummary, null]) {
    resetError = 400; pauseReset(); newChat.focus(); newChat.fire('click'); await tick();
    const focusCalls = newChat.focusCalls;
    if (target) target.focus(); else context.window.getSelection = () => ({ isCollapsed: false });
    resumeReset(); await tick();
    assert.ok(document.activeElement === (target ?? document.body), 'reset completion respects a new summary focus or selected passage');
    assert.equal(newChat.focusCalls, focusCalls, 'changed focus or text selection prevents automatic focus restoration');
    delete context.window.getSelection;
  }
  resetError = 0;
  for (const blocked of ['hidden', 'removed', 'no-layout']) {
    pauseReset(); newChat.focus(); newChat.fire('click'); await tick();
    const focusCalls = newChat.focusCalls;
    if (blocked === 'hidden') newChat.hidden = true;
    if (blocked === 'removed') newChat.remove();
    if (blocked === 'no-layout') newChat.style.display = 'none';
    resumeReset(); await tick();
    assert.ok(document.activeElement === document.body, 'unavailable original controls cannot regain focus');
    assert.equal(newChat.focusCalls, focusCalls);
    newChat.hidden = false; newChat.isConnected = true; newChat.style.display = '';
  }
  pauseReset(); nodes.get('apply-settings').focus(); settingsForm.fire('submit'); await tick();
  const disabledSourceFocusCalls = nodes.get('apply-settings').focusCalls;
  runInContext('state.config.models.find(model => model.id === "deepseek-v4-pro").available = false', context);
  resumeReset(); await tick();
  assert.equal(nodes.get('apply-settings').disabled, true);
  assert.equal(nodes.get('apply-settings').focusCalls, disabledSourceFocusCalls, 'an original control that remains disabled cannot regain focus');
  assert.ok(document.activeElement === document.body);
  runInContext('state.config.models.find(model => model.id === "deepseek-v4-pro").available = true; updateSettingsControls()', context);
  pauseReset(); newChat.focus(); newChat.fire('click'); await tick(); delete document.activeElement;
  resumeReset(); await tick(); assert.equal(document.activeElement.id, 'new-chat', 'missing active focus follows the same safe restoration rule');
  pauseReset(); newChat.focus(); newChat.fire('click'); await tick();
  const oldGenerationFocusCalls = newChat.focusCalls;
  runInContext('state.generation++', context); resumeReset(); await tick();
  assert.ok(document.activeElement === document.body); assert.equal(input.disabled, true);
  assert.equal(newChat.focusCalls, oldGenerationFocusCalls, 'an older reset cannot unlock or focus the current view');
  runInContext('initialize()', context); await tick();
  modelSelect.value = 'deepseek-flash'; modelSelect.fire('change'); tokensSelect.value = '1024'; tokensSelect.fire('change');
  const sameProfileSessionId = session.id, beforeSameProfile = calls.length, beforeSameProfilePrompts = confirmations();
  select.value = 'demo-a'; select.fire('change'); await tick();
  assert.equal(session.id, sameProfileSessionId); assert.equal(calls.length, beforeSameProfile, 'same-customer change is a no-op');
  assert.equal(input.value, '保留的草稿'); assert.equal(confirmations(), beforeSameProfilePrompts);
  select.value = 'demo-b'; select.fire('change'); await tick();
  profileDialog.close('switch'); await tick();
  assert.equal(select.value, 'demo-b'); assert.equal(input.value, '');
  assert.deepEqual(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, applied, 'identity changes use active settings, not unsaved editor');
  runInContext('initialize()', context); await tick();
  assert.equal(modelSelect.value, 'deepseek-v4-pro'); assert.equal(thinkingSelect.value, 'high'); assert.equal(tokensSelect.value, '512', 'refresh restores server snapshot');
  nodes.get('new-chat').fire('click'); await tick();
  assert.deepEqual(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, applied, 'new conversations preserve applied parameters');
  assert.equal(input.disabled, false); assert.equal(nodes.get('chat-messages').textContent.includes('服务故障样例'), false);
  tokensSelect.value = '1024'; tokensSelect.fire('change');
  await send('配置恢复检查'); const settingsFailure = pending.shift();
  session = null; settingsFailure.resolve(response({ error: '本轮未能完成，会话已清空。' }, 503)); await tick();
  const failedSettingsAttempt = runInContext('state.failedAttempt', context);
  assert.equal(tokensSelect.value, '1024', 'invalidated settings remain visible until explicit reconnection');
  assert.equal(nodes.get('settings-status').textContent, '会话已失效，请先重新连接');
  const beforeExpiredSettingsRetry = calls.length;
  settingsForm.fire('submit'); await tick();
  assert.equal(calls.length, beforeExpiredSettingsRetry, 'expired settings cannot automatically reconnect or apply the unsaved editor');
  assert.ok(runInContext('state.failedAttempt', context) === failedSettingsAttempt);
  configFailure = true; nodes.get('init-retry').focus(); nodes.get('init-retry').fire('click'); await tick();
  assert.equal(nodes.get('app-status').textContent, '连接失败，请重试。');
  assert.ok(document.activeElement === nodes.get('init-retry'), 'failed initialization restores the visible retry button');
  assert.equal(input.value, '配置恢复检查'); assert.equal(nodes.get('new-chat').disabled, true);
  for (const id of ['model-select', 'thinking-select', 'tokens-select', 'apply-settings']) assert.equal(nodes.get(id).disabled, true, `${id} stays locked after failed reconnection`);
  assert.equal(nodes.get('settings-status').textContent, '会话已失效，请先重新连接');
  assert.ok(runInContext('state.failedAttempt', context) === failedSettingsAttempt, 'failed reconnect preserves the original request metadata');
  const retryHeaderStart = calls.length;
  nodes.get('init-retry').focus();
  nodes.get('init-retry').fire('click'); await tick();
  assert.equal(calls[retryHeaderStart]?.path, '/api/chat/config', 'header recovery must work after an initialization network failure');
  assert.deepEqual(calls.slice(retryHeaderStart).filter(call => !call.path.startsWith('/api/chat/sessions?')).map(call => [call.path, call.body?.sessionId]),
    [['/api/chat/config', undefined], ['/api/chat/session', undefined], ['/api/chat/session', null]]);
  assert.deepEqual(session.settings, applied, '503 reconnect preserves the actually applied settings');
  assert.equal(tokensSelect.value, '512', 'header recovery cannot apply an unsaved settings editor');
  for (const id of ['model-select', 'thinking-select', 'tokens-select', 'apply-settings']) assert.equal(nodes.get(id).disabled, false, `${id} unlocks with the actually applied settings`);
  assert.equal(input.value, '配置恢复检查', 'same-customer reconnect keeps the failed draft');
  assert.equal(runInContext('state.failedAttempt', context), null, 'new context cannot reuse a failed request from an invalid session');
  assert.ok(document.activeElement === input);
  models[0].available = false;
  session = { id: randomUUID(), conversationId:randomUUID(), turns:0, busy:false, modelAvailable:true, profileId: 'demo-a', label: profile('demo-a').label, settings: structuredClone(defaults), model: { provider: 'deepseek', id: 'deepseek-flash' } };
  runInContext('state.session=null;state.profileId=null;state.failedAttempt=null;state.pendingTurn=null;conversationDrafts.clear();initialize()', context); await tick(); // A fresh page also starts without the previous document's draft Map.
  assert.equal(input.disabled, false, 'missing default model key must preserve host-only chat');
  nodes.get('new-chat').fire('click'); await tick();
  assert.equal(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, undefined, 'unavailable default resets use the compatible default route');
  const beforeEmptyDraftSwitchPrompts = confirmations();
  assert.equal(runInContext('conversationDrafts.size',context),0,'this fixture represents genuinely no page-local drafts');
  select.value = 'demo-b'; select.fire('change'); await tick();
  assert.equal(select.value, 'demo-b'); assert.equal(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, undefined);
  assert.equal(confirmations(), beforeEmptyDraftSwitchPrompts, 'customer changes with no draft need no extra confirmation');
  models[0].available = true;
  context.window.location.origin = 'http://localhost:3002';
  config.evaluationUrl = 'http://127.0.0.1:3011/';
  runInContext('initialize()', context); await tick();
  assert.equal(nodes.get('eval-link').getAttribute('href') ?? nodes.get('eval-link').href, 'http://localhost:3011/', 'navigation retains the current loopback hostname and configured port');
  assert.notEqual(nodes.get('eval-link').target, '_blank', 'evaluation opens in the same tab');
  context.window.location.origin = 'http://evil.test:3002';
  runInContext('initialize()', context); await tick();
  assert.equal(nodes.get('eval-link').hidden, true, 'untrusted page host cannot enable local navigation');
  context.window.location.origin = 'http://127.0.0.1:3002';
  for (const invalid of ['http://127.0.0.1:80/', 'http://127.0.0.1:3001/?target=evil', 'http://127.0.0.1:3001/#secret', 'http://u:p@127.0.0.1:3001/', 'http://127.0.0.1:3001/other']) {
    config.evaluationUrl = invalid;
    runInContext('initialize()', context); await tick();
    assert.equal(nodes.get('eval-link').hidden, true, 'invalid catalog navigation stays inaccessible');
  }
  config.evaluationUrl = 'https://evil.test/';
  runInContext('initialize()', context); await tick();
  assert.ok(!(nodes.get('eval-link').getAttribute('href') ?? nodes.get('eval-link').href ?? '').includes('evil.test'), 'catalog must not create an external navigation');
  config.evaluationUrl = 'http://127.0.0.1:3001/';
  runInContext('initialize()', context); await tick();
  assert.equal(input.disabled, false);
  assert.ok(walk(nodes.get('chat-messages')).some(node => node.className.split(' ').includes('message-avatar')) || /message-avatar/.test(source),
    'user and assistant messages have local avatars');
  const scroller = nodes.get('chat-messages');
  serverMessages = [{ id: randomUUID(), role: 'assistant', text: '已完成的历史答复',
    reply: { kind: 'answer', text: '已完成的历史答复', evidenceIds: ['FAQ-HISTORY'] },
    steps: [{ id: 'history-step', label: '查阅服务规则', status: 'done' }] }];
  runInContext('initialize()', context); await tick();
  const historyRow = scroller.children[0], historyEvidence = historyRow.querySelector('.evidence');
  const historySteps = historyRow.querySelector('.processing-steps');
  historyEvidence.open = true; historySteps.open = true;
  scroller.scrollHeight = 1400; scroller.scrollTop = 240;
  await send('我有哪些订单');
  assert.equal(scroller.scrollTop, scroller.scrollHeight, 'a new submitted turn deliberately reveals the latest messages');
  assert.equal(scroller.children[0], historyRow, 'submitting a new turn keeps completed history DOM attached');
  const streamed = pending.shift(), transport = openStream();
  const correlation = { sessionId: session.id, requestId: streamed.body.requestId };
  streamed.resolve(transport.response); await tick();
  transport.write(frame('start', { ...correlation, replayed: false }, '\r\n'));
  transport.write(frame('step', { ...correlation, id: 'tool-1', label: '查询最近订单', status: 'running' }));
  transport.write(frame('delta', { ...correlation, messageId: 'assistant-1', text: '正在核对这些订单' })); await tick();
  assert.ok(nodes.get('chat-messages').textContent.includes('查询最近订单'), 'real public steps appear before result');
  assert.ok(nodes.get('chat-messages').textContent.includes('正在核对这些订单'), 'real deltas are visible before the terminal frame');
  assert.equal(input.disabled, true, 'the composer remains locked throughout streaming');
  assert.equal(scroller.children[0], historyRow, 'stream events update only provisional messages');
  assert.equal(scroller.querySelector('.evidence'), historyEvidence, 'history evidence nodes keep their identity during streaming');
  assert.equal(historyEvidence.open, true); assert.equal(historySteps.open, true);
  const pendingUserRow = scroller.children.at(-2), pendingAssistantRow = scroller.children.at(-1);
  const pendingSteps = pendingAssistantRow.querySelector('.processing-steps'), pendingSummary = pendingSteps.querySelector('summary');
  const pendingText = pendingAssistantRow.querySelector('.message-text');
  const firstDraftAnchor = pendingText.children[0], firstStepItem = pendingSteps.querySelector('li');
  assert.equal(firstDraftAnchor.nodeType, 3, 'live text uses native text nodes');
  const firstDraftText = firstDraftAnchor.textContent;
  pendingSteps.open = false; pendingSummary.focus();
  transport.write(frame('delta', { ...correlation, messageId: 'assistant-1', text: '，继续整理使用范围。' })); await tick();
  assert.ok(scroller.children.at(-1) === pendingAssistantRow, 'same-turn stream updates keep the provisional assistant row');
  assert.ok(walk(scroller).includes(pendingSummary), 'stream updates cannot disconnect the focused pending summary');
  assert.equal(pendingSteps.open, false, 'a user-collapsed processing trace stays collapsed after new deltas');
  assert.ok(document.activeElement === pendingSummary);
  assert.ok(pendingText.children[0] === firstDraftAnchor && walk(scroller).includes(firstDraftAnchor));
  assert.equal(firstDraftAnchor.textContent, firstDraftText, 'new text appends a fragment without rewriting the selected earlier fragment');
  assert.equal(pendingText.textContent, '正在核对这些订单，继续整理使用范围。');
  context.window.getSelection = () => ({ isCollapsed: false, anchorNode: firstDraftAnchor });
  transport.write(frame('step', { ...correlation, id: 'tool-2', label: '整理答复', status: 'running' })); await tick();
  assert.ok(pendingSteps.querySelector('li') === firstStepItem, 'new keyed steps retain existing step nodes');
  assert.equal(pendingSteps.querySelectorAll('li').length, 2);
  assert.ok(walk(scroller).includes(firstDraftAnchor), 'a step update keeps the selected live text anchor connected');
  delete context.window.getSelection;
  scroller.scrollTop = 240;
  transport.write(frame('delta', { ...correlation, messageId: 'assistant-2', text: '新的答复草稿 <img src=x>' })); await tick();
  assert.equal(scroller.scrollTop, 240, 'stream updates cannot pull a reader away from earlier messages');
  assert.ok(!nodes.get('chat-messages').textContent.includes('正在核对这些订单'), 'a new assistant message replaces the previous tool-loop draft');
  assert.ok(nodes.get('chat-messages').textContent.includes('新的答复草稿 <img src=x>'), 'streamed content is safe plain text');
  assert.ok(!walk(scroller).includes(firstDraftAnchor) && firstDraftAnchor.isConnected === false, 'a different assistant message discards the previous draft by contract');
  const finalDraftAnchor = pendingText.children[0];
  assert.ok(!pendingAssistantRow.querySelector('.order-card'), 'provisional text never creates trusted order cards');
  scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 20;
  transport.write(frame('step', { ...correlation, id: 'tool-1', label: '查询最近订单', status: 'done' })); await tick();
  assert.equal(scroller.scrollTop, scroller.scrollHeight, 'readers near the bottom continue following live updates');
  assert.ok(pendingSteps.querySelector('li') === firstStepItem); assert.ok(walk(scroller).includes(finalDraftAnchor));
  assert.equal(pendingSteps.open, false);
  scroller.scrollTop = 240;
  pendingSummary.focus();
  const composerFocusCalls = input.focusCalls ?? 0;
  const recentReply = { kind: 'order', text: '这是你的最近订单。', hasMore: true, orders: [
    { id: 'COUPON-1001', status: 'paid', paidCents: 9800, refundedCents: 0, couponStatuses: ['unused'],
      productName: '<script>双人套餐</script>', shopName: '青禾餐厅', createdAt: '2026-10-09T00:00:00Z', selectionText: '选择订单 COUPON-1001' }
  ] };
  transport.write(frame('result', { ...correlation, reply: recentReply, durationMs: 5, origin: 'agent', steps: [{ id: 'tool-1', label: '查询最近订单', status: 'done' }]  })); transport.close(); await tick();
  assert.equal(scroller.scrollTop, 240, 'the final Reply also preserves a reader viewing earlier messages');
  assert.equal(scroller.children[0], historyRow, 'final Reply appends without replacing completed history');
  assert.equal(scroller.querySelector('.evidence'), historyEvidence);
  assert.equal(scroller.querySelector('.processing-steps'), historySteps);
  assert.equal(historyEvidence.open, true); assert.equal(historySteps.open, true);
  assert.equal(input.focusCalls ?? 0, composerFocusCalls, 'finishing a Reply cannot steal focus from the processing summary');
  assert.ok(document.activeElement === pendingSummary && walk(scroller).includes(pendingSummary));
  assert.equal(pendingSteps.open, false); assert.equal(pendingSteps.querySelectorAll('li').length, 1, 'final steps replace provisional metadata');
  assert.ok(scroller.children.at(-1) === pendingAssistantRow && scroller.children.at(-2) === pendingUserRow, 'validated final Reply promotes the existing current-turn rows');
  assert.ok(pendingAssistantRow.querySelector('.message-text') === pendingText);
  assert.equal(pendingText.textContent, recentReply.text, 'authoritative Reply replaces every provisional text fragment');
  assert.ok(!walk(scroller).includes(finalDraftAnchor) && finalDraftAnchor.isConnected === false);
  assert.ok(!pendingAssistantRow.querySelector('.turn-status'), 'validated completion removes the provisional status');
  delete document.activeElement;
  const messages = nodes.get('chat-messages');
  assert.ok(!messages.textContent.includes('新的答复草稿'), 'final Reply supersedes draft prose');
  assert.ok(messages.textContent.includes('<script>双人套餐</script>')); assert.ok(messages.textContent.includes('青禾餐厅'));
  assert.ok(messages.textContent.includes('当前展示最近3笔'), 'truncation is explicit rather than claiming all orders');
  const selectionButton = walk(messages).find(node => node.tagName === 'BUTTON' && node.textContent === '选择这笔订单');
  assert.ok(selectionButton, 'trusted selectionText produces an actionable order card');
  const failedQuestion = '预约规则的原问题 \n';
  await send(failedQuestion); const draftFailure = pending.shift();
  draftFailure.reject(new TypeError('synthetic question interruption')); await tick();
  const failedQuestionAttempt = runInContext('state.failedAttempt', context);
  const cardDraftHistory = [...scroller.children], cardDraftSession = runInContext('state.session', context);
  const cardDraftSettings = active.textContent;
  for (const cardDraft of ['我想问预约规则\n还有到账时间', ' \n\t', '选择订单 COUPON-1002', '选择订单 COUPON-1001 ']) {
    input.value = cardDraft; input.fire('input'); selectionButton.focus(); scroller.scrollTop = 240;
    const beforeCardDraft = calls.length;
    selectionButton.fire('click'); await tick();
    assert.equal(calls.length, beforeCardDraft, 'an order card must not post while a different unsent question exists');
    assert.equal(input.value, cardDraft, 'the exact unsent text survives the order-card action');
    assert.equal(nodes.get('app-status').textContent, '请先发送或清空输入框中的问题，再选择订单');
    assert.ok(document.activeElement === input); assert.equal(input.focusOptions.preventScroll, true); assert.equal(scroller.scrollTop, 240);
    assert.ok(runInContext('state.failedAttempt', context) === failedQuestionAttempt, 'blocking a card cannot replace a previous request UUID');
    assert.ok(runInContext('state.session', context) === cardDraftSession); assert.equal(active.textContent, cardDraftSettings);
    assert.deepEqual(scroller.children, cardDraftHistory, 'blocking a card preserves every current and completed row');
  }
  for (const cardGate of ['state.busy=true', 'state.initialized=false', 'state.expired=true']) {
    runInContext(cardGate + '; setBusy(state.busy)', context);
    const gatedCalls = calls.length, gatedFocusCalls = input.focusCalls, gatedStatus = nodes.get('app-status').textContent;
    selectionButton.fire('click'); await tick();
    assert.equal(calls.length, gatedCalls); assert.equal(input.focusCalls, gatedFocusCalls, 'locked cards cannot bypass the first interaction gates');
    assert.equal(input.value, '选择订单 COUPON-1001 '); assert.equal(nodes.get('app-status').textContent, gatedStatus);
    runInContext('state.busy=false; state.initialized=true; state.expired=false; setBusy(false)', context);
  }
  await send(failedQuestion); const failedQuestionRetry = pending.shift();
  assert.equal(failedQuestionRetry.body.requestId, draftFailure.body.requestId);
  assert.equal(failedQuestionRetry.body.text, failedQuestion);
  failedQuestionRetry.resolve(response({ sessionId: session.id, requestId: failedQuestionRetry.body.requestId,
    reply: { kind: 'notice', text: '继续处理原问题。' }, durationMs: 1, origin: 'host' })); await tick();
  assert.equal(input.value, '', 'successful retry still clears only its sent question');
  const countBeforeSelection = posts().length;
  selectionButton.fire('click'); await tick();
  assert.equal(posts().length, countBeforeSelection + 1, 'order selection continues without a second send click');
  const selected = pending.shift(); assert.equal(selected.body.text, '选择订单 COUPON-1001');
  selectionButton.fire('click'); await tick(); assert.equal(posts().length, countBeforeSelection + 1, 'busy card clicks cannot duplicate a turn');
  context.window.getSelection = () => ({ isCollapsed: false });
  const selectedTextFocusCalls = input.focusCalls ?? 0;
  selected.resolve(response({ sessionId: session.id, requestId: selected.body.requestId,
    reply: { kind: 'notice', text: '已选中，继续核对退款规则。' }, durationMs: 1, origin: 'host' })); await tick();
  assert.equal(input.focusCalls ?? 0, selectedTextFocusCalls, 'a selected history passage prevents automatic composer focus');
  delete context.window.getSelection;
  assert.equal(input.value, '', 'empty-composer card success keeps the original clear-on-success contract');

  input.value = '选择订单 COUPON-1001'; input.fire('input');
  selectionButton.fire('click'); await tick(); const sameCommand = pending.shift();
  assert.equal(sameCommand.body.text, input.value, 'the exact existing selection command may continue directly');
  sameCommand.resolve(response({ error: 'synthetic selection failure' }, 500)); await tick();
  assert.equal(input.value, '选择订单 COUPON-1001', 'failed selection preserves its own exact command for retry');
  const selectionFailure = runInContext('state.failedAttempt', context), beforeSelectionRetry = posts().length;
  input.value = '另一个未发送问题\n'; input.fire('input'); selectionButton.fire('click'); await tick();
  assert.equal(posts().length, beforeSelectionRetry); assert.equal(input.value, '另一个未发送问题\n');
  assert.ok(runInContext('state.failedAttempt', context) === selectionFailure);
  input.value = sameCommand.body.text; input.fire('input'); selectionButton.fire('click'); await tick();
  const sameCommandRetry = pending.shift(); assert.equal(sameCommandRetry.body.requestId, sameCommand.body.requestId);
  selectionButton.fire('click'); await tick(); assert.equal(posts().length, beforeSelectionRetry + 1, 'busy selection retries remain single requests');
  sameCommandRetry.resolve(response({ sessionId: session.id, requestId: sameCommandRetry.body.requestId,
    reply: { kind: 'notice', text: '选单已恢复。' }, durationMs: 1, origin: 'host' })); await tick();
  assert.equal(input.value, ''); assert.equal(runInContext('state.failedAttempt', context), null);

  for (const preserveSelection of [false, true]) {
    await send('最终没有步骤');
    const noStepsRequest = pending.shift(), noStepsTransport = openStream();
    const noStepsCorrelation = { sessionId: session.id, requestId: noStepsRequest.body.requestId };
    noStepsRequest.resolve(noStepsTransport.response); await tick();
    noStepsTransport.write(frame('start', { ...noStepsCorrelation, replayed: false }));
    noStepsTransport.write(frame('step', { ...noStepsCorrelation, id: 'temporary-step', label: '受理咨询', status: 'running' }));
    noStepsTransport.write(frame('delta', { ...noStepsCorrelation, messageId: 'temporary-message', text: '不能保留为最终答复的片段' })); await tick();
    const noStepsRow = scroller.children.at(-1), removedSummary = noStepsRow.querySelector('.processing-steps').querySelector('summary');
    removedSummary.focus();
    if (preserveSelection) context.window.getSelection = () => ({ isCollapsed: false, anchorNode: historyEvidence.querySelector('li') });
    const noStepsComposerFocusCalls = input.focusCalls ?? 0;
    noStepsTransport.write(frame('result', { ...noStepsCorrelation, reply: { kind: 'notice', text: '请重新核对当前信息。' }, steps: [], durationMs: 1, origin: 'host' })); noStepsTransport.close(); await tick();
    assert.ok(document.activeElement === (preserveSelection ? document.body : noStepsRow), 'removed summary hands focus to its message only without an active text selection');
    if (!preserveSelection) assert.equal(noStepsRow.focusOptions.preventScroll, true);
    else assert.equal(noStepsRow.focusCalls ?? 0, 0, 'final metadata cannot disturb selected history text');
    assert.equal(input.focusCalls ?? 0, noStepsComposerFocusCalls, 'removing a focused summary cannot move focus to the composer');
    assert.ok(!walk(scroller).includes(removedSummary) && !noStepsRow.querySelector('.processing-steps'));
    assert.ok(noStepsRow.classList.contains('notice')); assert.equal(noStepsRow.querySelector('.message-text').textContent, '请重新核对当前信息。');
    delete context.window.getSelection;
  }

  await send('断流原文 ');
  const cut = pending.shift(), partial = openStream(), partialCorrelation = { sessionId: session.id, requestId: cut.body.requestId };
  cut.resolve(partial.response); await tick();
  partial.write(frame('start', { ...partialCorrelation, replayed: false }));
  partial.write(frame('step', { ...partialCorrelation, id: 'partial-step', label: '受理咨询', status: 'running' }));
  partial.write(frame('delta', { ...partialCorrelation, messageId: 'assistant-1', text: '未完成草稿' })); await tick();
  const failedPendingRow = scroller.children.at(-1), failedSteps = failedPendingRow.querySelector('.processing-steps');
  const failedSummary = failedSteps.querySelector('summary'), failedDraftAnchor = failedPendingRow.querySelector('.message-text').children[0];
  failedSteps.open = false; failedSummary.focus(); partial.close(); await tick();
  assert.ok(scroller.children.at(-1) === failedPendingRow && document.activeElement === failedSummary);
  assert.equal(failedSteps.open, false); assert.ok(walk(scroller).includes(failedDraftAnchor));
  assert.ok(failedSteps.querySelector('.processing-step').classList.contains('error'), 'EOF marks running public steps incomplete in place');
  assert.equal(input.value, '断流原文 ', 'EOF without result preserves the exact draft');
  assert.equal(nodes.get('init-retry').hidden,false);assert.equal(nodes.get('init-retry').textContent,'查看当前记录','an unfinished non-quota stream offers an explicit record read alongside UUID retry');
  assert.ok(nodes.get('app-status').classList.contains('error'), 'EOF without terminal result is a visible failure');
  await send('断流原文 '); const cutRetry = pending.shift();
  assert.equal(cutRetry.body.requestId, cut.body.requestId, 'partial stream retry retains request UUID');
  const replayResult = { ...partialCorrelation, reply: { kind: 'answer', text: '回放的实际回复' }, durationMs: 1, origin: 'host' };
  const multilineResult = 'event: result\n' + JSON.stringify(replayResult, null, 2).split('\n').map(line => 'data: ' + line).join('\n') + '\n\n';
  cutRetry.resolve(streamResponse(frame('start', { ...partialCorrelation, replayed: true }) + multilineResult));
  await tick(); assert.equal(input.value, '');
  assert.equal(walk(nodes.get('chat-messages')).filter(node => node.className.split(' ').includes('message-text') && node.textContent === '断流原文 ').length, 1,
    'retry replaces the provisional attempt instead of duplicating the user message');

  await send('旧轮迟到隔离');
  const staleRequest = pending.shift(), staleTransport = openStream();
  const staleCorrelation = { sessionId: session.id, requestId: staleRequest.body.requestId };
  staleRequest.resolve(staleTransport.response); await tick();
  staleTransport.write(frame('start', { ...staleCorrelation, replayed: false }));
  staleTransport.write(frame('step', { ...staleCorrelation, id: 'old-step', label: '受理咨询', status: 'running' })); await tick();
  const stalePendingRow = scroller.children.at(-1);
  runInContext('initialize()', context); await tick();
  const restoredRows = [...scroller.children];
  staleTransport.write(frame('delta', { ...staleCorrelation, messageId: 'old-message', text: '旧轮迟到内容不可显示' }));
  staleTransport.write(frame('result', { ...staleCorrelation, reply: { kind: 'answer', text: '旧轮迟到内容不可显示' }, durationMs: 1, origin: 'host' })); staleTransport.close(); await tick();
  assert.ok(!walk(scroller).includes(stalePendingRow)); assert.ok(!scroller.textContent.includes('旧轮迟到内容不可显示'));
  assert.ok(scroller.children.every((row, index) => row === restoredRows[index]), 'late events cannot update the freshly restored view');
  assert.equal(input.disabled, false); assert.equal(nodes.get('app-status').textContent, '可咨询');

  await send('错误会话事件');
  const wrongStream = pending.shift(), wrong = openStream(); wrongStream.resolve(wrong.response); await tick();
  wrong.write(frame('delta', { sessionId: 'another-customer', requestId: wrongStream.body.requestId, messageId: 'assistant-1', text: '不能显示的他人资料' })); wrong.close(); await tick();
  assert.ok(!nodes.get('chat-messages').textContent.includes('不能显示的他人资料'), 'every event checks session and request correlation');
  assert.equal(input.value, '错误会话事件');

  await send('公开步骤边界');
  const rawStep = pending.shift(), privateStep = openStream(), stepCorrelation = { sessionId: session.id, requestId: rawStep.body.requestId };
  rawStep.resolve(privateStep.response); await tick();
  privateStep.write(frame('start', { ...stepCorrelation, replayed: false }));
  privateStep.write(frame('step', { ...stepCorrelation, id: 'tool-1', label: 'get_order', status: 'running' })); privateStep.close(); await tick();
  assert.ok(!nodes.get('chat-messages').textContent.includes('get_order'), 'raw tool names are not public progress labels');
  assert.equal(input.value, '公开步骤边界');
  await send('坏帧边界');
  const malformed = pending.shift(); malformed.resolve(streamResponse('event: delta\ndata: PRIVATE_INTERNAL_PAYLOAD\n\n')); await tick();
  assert.ok(!nodes.get('app-status').textContent.includes('PRIVATE_INTERNAL_PAYLOAD'), 'parse errors cannot expose malformed payload content');
  assert.equal(input.value, '坏帧边界');

  await send('SSE业务故障');
  const failedStream = pending.shift(), broken = openStream(), failedCorrelation = { sessionId: session.id, requestId: failedStream.body.requestId };
  failedStream.resolve(broken.response); await tick();
  broken.write(frame('start', { ...failedCorrelation, replayed: false }));
  broken.write(frame('error', { ...failedCorrelation, status: 503, error: '本轮未能完成，请重新开始。' })); broken.close(); session = null; await tick();
  const failedPosts = posts().length; form.fire('submit'); await tick();
  assert.equal(posts().length, failedPosts, 'SSE 503 requires recreated context');
  assert.equal(input.value, 'SSE业务故障');
  for (const id of ['model-select', 'thinking-select', 'tokens-select', 'apply-settings']) assert.equal(nodes.get(id).disabled, true, `${id} stays locked after an SSE session failure`);
  const beforeSSEExpiredSettings = calls.length;
  settingsForm.fire('submit'); await tick();
  assert.equal(calls.length, beforeSSEExpiredSettings, 'stream failure also blocks settings submission before reconnection');
  nodes.get('init-retry').focus(); nodes.get('init-retry').fire('click'); await tick(); assert.equal(input.value, 'SSE业务故障');
  for (const id of ['model-select', 'thinking-select', 'tokens-select', 'apply-settings']) assert.equal(nodes.get(id).disabled, false, `${id} unlocks after retry-button reconnection`);
  assert.ok(document.activeElement === input, 'successful retry hands off from its hidden source to the composer');
  assert.equal(input.focusOptions.preventScroll, true);

  serverMessages = [{ id: randomUUID(), role: 'assistant', text: '恢复的回复', reply: { kind: 'answer', text: '恢复的回复' },
    steps: [{ id: 'history-step', label: '查阅服务规则', status: 'done' }] }];
  runInContext('initialize()', context); await tick();
  assert.ok(!walk(nodes.get('chat-messages')).includes(historyRow), 'server-restored history replaces the previous DOM snapshot');
  assert.ok(!nodes.get('chat-messages').textContent.includes('已完成的历史答复'), 'restoring history removes the old snapshot');
  assert.ok(walk(nodes.get('chat-messages')).some(node => node.tagName === 'DETAILS' && node.textContent.includes('查阅服务规则')),
    'refresh restores public steps in a collapsible history trace');
  assert.ok(windowEvents.has('pageshow'), 'BFCache restoration must recheck the server session');
  windowEvents.get('pageshow')({ persisted: false });
  assert.equal(navigationReloads, 0, 'normal page loads do not reload in a loop');
  windowEvents.get('pageshow')({ persisted: true });
  assert.equal(navigationReloads, 1, 'restored DOM is not accepted as current identity or model state');

  for (const initialFocus of [document.body, null]) {
    if (initialFocus) document.activeElement = initialFocus; else delete document.activeElement;
    const passiveFocusCalls = [input, nodes.get('new-chat'), nodes.get('init-retry')].map(node => node.focusCalls ?? 0);
    runInContext('initialize()', context); await tick();
    assert.deepEqual([input, nodes.get('new-chat'), nodes.get('init-retry')].map(node => node.focusCalls ?? 0), passiveFocusCalls,
      'initialization without an explicit initiating control cannot automatically focus');
  }
  for (const sourceId of ['init-retry']) {
    const guards = ['moved', 'selection', 'removed', 'old-generation','no-active','no-layout'];
    for (const guard of guards) {
      const focusSource = nodes.get(sourceId), movedSummary = document.createElement('summary');
      nodes.get('chat-settings').append(movedSummary);
      runInContext('state.expired=true; setBusy(false)', context);
      focusSource.hidden = false; focusSource.focus();
      const sourceFocusCalls = focusSource.focusCalls, inputFocusCalls = input.focusCalls ?? 0;
      configWait = new Promise(resolve => { releaseConfig = resolve; });
      focusSource.fire('click'); await tick();
      assert.ok(document.activeElement === document.body, 'disabling the initiating control reproduces browser focus loss');
      if (guard === 'moved') movedSummary.focus();
      if (guard === 'selection') context.window.getSelection = () => ({ isCollapsed: false, anchorNode: movedSummary });
      if (guard === 'removed') focusSource.remove();
      if (guard === 'old-generation') runInContext('state.generation++', context);
      if (guard === 'hidden') focusSource.hidden = true;
      if (guard === 'no-layout') input.getClientRects = () => [];
      if (guard === 'no-active') delete document.activeElement;
      const finish = releaseConfig; configWait = null; releaseConfig = null; finish(); await tick();
      if (guard === 'no-active') {
        assert.ok(document.activeElement === input);assert.equal(input.focusCalls,inputFocusCalls+1);
      } else {
        assert.equal(focusSource.focusCalls, sourceFocusCalls, `${sourceId}/${guard} cannot restore the initiating control`);
        assert.equal(input.focusCalls ?? 0, inputFocusCalls, `${sourceId}/${guard} cannot fall back to the composer`);
        if (guard === 'moved') assert.ok(document.activeElement === movedSummary);
      }
      if (guard === 'old-generation') assert.equal(runInContext('state.busy', context), true, 'an old initialization cannot unlock a newer generation');
      delete context.window.getSelection; delete focusSource.getClientRects;delete input.getClientRects; focusSource.isConnected = true; movedSummary.remove();
      runInContext('state.initializing=false; state.initialized=true; state.expired=false; setBusy(false)', context);
    }
  }
  for (const failed of [false, true]) {
    const source = nodes.get('init-retry'); runInContext('state.expired=true; setBusy(false)', context);
    source.hidden = false; source.focus(); configFailure = failed;
    source.fire('click'); await tick();
    assert.ok(document.activeElement === (failed?source:input), 'explicit reconnection preserves source focus on failure and hands off on success');
    assert.equal((failed?source:input).focusOptions.preventScroll, true);
  }
  // Round 23: real history endpoints, independently stored records and per-conversation drafts.
  nodes.get('settings-dialog').close();
  document.activeElement=document.body;
  session.turns=1;serverMessages=[{id:randomUUID()+':user',role:'user',text:'原始已发送问题'},
    {id:randomUUID()+':assistant',role:'assistant',text:'原始实际答复',reply:{kind:'answer',text:'原始实际答复'}}];
  runInContext('initialize(state.profileId)',context);await tick();
  const originCID=session.conversationId, originProfile=session.profileId;
  const seedConversation=(text,messages,settings=defaults)=>{
    const cid=randomUUID(),createdAt='2026-10-09T01:00:00.000Z';
    const selected=models.find(model=>model.id===settings.modelSelection);
    conversations.set(cid,{session:{id:randomUUID(),conversationId:cid,profileId:originProfile,label:profile(originProfile).label,turns:1,busy:false,modelAvailable:true,
      settings:structuredClone(settings),model:{provider:selected.provider,id:selected.modelId}},messages:structuredClone(messages),title:text,createdAt,updatedAt:createdAt,
      status:messages.some(message=>message.status==='interrupted')?'interrupted':'ready'});
    return cid;
  };
  const historyOrder={kind:'order',text:'之前已核对的本人订单',orders:[{id:'COUPON-HISTORY',status:'paid',paidCents:9900,refundedCents:0,
    couponStatuses:['unused'],selectionText:'选择订单 COUPON-HISTORY'}],evidenceIds:['ORDER-HISTORY']};
  const historyCID=seedConversation('之前的订单问题',[{id:randomUUID()+':user',role:'user',text:'之前的订单问题'},
    {id:randomUUID()+':assistant',role:'assistant',text:historyOrder.text,reply:historyOrder,steps:[{id:'saved-step',label:'查询订单详情',status:'done'}]}],applied);
  const interruptedCID=seedConversation('未完成的问题',[{id:randomUUID()+':user',role:'user',text:'未完成的问题',status:'interrupted'},
    {id:randomUUID()+':assistant',role:'assistant',text:'本轮未能完成。',status:'interrupted'}]);
  const list=nodes.get('conversation-list'),mobileList=nodes.get('conversation-mobile-list');
  const historyPosts=()=>calls.filter(call=>call.path==='/api/chat/session/open');
  const historyReads=()=>calls.filter(call=>call.path.startsWith('/api/chat/sessions?'));
  const historyButton=(cid,container=list)=>container.querySelectorAll('.conversation-button').find(button=>button.dataset.conversationId===cid);
  runInContext('refreshConversations()',context);await tick();
  assert.ok(historyButton(historyCID)&&historyButton(historyCID,mobileList),'both history surfaces use actual server records');
  assert.equal(historyButton(originCID).getAttribute('aria-current'),'page');
  const stableHistoryButton=historyButton(historyCID);
  stableHistoryButton.focus();runInContext('refreshConversations()',context);await tick();
  assert.ok(historyButton(historyCID)===stableHistoryButton&&document.activeElement===stableHistoryButton,'list refresh preserves existing button identity and focus');
  const refreshDraft=input.value,refreshSession=runInContext('state.session',context),refreshMessages=runInContext('state.messages',context);
  const refreshMutations=calls.filter(call=>call.body).length;
  for(const container of [list,mobileList]){
    if(container===mobileList){nodes.get('history-open').fire('click');await tick();}
    const refresh=container.children[0],retry=container.children[2];
    for(const status of [0,500]){
      historyError=status;pauseHistory();refresh.focus();refresh.fire('click');await tick();
      assert.equal(refresh.disabled,true);assert.ok(document.activeElement===document.body);
      resumeHistory();await tick();
      assert.ok(document.activeElement===refresh,'manual history refresh returns focus after success or failure');
      assert.equal(refresh.focusOptions.preventScroll,true);
    }
    for(const status of [500,0]){
      historyError=status;pauseHistory();retry.focus();retry.fire('click');await tick();
      assert.equal(retry.hidden,true);resumeHistory();await tick();
      const expected=status?retry:refresh;
      assert.ok(document.activeElement===expected,'retry keeps its error action or hands focus to the same list refresh on success');
      assert.equal(expected.focusOptions.preventScroll,true);
    }
    if(container===mobileList)nodes.get('history-dialog').fire('cancel');
  }
  for(const active of [document.body,input]){
    document.activeElement=active;const focused=active.focusCalls??0;
    runInContext('refreshConversations()',context);await tick();
    assert.ok(document.activeElement===active,'automatic history reads cannot move focus');assert.equal(active.focusCalls??0,focused);
  }
  for(const guard of ['moved','selection','hidden','old-epoch','closed']){
    const container=guard==='closed'?mobileList:list;
    if(guard==='closed'){nodes.get('history-open').focus();nodes.get('history-open').fire('click');await tick();}
    const refresh=container.children[0];pauseHistory();refresh.focus();refresh.fire('click');await tick();
    if(guard==='moved')input.focus();
    if(guard==='selection')context.window.getSelection=()=>({isCollapsed:false,anchorNode:stableHistoryButton});
    if(guard==='hidden')container.style.display='none';
    if(guard==='old-epoch')runInContext('state.historyEpoch++;state.historyLoading=false;renderConversations()',context);
    if(guard==='closed')nodes.get('history-dialog').fire('cancel');
    const protectedFocus=document.activeElement,focusCalls=refresh.focusCalls;
    resumeHistory();await tick();assert.ok(document.activeElement===protectedFocus,`${guard} history completion cannot steal focus`);
    assert.equal(refresh.focusCalls,focusCalls);delete context.window.getSelection;container.style.display='';
  }
  assert.equal(input.value,refreshDraft);assert.ok(runInContext('state.session',context)===refreshSession&&runInContext('state.messages',context)===refreshMessages);
  assert.equal(calls.filter(call=>call.body).length,refreshMutations,'history focus restoration performs no session or message mutation');
  const sameHistoryPosts=historyPosts().length;historyButton(originCID).fire('click');await tick();
  assert.equal(historyPosts().length,sameHistoryPosts,'opening the selected conversation is a no-op');
  input.value='当前会话原稿\n保留空格  ';input.fire('input');
  const originDraft=input.value,oldRuntime=session.id;let beforeHistoryMessages=posts().length;
  pauseOpen();stableHistoryButton.focus();stableHistoryButton.fire('click');await tick();
  assert.equal(nodes.get('app-status').textContent,'正在打开会话…');assert.equal(input.disabled,true);
  stableHistoryButton.fire('click');runInContext('openConversation("'+interruptedCID+'")',context);await tick();
  assert.equal(historyPosts().length,sameHistoryPosts+1,'busy history changes cannot duplicate or replace an open request');
  assert.equal(input.value,originDraft);resumeOpen();await tick();
  assert.equal(session.conversationId,historyCID);assert.notEqual(session.id,oldRuntime);
  assert.deepEqual(historyPosts().at(-1).body,{conversationId:historyCID,profileId:originProfile,sessionId:oldRuntime});
  assert.equal(nodes.get('conversation-title').textContent,'之前的订单问题');assert.equal(input.value,'');
  assert.ok(scroller.textContent.includes('¥99.00')&&scroller.textContent.includes('ORDER-HISTORY'),'opening uses saved trusted reply and steps');
  assert.ok(active.textContent.includes('deepseek-v4-pro')&&active.textContent.includes('512'),'history restores its actual settings snapshot');
  assert.equal(posts().length,beforeHistoryMessages,'opening history never automatically sends or retries');
  assert.ok(document.activeElement===input);assert.equal(input.focusOptions.preventScroll,true);
  const otherDraftState=runInContext('({session:state.session,messages:state.messages,failedAttempt:state.failedAttempt})',context),otherDrafts=runInContext('JSON.stringify([...conversationDrafts])',context),otherDraftCalls=calls.length;
  assert.equal(clickEvaluation(),true,'another conversation draft also requires a leave decision when the current composer is empty');
  leaveDialog.fire('cancel');await tick();assert.equal(input.value,'');assert.ok(document.activeElement===evaluationLink);
  assert.equal(runInContext('JSON.stringify([...conversationDrafts])',context),otherDrafts);assert.equal(calls.length,otherDraftCalls);assert.equal(evaluationNavigations.length,confirmedLeaveCount);
  for(const key of Object.keys(otherDraftState))assert.ok(runInContext('state.'+key,context)===otherDraftState[key]);
  await send('另一会话的失败原文\n  ');const hiddenDraftFailed=pending.shift();hiddenDraftFailed.reject(new TypeError('synthetic unreceived reply'));await tick();beforeHistoryMessages++;
  input.value='';input.fire('input');
  const hiddenDraftProfile=originProfile==='demo-a'?'demo-b':'demo-a';
  const hiddenDraftState=runInContext('({session:state.session,messages:state.messages,failedAttempt:state.failedAttempt,profileId:state.profileId,generation:state.generation})',context);
  const hiddenDraftMap=runInContext('JSON.stringify([...conversationDrafts])',context),hiddenDraftCalls=calls.length;
  assert.ok(runInContext('conversationDrafts.size',context)>0);assert.equal(input.value,'');
  for(const cancellation of ['cancel','escape']){
    select.value=hiddenDraftProfile;select.fire('change');await tick();
    assert.equal(profileDialog.open,true,'a draft in another accepted conversation requires confirmation before changing customers');
    assert.equal(select.value,originProfile);assert.ok(nodes.get('profile-switch-description').textContent.includes('本页所有会话'));
    if(cancellation==='escape')profileDialog.fire('cancel');else profileDialog.close('cancel');await tick();
    assert.equal(calls.length,hiddenDraftCalls);assert.equal(input.value,'');assert.equal(runInContext('JSON.stringify([...conversationDrafts])',context),hiddenDraftMap);
    for(const key of Object.keys(hiddenDraftState))assert.ok(runInContext('state.'+key,context)===hiddenDraftState[key],`${cancellation} preserves the current consultation and hidden draft`);
  }
  const hiddenDraftRows=[historyButton(originCID),historyButton(historyCID)];
  for(const status of [400,409]){
    select.value=hiddenDraftProfile;select.fire('change');await tick();resetError=status;
    const resetCalls=calls.filter(call=>call.path==='/api/chat/session'&&call.body).length;
    profileDialog.close('switch');await tick();resetError=0;
    assert.equal(calls.filter(call=>call.path==='/api/chat/session'&&call.body).length,resetCalls+1);
    assert.equal(input.value,'');assert.equal(select.value,originProfile);assert.equal(runInContext('JSON.stringify([...conversationDrafts])',context),hiddenDraftMap);
    for(const key of ['session','messages','failedAttempt','profileId'])assert.ok(runInContext('state.'+key,context)===hiddenDraftState[key],`rejected ${status} customer switch preserves ${key}`);
    assert.ok(historyButton(originCID)===hiddenDraftRows[0]&&historyButton(historyCID)===hiddenDraftRows[1],'failed customer switch preserves both history navigation nodes');
  }
  assert.equal(runInContext('state.failedAttempt.requestId',context),hiddenDraftFailed.body.requestId,'rejected switching cannot replace the failed request UUID');
  const historyRefreshOrder=scroller.querySelector('.order-select-button');assert.equal(historyRefreshOrder.textContent,'重新查询最近订单');
  assert.equal(scroller.querySelectorAll('.order-select-button').length,1,'restored cards expose one fresh lookup, never old selection commands');
  input.value='历史事实不能覆盖原稿 \n';input.fire('input');historyRefreshOrder.fire('click');await tick();
  assert.equal(posts().length,beforeHistoryMessages);assert.equal(input.value,'历史事实不能覆盖原稿 \n');
  input.value='';input.fire('input');historyRefreshOrder.fire('click');await tick();const freshLookup=pending.shift();
  assert.equal(freshLookup.body.text,'我有哪些订单');assert.notEqual(freshLookup.body.text,historyOrder.orders[0].selectionText);
  freshLookup.resolve(response({sessionId:session.id,requestId:freshLookup.body.requestId,reply:{kind:'order',text:'重新查询的订单',orders:[{
    id:'COUPON-FRESH',status:'paid',paidCents:12300,refundedCents:0,couponStatuses:['unused'],selectionText:'选择订单 COUPON-FRESH'}]},durationMs:1,origin:'host'}));await tick();
  beforeHistoryMessages++;
  assert.ok(scroller.querySelectorAll('.order-select-button').some(button=>button.textContent==='选择这笔订单'),'fresh received discovery keeps its valid selection action');
  input.value='旧会话隔离草稿 \n';input.fire('input');const savedHistoryDraft=input.value;
  historyButton(interruptedCID).fire('click');await tick();
  assert.equal(input.value,'');assert.ok(scroller.textContent.includes('本轮未完成 · 未自动重试'));
  assert.equal(scroller.querySelectorAll('.order-card').length,0,'incomplete history cannot manufacture a trusted card');
  assert.equal(posts().length,beforeHistoryMessages,'interrupted history cannot auto retry');
  historyButton(historyCID).fire('click');await tick();assert.equal(input.value,savedHistoryDraft,'returning restores exact per-conversation draft bytes');
  historyButton(originCID).fire('click');await tick();assert.equal(input.value,originDraft,'another conversation keeps its independent draft');
  const seededReturnId=session.id;
  await send('历史恢复后的真实续问 ');const continuation=pending.shift();
  assert.equal(continuation.body.sessionId,seededReturnId,'continuation uses the opened runtime UUID');
  continuation.resolve(response({sessionId:session.id,requestId:continuation.body.requestId,reply:{kind:'answer',text:'续问的实际答复'},durationMs:1,origin:'host'}));await tick();
  assert.equal(historyButton(originCID).querySelector('.conversation-name').textContent,'原始已发送问题');
  assert.equal(nodes.get('conversation-title').textContent,'原始已发送问题','continued questions retain the first actual conversation title');

  await send('列表失败不能覆盖原稿\n  ');const listFailedAttempt=pending.shift();listFailedAttempt.reject(new TypeError('synthetic retryable failure'));await tick();
  const protectedCurrent=runInContext('({session:state.session,messages:state.messages,failedAttempt:state.failedAttempt,generation:state.generation})',context),protectedDraft=input.value;
  historyError=500;list.querySelector('.quiet-button').fire('click');await tick();
  assert.ok(list.querySelector('.conversation-error').textContent.includes('请求失败'));assert.equal(list.querySelectorAll('.conversation-error').length,1,'list failure has one current error message');assert.ok(!list.textContent.includes('正在读取会话…'));assert.ok(historyButton(originCID),'failed list keeps existing useful records');
  for(const key of Object.keys(protectedCurrent))assert.ok(runInContext('state.'+key,context)===protectedCurrent[key],`list error preserves ${key}`);
  assert.equal(input.value,protectedDraft);assert.equal(runInContext('state.expired',context),false,'list-only failure cannot expire the working chat');
  historyError=0;const beforeListRetry=historyReads().length;list.children[2].fire('click');await tick();
  assert.equal(historyReads().length,beforeListRetry+1);assert.equal(list.children[2].hidden,true);
  form.fire('submit');await tick();const originalRetry=pending.shift();assert.equal(originalRetry.body.requestId,listFailedAttempt.body.requestId,'history refresh does not disrupt exact UUID retry');
  originalRetry.resolve(response({sessionId:session.id,requestId:originalRetry.body.requestId,reply:{kind:'answer',text:'原请求已恢复'},durationMs:1,origin:'host'}));await tick();
  historyOverride={conversations:[{id:historyCID,profileId:originProfile,title:'他人的错误格式'}],limit:100};
  runInContext('refreshConversations()',context);await tick();assert.ok(list.querySelector('.conversation-error').textContent.includes('格式异常'));
  assert.equal(historyButton(historyCID).querySelector('.conversation-name').textContent,'之前的订单问题','invalid metadata is never rendered');
  historyOverride=null;runInContext('refreshConversations()',context);await tick();

  for(const status of [400,404,409]){
    input.value='打开失败时的原文 \n';input.fire('input');
    const beforeOpen=runInContext('({session:state.session,messages:state.messages,failedAttempt:state.failedAttempt})',context);
    openError=status;const source=historyButton(historyCID);source.focus();source.fire('click');await tick();
    for(const key of Object.keys(beforeOpen))assert.ok(runInContext('state.'+key,context)===beforeOpen[key],`open ${status} preserves ${key}`);
    assert.equal(input.value,'打开失败时的原文 \n');assert.equal(runInContext('state.expired',context),false);
    assert.ok(document.activeElement===source);assert.equal(source.focusOptions.preventScroll,true);
  }
  openError=401;historyButton(historyCID).fire('click');await tick();
  assert.equal(runInContext('state.expired',context),true);assert.equal(historyButton(historyCID).disabled,true);
  const beforeExpiredHistory=historyPosts().length;historyButton(historyCID).fire('click');await tick();assert.equal(historyPosts().length,beforeExpiredHistory);
  openError=0;nodes.get('init-retry').focus();nodes.get('init-retry').fire('click');await tick();
  assert.equal(session.conversationId,originCID);assert.equal(input.value,'打开失败时的原文 \n');
  assert.equal(historyButton(historyCID).disabled,false,'explicit reconnection restores history navigation');
  pauseOpen();historyButton(historyCID).fire('click');await tick();
  runInContext('initialize(state.profileId)',context);await tick();
  const freshSnapshot=runInContext('({session:state.session,messages:state.messages})',context),lateHistoryInput=input.value;resumeOpen();await tick();
  assert.ok(runInContext('state.session',context)===freshSnapshot.session&&runInContext('state.messages',context)===freshSnapshot.messages,'old open result cannot replace a reinitialized generation');
  assert.equal(input.value,lateHistoryInput);
  runInContext('initialize(state.profileId)',context);await tick(); // Re-read the runtime actually rotated by the late server operation.

  const historyDialog=nodes.get('history-dialog'),historyOpen=nodes.get('history-open');
  const beforeDialogPosts=historyPosts().length;historyOpen.focus();historyOpen.fire('click');await tick();
  historyOpen.fire('click');assert.equal(historyDialog.open,true);assert.ok(document.activeElement===nodes.get('history-close'));
  const openedCount=historyDialog.showModalCalls;historyOpen.fire('click');assert.equal(historyDialog.showModalCalls,openedCount);
  historyDialog.fire('cancel');await tick();assert.equal(historyDialog.open,false);assert.ok(document.activeElement===historyOpen);
  assert.equal(historyPosts().length,beforeDialogPosts,'opening/cancelling a mobile history window sends no session mutation');
  const breakpointDraft=input.value,breakpointSession=runInContext('state.session',context),breakpointMessages=runInContext('state.messages',context);
  const breakpointMutations=calls.filter(call=>call.body).length;
  for(const guard of ['hidden-opener','selection','busy']){
    historyOpen.focus();historyOpen.fire('click');await tick();historyOpen.style.display='none';
    if(guard==='selection')context.window.getSelection=()=>({isCollapsed:false});
    if(guard==='busy')runInContext('setBusy(true)',context);
    const beforeFallback=newChat.focusCalls??0;historyDialog.fire('cancel');await tick();
    assert.equal(historyDialog.open,false);
    if(guard==='hidden-opener'){
      assert.ok(document.activeElement===newChat,'closing history after its mobile opener becomes hidden hands focus to fixed navigation');
      assert.equal(newChat.focusOptions.preventScroll,true);
      nodes.get('settings-open').focus();historyDialog.fire('close');assert.ok(document.activeElement===nodes.get('settings-open'),'a queued close cannot override moved focus');
    }else assert.equal(newChat.focusCalls??0,beforeFallback,`${guard} prevents hidden-opener fallback from stealing focus`);
    delete context.window.getSelection;historyOpen.style.display='';if(guard==='busy')runInContext('setBusy(false)',context);
  }
  assert.equal(input.value,breakpointDraft);assert.ok(runInContext('state.session',context)===breakpointSession&&runInContext('state.messages',context)===breakpointMessages);
  assert.equal(calls.filter(call=>call.body).length,breakpointMutations,'cancel across a breakpoint cannot mutate the current conversation');
  for(const status of [409,404,503]){
    historyOpen.focus();historyOpen.fire('click');await tick();openError=status;pauseOpen();
    input.value='历史打开失败保留原文 \n  ';input.fire('input');
    const beforeFailure=runInContext('({session:state.session,messages:state.messages,failedAttempt:state.failedAttempt,profileId:state.profileId})',context);
    const failureCalls=calls.filter(call=>call.body).length;
    const mobileTarget=historyButton(session.conversationId===interruptedCID?historyCID:interruptedCID,mobileList);mobileTarget.focus();mobileTarget.fire('click');await tick();
    mobileTarget.fire('click');await tick();assert.equal(calls.filter(call=>call.body).length,failureCalls+1,'repeated pending history clicks send only one open');
    resumeOpen();await tick();
    assert.equal(historyDialog.open,false,'failed mobile open closes the modal so its status and recovery action are reachable');
    assert.equal(historyDialog.contains(nodes.get('app-status')),false,'history failure is presented in the main page after closing');
    const recovery=status===503?nodes.get('init-retry'):historyOpen;
    assert.ok(document.activeElement===recovery,'mobile failure hands focus to the usable recovery action');assert.equal(recovery.focusOptions.preventScroll,true);
    assert.equal(recovery.hidden,false);assert.equal(recovery.disabled,false);assert.ok(recovery.getClientRects().length);
    assert.equal(nodes.get('app-status').textContent,status===404?'此客户的会话记录已不可用，请刷新记录或选择其他会话':status===503?'服务暂不可用，请稍后重试':'当前消息仍在处理中，请稍后重试');
    assert.equal(input.value,'历史打开失败保留原文 \n  ');assert.equal(calls.filter(call=>call.body).length,failureCalls+1,'failure never automatically reconnects, creates or sends');
    for(const key of Object.keys(beforeFailure))assert.ok(runInContext('state.'+key,context)===beforeFailure[key],`mobile ${status} preserves ${key}`);
    const recoveryFocusCalls=recovery.focusCalls;historyDialog.fire('close');assert.equal(recovery.focusCalls,recoveryFocusCalls,'a queued close event cannot override the recovery handoff');
    openError=0;if(status===503){recovery.fire('click');await tick();assert.equal(runInContext('state.expired',context),false);}
  }
  for(const guard of ['moved','selection','no-layout','old-generation']){
    historyOpen.focus();historyOpen.fire('click');await tick();openError=503;pauseOpen();
    const mobileTarget=historyButton(session.conversationId===interruptedCID?historyCID:interruptedCID,mobileList);mobileTarget.focus();mobileTarget.fire('click');await tick();
    if(guard==='moved'){nodes.get('history-close').fire('click');nodes.get('settings-open').focus();}
    if(guard==='selection')context.window.getSelection=()=>({isCollapsed:false,anchorNode:mobileTarget});
    if(guard==='no-layout')nodes.get('init-retry').style.display='none';
    if(guard==='old-generation'){
      nodes.get('history-close').fire('click');openError=0;runInContext('initialize(state.profileId)',context);await tick();historyOpen.fire('click');await tick();
    }
    const protectedFocus=document.activeElement,guardStatus=nodes.get('app-status').textContent;
    const focusCalls=[historyOpen,nodes.get('init-retry'),input].map(node=>node.focusCalls??0);
    const guardCalls=calls.filter(call=>call.body).length;
    resumeOpen();await tick();
    assert.deepEqual([historyOpen,nodes.get('init-retry'),input].map(node=>node.focusCalls??0),focusCalls,`${guard} prevents failure from stealing focus`);
    assert.equal(calls.filter(call=>call.body).length,guardCalls,'protected failure cannot add an automatic mutation');
    if(guard==='moved')assert.ok(document.activeElement===protectedFocus);
    if(guard==='old-generation'){assert.equal(historyDialog.open,true,'late failure cannot close a newly opened history window');assert.equal(nodes.get('app-status').textContent,guardStatus);assert.equal(runInContext('state.expired',context),false);nodes.get('history-close').fire('click');}
    else assert.equal(historyDialog.open,false);
    delete context.window.getSelection;nodes.get('init-retry').style.display='';openError=0;
    if(runInContext('state.expired',context)){nodes.get('init-retry').fire('click');await tick();}
  }
  historyOpen.fire('click');await tick();historyButton(session.conversationId===interruptedCID?historyCID:interruptedCID,mobileList).fire('click');await tick();
  assert.equal(historyDialog.open,false);assert.ok(document.activeElement===input,'successful mobile open closes history and hands focus to the composer');
  historyOpen.fire('click');await tick();context.window.getSelection=()=>({isCollapsed:false});
  const beforeSelectionFocus=input.focusCalls;historyButton(session.conversationId===historyCID?interruptedCID:historyCID,mobileList).fire('click');await tick();
  assert.equal(historyDialog.open,false);assert.equal(input.focusCalls,beforeSelectionFocus,'history success does not steal an active text selection');delete context.window.getSelection;

  const settingsDialog=nodes.get('settings-dialog'),settingsOpen=nodes.get('settings-open'),settingsClose=nodes.get('settings-close');
  const settingsPostsBefore=calls.filter(call=>call.body).length;settingsOpen.focus();settingsOpen.fire('click');
  assert.ok(settingsDialog.open&&document.activeElement===settingsClose);settingsDialog.fire('cancel');await tick();
  assert.ok(!settingsDialog.open&&document.activeElement===settingsOpen);assert.equal(calls.filter(call=>call.body).length,settingsPostsBefore,'viewing/cancelling settings cannot apply them');
  settingsOpen.fire('click');input.value='设置新会话转移稿 \n';input.fire('input');
  const settingsOrigin=session.conversationId;pauseReset();nodes.get('apply-settings').focus();settingsForm.fire('submit');await tick();
  settingsClose.fire('click');const afterCloseFocus=input.focusCalls;resumeReset();await tick();
  assert.equal(settingsDialog.open,false);assert.ok(document.activeElement===settingsOpen,'finishing an apply cannot focus controls in a closed settings window');
  assert.equal(input.focusCalls,afterCloseFocus);assert.equal(input.value,'设置新会话转移稿 \n');
  const transferredCID=session.conversationId;assert.notEqual(transferredCID,settingsOrigin);
  const blockedEmptyOpen=historyPosts().length;historyButton(settingsOrigin).fire('click');await tick();
  assert.equal(historyPosts().length,blockedEmptyOpen);assert.equal(input.value,'设置新会话转移稿 \n');assert.equal(nodes.get('app-status').textContent,'请先发送或清空当前问题，再打开其他会话');
  assert.ok(document.activeElement===input);assert.equal(historyButton(transferredCID),undefined,'an empty new conversation is not a history record');
  historyOpen.fire('click');await tick();const blockedMobileTarget=historyButton(settingsOrigin,mobileList);
  blockedMobileTarget.focus();const beforeBlockedMobileCalls=calls.length;blockedMobileTarget.fire('click');await tick();
  assert.equal(historyDialog.open,false,'mobile empty-draft protection closes the modal before returning to the composer');
  assert.ok(document.activeElement===input);assert.equal(input.focusOptions.preventScroll,true);assert.equal(input.value,'设置新会话转移稿 \n');
  assert.equal(calls.length,beforeBlockedMobileCalls,'mobile draft protection performs zero HTTP calls');
  const mobileDraftFocusCalls=input.focusCalls;historyDialog.fire('close');assert.ok(document.activeElement===input);assert.equal(input.focusCalls,mobileDraftFocusCalls,'a queued close event cannot steal restored composer focus');

  await send('已发送的设置新会话问题');const acceptedSettings=pending.shift();acceptedSettings.resolve(response({sessionId:session.id,requestId:acceptedSettings.body.requestId,reply:{kind:'answer',text:'设置后实际答复'},durationMs:1,origin:'host'}));await tick();
  input.value='设置新会话转移稿 \n';input.fire('input');
  historyButton(settingsOrigin).fire('click');await tick();assert.equal(input.value,'','settings transfer does not duplicate a draft into the source');
  historyButton(transferredCID).fire('click');await tick();assert.equal(input.value,'设置新会话转移稿 \n');
  const beforeNewCID=session.conversationId;nodes.get('new-chat').fire('click');await tick();
  assert.equal(input.value,'设置新会话转移稿 \n');const newCID=session.conversationId;assert.notEqual(newCID,beforeNewCID);
  const blockedNewOpen=historyPosts().length;historyButton(beforeNewCID).fire('click');await tick();assert.equal(historyPosts().length,blockedNewOpen);
  assert.equal(input.value,'设置新会话转移稿 \n');assert.equal(historyButton(newCID),undefined);
  await send('新会话已发送的问题');const acceptedNew=pending.shift();acceptedNew.resolve(response({sessionId:session.id,requestId:acceptedNew.body.requestId,reply:{kind:'answer',text:'新会话实际答复'},durationMs:1,origin:'host'}));await tick();
  input.value='设置新会话转移稿 \n';input.fire('input');historyButton(beforeNewCID).fire('click');await tick();assert.equal(input.value,'');
  historyButton(newCID).fire('click');await tick();assert.equal(input.value,'设置新会话转移稿 \n','accepted conversations retain per-CID drafts while new empty ones protect their current draft');

  // GET busy describes an existing live run; only an explicit read is allowed until it finishes.
  session.busy=true;serverMessages=[{id:randomUUID()+':user',role:'user',text:'刷新前正在处理的问题',status:'pending'}];
  runInContext('initialize(state.profileId)',context);await tick();
  for(const id of ['chat-input','send-button','new-chat','profile-select','model-select','thinking-select','tokens-select','apply-settings'])assert.equal(nodes.get(id).disabled,true,`${id} respects server busy`);
  assert.equal(historyButton(historyCID).disabled,true);assert.equal(nodes.get('init-retry').disabled,false);
  assert.equal(nodes.get('init-retry').textContent,'查看处理结果');assert.ok(scroller.textContent.includes('本轮正在处理 · 答复尚未完成'));
  const busyCalls=calls.length;form.fire('submit');nodes.get('new-chat').fire('click');settingsForm.fire('submit');historyButton(historyCID).fire('click');await tick();
  assert.equal(calls.length,busyCalls,'refreshing a busy conversation cannot reset, open, apply or resend it');
  configWait=new Promise(resolve=>{releaseConfig=resolve;});nodes.get('init-retry').fire('click');nodes.get('init-retry').fire('click');await tick();
  assert.equal(calls.length,busyCalls+1,'repeated busy reads cannot duplicate initialization');
  const finishBusyRead=releaseConfig;configWait=null;releaseConfig=null;finishBusyRead();await tick();
  assert.equal(runInContext('state.remoteBusy',context),true);
  configFailure=true;nodes.get('init-retry').fire('click');await tick();assert.equal(nodes.get('init-retry').disabled,false,'a failed busy read still has a usable recovery action');
  session.busy=false;serverMessages=[{id:randomUUID()+':user',role:'user',text:'刷新前正在处理的问题',status:'interrupted'},
    {id:randomUUID()+':assistant',role:'assistant',text:'本轮未完成，请重新提问。',status:'interrupted'}];
  const sendsBeforeBusyRecovery=posts().length;nodes.get('init-retry').fire('click');await tick();
  assert.equal(input.disabled,false);assert.equal(nodes.get('init-retry').hidden,true);assert.equal(posts().length,sendsBeforeBusyRecovery);
  assert.ok(scroller.textContent.includes('本轮未完成 · 未自动重试'));
  assert.equal(input.value,'设置新会话转移稿 \n','manual busy-result reads preserve the exact draft');
  const examples=nodes.get('starter-list').querySelectorAll('.starter-button');assert.equal(examples.length,3);
  for(const [index,question] of profile(originProfile).examples.entries()){
    const beforeFillPosts=posts().length;input.value='';input.fire('input');examples[index].fire('click');await tick();assert.equal(input.value,question);assert.equal(posts().length,beforeFillPosts);
    input.value='不要覆盖的问题\n  ';input.fire('input');examples[index].fire('click');await tick();assert.equal(input.value,'不要覆盖的问题\n  ');
  }
  context.badHistorySession={session:structuredClone(session),messages:[{id:'bad',role:'assistant',text:'未完成',status:'interrupted',reply:{kind:'answer',text:'不可信成功'}}]};
  assert.equal(runInContext('validateSession(badHistorySession)',context),false,'incomplete history cannot carry a successful reply');
  const unavailableRecord=conversations.get(historyCID);
  unavailableRecord.session.modelAvailable=false;
  unavailableRecord.session.modelUnavailableReason='此对话的模型设置当前不可用或已变化，可查看记录、查询订单或新建对话选择模型。';
  historyButton(historyCID).fire('click');await tick();
  assert.ok(scroller.textContent.includes('之前已核对的本人订单'),'unavailable stored model does not prevent history reading');
  assert.ok(nodes.get('app-status').textContent.includes('模型设置当前不可用'));assert.ok(active.textContent.includes('模型设置当前不可用'));
  assert.equal(input.disabled,false,'host order and arrival queries remain possible without the old model');
  input.value='';input.fire('input');scroller.querySelector('.order-select-button').fire('click');await tick();const hostWithoutModel=pending.shift();
  assert.equal(hostWithoutModel.body.text,'我有哪些订单');hostWithoutModel.resolve(response({sessionId:session.id,requestId:hostWithoutModel.body.requestId,
    reply:{kind:'notice',text:'重新读取的订单范围'},durationMs:1,origin:'host'}));await tick();
  input.value='不要覆盖的问题\n  ';input.fire('input');
  const limitCID=seedConversation('达到二十轮的历史',[{id:randomUUID()+':user',role:'user',text:'达到二十轮的历史'},
    {id:randomUUID()+':assistant',role:'assistant',text:historyOrder.text,reply:historyOrder}]);
  conversations.get(limitCID).session.turns=20;conversations.get(limitCID).status='limit';
  runInContext('refreshConversations()',context);await tick();historyButton(limitCID).fire('click');await tick();
  assert.equal(nodes.get('app-status').textContent,'本次会话已达20轮，请新建对话');
  input.value='到上限后保留问题 \n';input.fire('input');assert.equal(nodes.get('send-button').disabled,true);
  assert.equal(scroller.querySelector('.order-select-button').disabled,true);assert.equal(nodes.get('new-chat').disabled,false);
  const beforeLimitSends=posts().length;form.fire('submit');scroller.querySelector('.order-select-button').fire('click');await tick();
  assert.equal(posts().length,beforeLimitSends,'a full historical conversation cannot spend another failed message turn');
  runInContext('initialize(state.profileId)',context);await tick();
  assert.equal(nodes.get('app-status').textContent,'本次会话已达20轮，请新建对话');assert.equal(nodes.get('send-button').disabled,true);
  assert.equal(historyButton(historyCID).disabled,false,'a full conversation still allows other history and new conversation actions');
  nodes.get('new-chat').fire('click');await tick();assert.equal(session.turns,0);assert.equal(input.value,'到上限后保留问题 \n');assert.equal(nodes.get('send-button').disabled,false);
  assert.equal(posts().length,beforeLimitSends,'new conversation does not automatically resend the kept draft');
  session.turns=20;runInContext('refreshConversations()',context);await tick();assert.equal(nodes.get('send-button').disabled,true);
  assert.equal(runInContext('state.session.turns',context),20,'same-conversation metadata can raise the actual turn count');
  assert.ok(historyButton(session.conversationId).textContent.includes('已达轮数上限'));
  session.turns=19;runInContext('refreshConversations()',context);await tick();assert.equal(nodes.get('send-button').disabled,true);
  assert.equal(runInContext('state.session.turns',context),20,'a stale lower metadata count cannot reopen sending');
  nodes.get('new-chat').fire('click');await tick();assert.equal(nodes.get('send-button').disabled,false);
  input.value='不要覆盖的问题\n  ';input.fire('input');
  const oldProfile=originProfile,otherProfile=oldProfile==='demo-a'?'demo-b':'demo-a';
  select.value=otherProfile;select.fire('change');await tick();profileDialog.close('cancel');await tick();assert.equal(input.value,'不要覆盖的问题\n  ');
  select.value=otherProfile;select.fire('change');await tick();profileDialog.close('switch');await tick();assert.equal(input.value,'');
  select.value=oldProfile;select.fire('change');await tick();historyButton(historyCID).fire('click');await tick();
  assert.equal(input.value,'','confirmed customer changes clear old customer drafts, including other conversations');
  pauseHistory();runInContext('refreshConversations()',context);await tick();
  const beforeLateHistory=historyButton(historyCID);runInContext('state.generation++',context);resumeHistory();await tick();
  assert.ok(historyButton(historyCID)===beforeLateHistory,'a late list cannot mutate another generation');
  runInContext('initialize(state.profileId)',context);await tick();
  await send('实际断线原稿\n结尾  ');const readRejected=pending.shift(),rejectedStream=openStream();
  readRejected.resolve(rejectedStream.response);await tick();
  rejectedStream.write(frame('start',{sessionId:session.id,requestId:readRejected.body.requestId,replayed:false}));await tick();
  rejectedStream.fail(new TypeError('network error'));await tick();
  assert.equal(nodes.get('app-status').textContent,'连接已中断，本轮未完成；请保留原文重试');
  assert.equal(input.value,readRejected.body.text);assert.equal(runInContext('state.failedAttempt.requestId',context),readRejected.body.requestId);
  form.fire('submit');await tick();const rejectedRetry=pending.shift();assert.equal(rejectedRetry.body.requestId,readRejected.body.requestId);
  rejectedRetry.resolve(response({sessionId:session.id,requestId:rejectedRetry.body.requestId,reply:{kind:'notice',text:'断线原请求已恢复'},durationMs:1,origin:'host'}));await tick();
  session.turns=19;serverMessages=Array.from({length:19},(_,index)=>[
    {id:randomUUID()+':user',role:'user',text:'已受理的历史问题'+index},
    {id:randomUUID()+':assistant',role:'assistant',text:'已完成的历史答复'+index,reply:{kind:'answer',text:'已完成的历史答复'+index}}]).flat();
  runInContext('initialize(state.profileId)',context);await tick();
  await send('第二十轮原文\n保留结尾  ');const committedLimit=pending.shift(),lostLimit=openStream();
  const committedReply={kind:'answer',text:'第二十轮已经实际完成',evidenceIds:['FAQ-COMMITTED-20']};
  committedLimit.resolve(lostLimit.response);await tick();
  session.turns=20;serverMessages.push({id:committedLimit.body.requestId+':user',role:'user',text:committedLimit.body.text},
    {id:committedLimit.body.requestId+':assistant',role:'assistant',text:committedReply.text,reply:committedReply});recordCurrent();
  lostLimit.write(frame('start',{sessionId:session.id,requestId:committedLimit.body.requestId,replayed:false}));lostLimit.close();await tick();
  assert.equal(runInContext('state.session.turns',context),20);assert.equal(nodes.get('send-button').disabled,true);
  assert.equal(nodes.get('init-retry').hidden,false,'a committed twentieth turn with lost SSE exposes a read-only recovery');
  assert.equal(nodes.get('init-retry').textContent,'查看当前记录');const beforeCompletedRead=posts().length;
  nodes.get('init-retry').fire('click');await tick();assert.equal(posts().length,beforeCompletedRead);
  assert.ok(scroller.textContent.includes(committedReply.text)&&scroller.textContent.includes('FAQ-COMMITTED-20'));
  assert.equal(runInContext('state.failedAttempt',context),null);assert.equal(input.value,committedLimit.body.text);
  assert.equal(nodes.get('app-status').textContent,'本次会话已达20轮，请新建对话');assert.equal(nodes.get('init-retry').hidden,true);
  // A lost open response must not turn an existing empty history into a new draft destination.
  for(const failure of ['throw','malformed']){
    const sourceCID=session.conversationId,targetEmpty=seedConversation('新对话',[]);
    conversations.get(targetEmpty).session.turns=0;
    input.value='响应丢失前的来源草稿\n末尾空格  ';input.fire('input');const sourceDraft=input.value;
    const emptyRecord=conversations.get(targetEmpty);
    historyOverride={limit:100,conversations:[{id:targetEmpty,profileId:originProfile,title:'新对话',createdAt:emptyRecord.createdAt,updatedAt:emptyRecord.updatedAt,turns:0,status:'ready',current:false}]};
    runInContext('refreshConversations()',context);await tick();historyOverride=null;openBodyFailure=failure;
    historyButton(targetEmpty).fire('click');await tick();assert.equal(session.conversationId,targetEmpty,'synthetic server has already committed the open');
    assert.equal(runInContext('state.expired',context),true);assert.equal(input.value,sourceDraft);
    openBodyFailure='';nodes.get('init-retry').fire('click');await tick();
    assert.equal(runInContext('state.session.conversationId',context),targetEmpty);assert.equal(input.value,'','reconnect restores the target empty history draft only');
    historyButton(sourceCID).fire('click');await tick();assert.equal(input.value,sourceDraft,'lost open body cannot delete or transfer the source conversation draft');
  }
  for(const operation of ['new','settings']){
    const beforeUncertainCID=session.conversationId;
    input.value=operation+'响应丢失后仍保留\n  ';input.fire('input');const mutationDraft=input.value;
    resetBodyFailure='throw';
    if(operation==='new')nodes.get('new-chat').fire('click');
    else{nodes.get('settings-open').fire('click');settingsForm.fire('submit');}
    await tick();const actualNewCID=session.conversationId,uncertainRuntime=session.id,uncertainSettings=structuredClone(session.settings);
    assert.notEqual(actualNewCID,beforeUncertainCID);assert.equal(runInContext('state.session.conversationId',context),beforeUncertainCID);
    assert.equal(input.value,mutationDraft);assert.equal(runInContext('state.expired',context),true);
    resetBodyFailure='';nodes.get('settings-dialog').close();nodes.get('init-retry').fire('click');await tick();
    assert.notEqual(runInContext('state.session.conversationId',context),beforeUncertainCID);assert.equal(input.value,mutationDraft,'an explicitly authorized new/settings mutation keeps its original transfer intent');
    assert.equal(calls.filter(call=>call.path==='/api/chat/session'&&call.body).at(-1).body.sessionId,uncertainRuntime,'an unknown reset target is recreated under the freshly read UUID rather than inferred from GET');
    assert.deepEqual(session.settings,uncertainSettings,'reset recovery preserves the exact requested settings');
    input.value='';input.fire('input');historyButton(beforeUncertainCID).fire('click');await tick();
    assert.equal(input.value,'','recovering a new conversation transfers the draft once without copying it back');
  }
  const unsolicitedSource=session.conversationId;
  input.value='无操作GET不能搬走的原稿\n  ';input.fire('input');const unsolicitedDraft=input.value;recordCurrent();
  session={...session,id:randomUUID(),conversationId:randomUUID(),turns:0};serverMessages=[];
  runInContext('initialize(state.profileId)',context);await tick();assert.equal(input.value,unsolicitedDraft,'an unsolicited GET restores the current accepted conversation and exact draft');
  assert.equal(session.conversationId,unsolicitedSource,'an external empty conversation cannot replace this page current context');
  // A server-accepted first turn counts at start, even when its terminal result never reaches the page.
  nodes.get('new-chat').fire('click');await tick();assert.equal(runInContext('state.session.turns',context),0);
  const firstAcceptedCID=session.conversationId,firstAcceptedRuntime=session.id;
  await send('首轮受理后重启，保留原文\n  ');const firstAccepted=pending.shift(),firstAcceptedStream=openStream();
  firstAccepted.resolve(firstAcceptedStream.response);await tick();
  firstAcceptedStream.write(frame('start',{sessionId:session.id,requestId:firstAccepted.body.requestId,replayed:false}));await tick();
  assert.equal(runInContext('state.session.turns',context),1,'only a non-replayed server start proves acceptance');
  serverMessages=[{id:firstAccepted.body.requestId+':user',role:'user',text:firstAccepted.body.text,status:'pending'}];recordCurrent();
  firstAcceptedStream.fail(new TypeError('network error'));await tick();
  const interruptedRecord=conversations.get(firstAcceptedCID);interruptedRecord.messages=[
    {id:firstAccepted.body.requestId+':user',role:'user',text:firstAccepted.body.text,status:'interrupted'},
    {id:firstAccepted.body.requestId+':assistant',role:'assistant',text:'服务重启，本轮未完成。',status:'interrupted'}];
  interruptedRecord.status='interrupted';interruptedRecord.session.modelAvailable=false;
  interruptedRecord.session.modelUnavailableReason='此对话的模型设置当前不可用或已变化，可查看记录、查询订单或新建对话选择模型。';
  session=null;serverMessages=[];
  const beforeRecoveryMessages=posts().length,beforeRecoveryCreates=calls.filter(call=>call.path==='/api/chat/session'&&call.body).length;
  assert.equal(nodes.get('init-retry').hidden,false);assert.equal(nodes.get('init-retry').textContent,'查看当前记录');nodes.get('init-retry').fire('click');await tick();
  assert.equal(historyPosts().at(-1).body.sessionId,null);assert.equal(historyPosts().at(-1).body.conversationId,firstAcceptedCID);
  assert.equal(session.conversationId,firstAcceptedCID);assert.notEqual(session.id,firstAcceptedRuntime);
  assert.equal(input.value,firstAccepted.body.text);assert.ok(scroller.textContent.includes('服务重启，本轮未完成。'));
  assert.equal(posts().length,beforeRecoveryMessages);assert.equal(calls.filter(call=>call.path==='/api/chat/session'&&call.body).length,beforeRecoveryCreates);
  assert.equal(runInContext('state.failedAttempt',context),null);assert.equal(runInContext('state.session.modelAvailable',context),false,'unavailable original model still permits recovery of saved history');
  for(const status of [404,401,503]){
    session=null;serverMessages=[];openError=status;runInContext('state.expired=true;setBusy(false)',context);
    const beforeMissingCreates=calls.filter(call=>call.path==='/api/chat/session'&&call.body).length;
    assert.equal(nodes.get('new-chat').disabled,true);const blockedExpiredCalls=calls.length;nodes.get('new-chat').fire('click');await tick();assert.equal(calls.length,blockedExpiredCalls);
    assert.equal(nodes.get('init-retry').hidden,false);assert.equal(nodes.get('init-retry').textContent,'重新连接');nodes.get('init-retry').fire('click');await tick();
    assert.equal(runInContext('state.session.conversationId',context),firstAcceptedCID);assert.equal(input.value,firstAccepted.body.text);
    assert.equal(calls.filter(call=>call.path==='/api/chat/session'&&call.body).length,beforeMissingCreates,'failed known-history recovery must not silently create a new context');
    assert.equal(posts().length,beforeRecoveryMessages);
  }
  openError=0;nodes.get('init-retry').fire('click');await tick();assert.equal(session.conversationId,firstAcceptedCID);assert.equal(input.value,firstAccepted.body.text);
  // Round 25: another page's cookie is a fresh CAS precondition, never authority to discard this page's customer or draft.
  const otherRecoveryProfile=originProfile==='demo-a'?'demo-b':'demo-a';
  const startRecoverySource=async(accepted=false)=>{
    input.value='';input.fire('input');nodes.get('settings-dialog').close();
    if(select.value!==originProfile){select.value=originProfile;select.fire('change');await tick();}
    nodes.get('new-chat').fire('click');await tick();
    if(accepted){await send('本页已受理的原会话问题');const turn=pending.shift();turn.resolve(response({sessionId:session.id,requestId:turn.body.requestId,reply:{kind:'answer',text:'原会话可信答复'},durationMs:1,origin:'host'}));await tick();}
    input.value='跨页恢复保留原文\n末尾空格  ';input.fire('input');
    return {id:session.id,cid:session.conversationId,profileId:session.profileId,raw:input.value,settings:structuredClone(session.settings)};
  };
  const otherPageNew=async(profileId)=>{
    const result=await fetch('/api/chat/session',{method:'POST',headers:{'Content-Type':'application/json','X-Chat-Request':'1'},body:JSON.stringify({profileId,sessionId:session.id})});
    assert.equal(result.ok,true);return structuredClone(session);
  };
  const rejectStaleSend=async()=>{
    const originalFetch=context.fetch;
    context.fetch=async(url,options)=>{
      if(String(url)!=='/api/chat/messages/stream')return fetch(url,options);
      calls.push({path:String(url),body:JSON.parse(options.body)});return response({error:'旧页面已失效'},401);
    };
    try{form.fire('submit');await tick();}finally{context.fetch=originalFetch;}
    assert.equal(runInContext('state.expired',context),true);
  };
  for(const scenario of ['empty-same','empty-other','accepted','unknown-start','unknown-hidden','busy-same','busy-other','list503','list-bad','get-bad','cas-create','cas-open']){
    const original=await startRecoverySource(['accepted','cas-open'].includes(scenario));
    if(scenario.startsWith('unknown')){
      form.fire('submit');await tick();const attempt=pending.shift(),beforeStart=openStream();attempt.resolve(beforeStart.response);await tick();
      serverMessages=[{id:attempt.body.requestId+':user',role:'user',text:original.raw,status:'interrupted'},{id:attempt.body.requestId+':assistant',role:'assistant',text:'已受理但未完成，不自动重发',status:'interrupted'}];recordCurrent();
      historyError=503;beforeStart.fail(new TypeError('network error'));await tick();historyError=0;
      assert.equal(runInContext('state.session.turns',context),0);assert.equal(runInContext('state.failedAttempt.mayBeAccepted',context),true);
    }
    const previousFailure=runInContext('state.failedAttempt',context),external=await otherPageNew(scenario.endsWith('other')?otherRecoveryProfile:original.profileId);
    await rejectStaleSend();
    assert.equal(runInContext('state.failedAttempt.mayBeAccepted',context),scenario.startsWith('unknown'),'same-UUID rejection cannot downgrade a possibly accepted first attempt');
    if(previousFailure)assert.equal(runInContext('state.failedAttempt.requestId',context),previousFailure.requestId);
    const preserved=runInContext('({session:state.session,messages:state.messages,profileId:state.profileId,failedAttempt:state.failedAttempt,pendingTurn:state.pendingTurn})',context);
    if(scenario.startsWith('busy')){session.busy=true;recordCurrent();}
    if(scenario==='list503')historyError=503;
    if(scenario==='list-bad')historyOverride={limit:100,conversations:[{id:original.cid,profileId:original.profileId,turns:1,status:'ready'}]};
    if(scenario==='get-bad')sessionReadOverride={session:{...external,id:'invalid'},messages:[]};
    if(scenario==='unknown-hidden'){historyOverride={limit:100,conversations:[]};openError=404;}
    if(scenario==='cas-create')pauseHistory();if(scenario==='cas-open')pauseOpen();
    const beforeRecovery=calls.length,beforeMutation=calls.filter(call=>call.body).length,beforeSend=posts().length;
    nodes.get('init-retry').focus();nodes.get('init-retry').fire('click');await tick();
    if(scenario==='cas-create'){await otherPageNew(original.profileId);resumeHistory();await tick();}
    if(scenario==='cas-open'){await otherPageNew(original.profileId);resumeOpen();await tick();}
    assert.equal(posts().length,beforeSend,'reconnection never automatically resends a question');
    const blocked=['unknown-hidden','busy-same','busy-other','list503','list-bad','get-bad','cas-create','cas-open'].includes(scenario);
    if(blocked){
      for(const key of Object.keys(preserved))assert.ok(runInContext('state.'+key,context)===preserved[key],`${scenario} preserves this page ${key}`);
      assert.equal(input.value,original.raw);assert.equal(select.value,original.profileId);assert.equal(nodes.get('init-retry').hidden,false);assert.equal(nodes.get('init-retry').disabled,false);
      const extra=scenario.startsWith('cas-')?2:scenario==='unknown-hidden'?1:0;
      assert.equal(calls.filter(call=>call.body).length-beforeMutation,extra,`${scenario} has no automatic creation fallback`);
      if(scenario==='unknown-hidden')assert.equal(historyPosts().at(-1).body.conversationId,original.cid);
      if(scenario.startsWith('busy'))assert.match(nodes.get('app-status').textContent,/其他页面正在处理/);
      if(scenario.startsWith('cas-'))assert.equal(nodes.get('app-status').textContent,'会话已失效，请重新连接');
      historyError=0;historyOverride=null;sessionReadOverride=null;openError=0;session.busy=false;recordCurrent();
      nodes.get('init-retry').fire('click');await tick();
    }
    assert.equal(select.value,original.profileId);assert.equal(input.value,original.raw);assert.equal(runInContext('state.initialized',context),true);
    assert.equal(posts().length,beforeSend);assert.notEqual(session.id,external.id);
    const recovered=calls.slice(beforeRecovery).filter(call=>call.body&&call.path!=='/api/chat/messages/stream').at(-1);
    if(['accepted','unknown-start','unknown-hidden','cas-open'].includes(scenario)){
      assert.equal(session.conversationId,original.cid);assert.equal(recovered.path,'/api/chat/session/open');assert.equal(recovered.body.conversationId,original.cid);
      assert.ok(scroller.textContent.includes(scenario.startsWith('unknown')?'已受理但未完成':'原会话可信答复'));
    }else{assert.notEqual(session.conversationId,original.cid);assert.equal(recovered.path,'/api/chat/session');}
  }
  for(const operation of ['open','new','settings','profile']){
    const original=await startRecoverySource(true);let intendedCID=null;
    if(operation==='open'){
      intendedCID=seedConversation('明确选择的会话',[{id:randomUUID()+':user',role:'user',text:'明确选择的会话'},{id:randomUUID()+':assistant',role:'assistant',text:'目标会话答复',reply:{kind:'answer',text:'目标会话答复'}}]);
      runInContext('refreshConversations()',context);await tick();openBodyFailure='throw';historyButton(intendedCID).fire('click');await tick();openBodyFailure='';
    }else{
      resetBodyFailure='throw';
      if(operation==='settings'){nodes.get('settings-open').fire('click');modelSelect.value='deepseek-v4-pro';modelSelect.fire('change');thinkingSelect.value='high';tokensSelect.value='512';settingsForm.fire('submit');}
      else if(operation==='profile'){
        select.value=otherRecoveryProfile;select.fire('change');profileDialog.close('cancel');await tick();assert.equal(input.value,original.raw);assert.equal(session.id,original.id);
        select.value=otherRecoveryProfile;select.fire('change');profileDialog.close('switch');
      }else nodes.get('new-chat').fire('click');
      await tick();resetBodyFailure='';
    }
    assert.equal(runInContext('state.expired',context),true,`${operation} response loss reaches recovery: ${nodes.get('app-status').textContent}`);assert.equal(input.value,original.raw);
    const requested=structuredClone(session.settings),intendedProfile=session.profileId;
    const third=await otherPageNew(operation==='new'?otherRecoveryProfile:original.profileId),beforeIntentSends=posts().length;
    nodes.get('settings-dialog').close();
    if(operation==='settings'){
      const untouched=runInContext('({session:state.session,messages:state.messages,profileId:state.profileId,draftTransfer:state.draftTransfer})',context),unavailablePosts=calls.filter(call=>call.body).length;
      models.find(model=>model.id==='deepseek-v4-pro').available=false;resetError=400;nodes.get('init-retry').fire('click');await tick();
      assert.equal(calls.filter(call=>call.body).length,unavailablePosts+1,'unavailable requested settings cannot fall back to another configuration');
      assert.deepEqual(calls.filter(call=>call.body).at(-1).body.settings,requested);assert.equal(input.value,original.raw);assert.equal(posts().length,beforeIntentSends);
      for(const key of Object.keys(untouched))assert.ok(runInContext('state.'+key,context)===untouched[key],`unavailable requested settings preserve ${key}`);
      assert.equal(nodes.get('init-retry').disabled,false);resetError=0;models.find(model=>model.id==='deepseek-v4-pro').available=true;
    }
    const beforeIntentMutations=calls.filter(call=>call.body).length;nodes.get('init-retry').fire('click');await tick();
    assert.equal(posts().length,beforeIntentSends);assert.equal(calls.filter(call=>call.body).length,beforeIntentMutations+1,'explicit recovery performs one CAS mutation without guessing the third page target');
    assert.equal(session.profileId,intendedProfile);assert.deepEqual(session.settings,requested);assert.notEqual(session.id,third.id);
    const action=calls.filter(call=>call.body).at(-1);assert.equal(action.body.sessionId,third.id);
    if(operation==='open'){
      assert.equal(action.path,'/api/chat/session/open');assert.equal(session.conversationId,intendedCID);assert.equal(input.value,'');
      historyButton(original.cid).fire('click');await tick();assert.equal(input.value,original.raw,'explicit open keeps the independent source draft');
    }else{
      assert.equal(action.path,'/api/chat/session');assert.equal(input.value,operation==='profile'?'':original.raw);
      assert.equal(runInContext('conversationDrafts.has("'+original.profileId+':'+original.cid+'")',context),false,'reset transfers or confirmed profile clears the source draft once');
    }
  }
  assert.equal(runInContext('conversationDrafts.size',context),0);
  const emptyMapPrompts=confirmations();select.value=originProfile;select.fire('change');await tick();
  assert.equal(confirmations(),emptyMapPrompts,'genuinely empty page drafts retain direct customer switching');
  historyButton(historyCID).fire('click');await tick();
  const consentDraft='已受理会话中的独立问题\n  ',consentHistory=structuredClone(serverMessages);
  input.value=consentDraft;input.fire('input');historyButton(interruptedCID).fire('click');await tick();assert.equal(input.value,'');
  const consentMap=runInContext('JSON.stringify([...conversationDrafts])',context),consentSends=posts().length;
  select.value=hiddenDraftProfile;select.fire('change');await tick();assert.equal(profileDialog.open,true);
  assert.equal(runInContext('JSON.stringify([...conversationDrafts])',context),consentMap,'opening confirmation does not pre-clear independent drafts');
  profileDialog.close('switch');await tick();assert.equal(select.value,hiddenDraftProfile);assert.equal(runInContext('conversationDrafts.size',context),0);
  assert.equal(posts().length,consentSends,'confirmed customer switching never submits the discarded question');
  select.value=originProfile;select.fire('change');await tick();historyButton(historyCID).fire('click');await tick();
  assert.equal(input.value,'','explicit customer-switch consent clears drafts in other conversations');assert.deepEqual(serverMessages,consentHistory,'discarding drafts preserves all accepted history messages');
  console.log('PASS web chat UI: actual app + synthetic SSE; stable history/pending DOM, trusted Reply, raw drafts/UUID retry, IME/scroll/focus/selection/generation guards; native customer/history/settings dialogs, failed mobile history recovery, controlled capacity429, exact settings/customer contracts; durable history/open/accepted-start/20th EOF/read recovery; multitab same/cross-profile draft restoration, fresh UUID CAS, strict GET/list failure and busy zero-mutation, monotonic uncertain acceptance/no-create fallback, explicit open/reset/settings/profile intent versus third-page changes/unavailable requested settings; all-conversation draft consent on evaluation navigation and customer switching; 0 business model/DB/QQ.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkWebChatUI();
