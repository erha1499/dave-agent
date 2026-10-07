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
    this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => { const add = force ?? !this.className.split(' ').includes(name); this.classList[add ? 'add' : 'remove'](name); },
      contains: name => this.className.split(' ').includes(name) };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text ?? '') + this.children.map(node => node.textContent).join(''); }
  set innerHTML(value) { assert.equal(value, '', 'dynamic HTML must never be evaluated'); this.replaceChildren(); }
  get innerHTML() { return ''; }
  get parentElement() { return this.parentNode ?? null; }
  get options() { return this.children.filter(node => node.tagName === 'OPTION'); }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { if (typeof node === 'string') { const text = new Element(); text.textContent = node; node = text; } node.parentNode = this; this.children.push(node); return node; }
  replaceChildren(...nodes) { this.text = ''; this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); if (name === 'id') this.id = value; }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  addEventListener(name, fn) { this.events.set(name, fn); }
  focus() {} scrollIntoView() {}
  fire(name, event = {}) { return this.events.get(name)?.({ target: this, currentTarget: this, preventDefault() {}, ...event }); }
  querySelectorAll(selector) { return walk(this).filter(node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : selector.startsWith('#') ? node.id === selector.slice(1) : node.tagName.toLowerCase() === selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const tick = async () => { await setImmediate(); await setImmediate(); };
const profile = id => ({ id, label: `演示客户 ${id}`, orderHints: [id === 'demo-a' ? 'COUPON-1001' : 'COUPON-1002'], examples: ['查询到账 银行卡'] });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
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
  const ids = ['profile-select', 'new-chat', 'app-status', 'init-retry', 'chat-messages', 'chat-empty', 'starter-list', 'chat-form', 'chat-input', 'char-count', 'send-button', 'order-hints',
    'eval-link', 'chat-settings', 'settings-form', 'model-select', 'thinking-select', 'tokens-select', 'apply-settings', 'settings-status', 'active-settings'];
  const nodes = new Map(ids.map(id => [id, Object.assign(new Element(id === 'chat-input' ? 'textarea' : id.endsWith('-select') ? 'select' : 'div'), { id })]));
  nodes.get('chat-messages').append(nodes.get('chat-empty'));
  nodes.get('chat-empty').append(nodes.get('starter-list'));
  new Element('details').append(nodes.get('order-hints'));
  const docEvents = new Map(), pending = [], calls = [];
  let session = null, resetError = 0;
  const fetch = async (url, options = {}) => {
    const path = String(url), body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, body });
    if (body) { assert.equal(new Headers(options.headers).get('X-Chat-Request'), '1'); assert.equal(new Headers(options.headers).get('Content-Type'), 'application/json'); }
    if (path === '/api/chat/config') return response(config);
    if (path === '/api/chat/session' && body === undefined) return response({ session, messages: [] });
    if (path === '/api/chat/session') {
      if (resetError) return response({ error: '当前消息仍在处理中' }, resetError);
      const settings = body.settings ?? defaults;
      const selected = models.find(model => model.id === settings.modelSelection);
      session = { id: randomUUID(), profileId: body.profileId, label: profile(body.profileId).label,
        settings: structuredClone(settings), model: { provider: selected.provider, id: selected.modelId } };
      return response({ session, messages: [] });
    }
    assert.equal(path, '/api/chat/messages');
    return new Promise((resolve, reject) => pending.push({ body, resolve, reject }));
  };
  const document = { getElementById: id => nodes.get(id), createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element(), { textContent: text }),
    querySelector: selector => nodes.get(selector.replace(/^#/, '')), addEventListener: (name, fn) => docEvents.set(name, fn), readyState: 'complete' };
  const context = createContext({ document, fetch, crypto: { randomUUID }, console, Headers, URL, AbortController, setTimeout, clearTimeout, structuredClone,
    window: { addEventListener() {}, innerWidth: 1440, location: { origin: 'http://127.0.0.1:3002' } } });
  const source = await readFile(new URL('../web/chat/app.js', import.meta.url), 'utf8');
  runInContext(source, context); docEvents.get('DOMContentLoaded')?.(); await tick();
  const input = nodes.get('chat-input'), form = nodes.get('chat-form'), select = nodes.get('profile-select');
  assert.equal(select.value, 'demo-a'); assert.equal(input.disabled, false);
  const posts = () => calls.filter(call => call.path === '/api/chat/messages');
  const send = async text => { input.value = text; input.fire('input'); form.fire('submit'); await tick(); };
  nodes.get('starter-list').querySelector('.starter-button').fire('click'); await tick();
  assert.equal(input.value, '查询到账 银行卡'); assert.equal(posts().length, 0, 'examples only fill the composer');
  await send(' '.repeat(2)); await send('字'.repeat(2001)); assert.equal(posts().length, 0, 'invalid drafts do not send');
  const draft = '查询到账 银行卡 ';
  await send(draft); assert.equal(posts().length, 1); assert.equal(select.disabled, true);
  assert.equal(nodes.get('model-select').disabled, true, 'settings cannot change during a turn');
  assert.equal(nodes.get('apply-settings').disabled, true);
  form.fire('submit'); input.fire('keydown', { key: 'Enter', isComposing: true }); await tick(); assert.equal(posts().length, 1);
  const first = pending.shift(), originalId = first.body.requestId;
  assert.equal(first.body.text, draft, 'original text must not be trimmed or normalized');
  first.reject(new TypeError('synthetic network interruption')); await tick(); assert.equal(input.value, draft);
  await send(draft); assert.equal(posts().at(-1).body.requestId, originalId, 'same draft retries the same request instead of another model turn');
  const retry = pending.shift();
  retry.resolve(response({ sessionId: session.id, requestId: originalId, reply: { kind: 'notice', text: '<img src=x onerror=alert(1)> 不能核实', evidenceIds: ['<script>'] }, durationMs: 1, origin: 'host' }));
  await tick();
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
  resetError = 409; select.value = 'demo-b'; select.fire('change'); await tick();
  assert.equal(select.value, 'demo-a'); assert.equal(nodes.get('chat-messages').textContent, old, 'failed identity change must preserve prior conversation');
  resetError = 0; select.value = 'demo-b'; select.fire('change'); await tick();
  assert.equal(select.value, 'demo-b'); assert.ok(!nodes.get('chat-messages').textContent.includes('不能核实'));
  input.value = '查询到账 电子钱包'; input.fire('input'); const before = posts().length;
  input.fire('keydown', { key: 'Enter', isComposing: true }); input.fire('keydown', { key: 'Enter', shiftKey: true }); await tick();
  assert.equal(posts().length, before, 'IME and multiline Enter must not send');
  await send('查询到账 电子钱包'); const stale = pending.shift();
  stale.resolve(response({ sessionId: 'old-session', requestId: stale.body.requestId, reply: { kind: 'answer', text: '旧客户数据' }, durationMs: 1, origin: 'host' }));
  await tick(); assert.ok(!nodes.get('chat-messages').textContent.includes('旧客户数据'), 'mismatched session receipt is not displayed');
  await send('服务故障样例'); const unavailable = pending.shift();
  unavailable.resolve(response({ error: '本轮未能完成，会话已清空。' }, 503)); await tick();
  assert.equal(input.value, '服务故障样例'); const attempts = posts().length;
  form.fire('submit'); await tick(); assert.equal(posts().length, attempts, '503-invalidated context requires a new conversation');
  const invalidId = unavailable.body.requestId;
  nodes.get('init-retry').fire('click'); await tick(); assert.equal(input.value, '服务故障样例');
  form.fire('submit'); await tick(); const recovered = pending.shift();
  assert.notEqual(recovered.body.requestId, invalidId, 'recreated context starts a new request');
  recovered.resolve(response({ sessionId: session.id, requestId: recovered.body.requestId,
    reply: { kind: 'answer', text: '合成恢复结果' }, durationMs: 1, origin: 'host' })); await tick();
  assert.equal(input.value, '');

  const modelSelect = nodes.get('model-select'), thinkingSelect = nodes.get('thinking-select'), tokensSelect = nodes.get('tokens-select');
  const settingsForm = nodes.get('settings-form'), active = nodes.get('active-settings');
  assert.ok(modelSelect.children.find(node => node.value === 'qwen3.7-plus-2026-05-26')?.disabled, 'unconfigured choices are disabled');
  assert.equal(nodes.get('eval-link').getAttribute('href') ?? nodes.get('eval-link').href, config.evaluationUrl);
  assert.ok(active.textContent.includes('deepseek-flash'), 'resolved server model is visible');
  const activeBefore = active.textContent, beforeSession = session.id, historyBefore = nodes.get('chat-messages').textContent;
  input.value = '保留的草稿'; input.fire('input');
  modelSelect.value = 'deepseek-v4-pro'; modelSelect.fire('change');
  thinkingSelect.value = 'high'; thinkingSelect.fire('change'); tokensSelect.value = '512'; tokensSelect.fire('change');
  assert.equal(active.textContent, activeBefore, 'unsaved editor must not replace active settings');
  resetError = 400; settingsForm.fire('submit'); await tick();
  assert.equal(session.id, beforeSession); assert.equal(active.textContent, activeBefore);
  assert.equal(nodes.get('chat-messages').textContent, historyBefore); assert.equal(input.value, '保留的草稿');
  assert.equal(modelSelect.value, 'deepseek-v4-pro'); assert.equal(tokensSelect.value, '512', 'failed settings retain editor draft');
  resetError = 409; settingsForm.fire('submit'); await tick();
  assert.equal(session.id, beforeSession); assert.equal(input.value, '保留的草稿');
  resetError = 0; settingsForm.fire('submit'); await tick();
  assert.notEqual(session.id, beforeSession); assert.equal(input.value, '');
  const applied = { modelSelection: 'deepseek-v4-pro', thinkingLevel: 'high', maxTokens: 512 };
  assert.deepEqual(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, applied);
  assert.ok(active.textContent.includes('deepseek-v4-pro')); assert.ok(active.textContent.includes('512'));
  assert.ok(!nodes.get('chat-messages').textContent.includes('合成恢复结果'), 'successful settings start a clean context');
  modelSelect.value = 'deepseek-flash'; modelSelect.fire('change'); tokensSelect.value = '1024'; tokensSelect.fire('change');
  select.value = 'demo-a'; select.fire('change'); await tick();
  assert.deepEqual(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, applied, 'identity changes use active settings, not unsaved editor');
  runInContext('initialize()', context); await tick();
  assert.equal(modelSelect.value, 'deepseek-v4-pro'); assert.equal(thinkingSelect.value, 'high'); assert.equal(tokensSelect.value, '512', 'refresh restores server snapshot');
  nodes.get('new-chat').fire('click'); await tick();
  assert.deepEqual(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, applied, 'new conversations preserve applied parameters');
  assert.equal(input.disabled, false); assert.equal(nodes.get('chat-messages').textContent.includes('服务故障样例'), false);
  models[0].available = false;
  session = { id: randomUUID(), profileId: 'demo-a', label: profile('demo-a').label, settings: structuredClone(defaults), model: { provider: 'deepseek', id: 'deepseek-flash' } };
  runInContext('initialize()', context); await tick();
  assert.equal(input.disabled, false, 'missing default model key must preserve host-only chat');
  nodes.get('new-chat').fire('click'); await tick();
  assert.equal(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, undefined, 'unavailable default resets use the compatible default route');
  select.value = 'demo-b'; select.fire('change'); await tick();
  assert.equal(select.value, 'demo-b'); assert.equal(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, undefined);
  models[0].available = true;
  config.evaluationUrl = 'https://evil.test/';
  runInContext('initialize()', context); await tick();
  assert.ok(!(nodes.get('eval-link').getAttribute('href') ?? nodes.get('eval-link').href ?? '').includes('evil.test'), 'catalog must not create an external navigation');
  config.evaluationUrl = 'http://127.0.0.1:3001/';
  runInContext('initialize()', context); await tick();
  assert.equal(input.disabled, false);
  console.log('PASS web chat UI: real app code, synthetic HTTP; raw draft/UUID, busy/IME, safe Reply rendering, resets/stale receipts; settings draft vs active, failures, apply/refresh, identity/new-chat snapshot and evaluation link; 0 remote/model/DB/QQ.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkWebChatUI();
