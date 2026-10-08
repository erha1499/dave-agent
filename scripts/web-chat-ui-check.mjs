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
const profile = id => ({ id, label: `客户 ${id}`, orderHints: [id === 'demo-a' ? 'COUPON-1001' : 'COUPON-1002'], examples: ['查询到账 银行卡'] });
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
  return { response, write: text => controller.enqueue(new TextEncoder().encode(text)), close: () => controller.close() };
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
  const ids = ['profile-select', 'new-chat', 'app-status', 'init-retry', 'chat-messages', 'chat-empty', 'starter-list', 'chat-form', 'chat-input', 'char-count', 'send-button', 'order-hints',
    'eval-link', 'chat-settings', 'settings-form', 'model-select', 'thinking-select', 'tokens-select', 'apply-settings', 'settings-status', 'active-settings'];
  const html = await readFile(new URL('../web/chat/index.html', import.meta.url), 'utf8');
  const stylesheets = [...html.matchAll(/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/g)].map(match => match[1]);
  assert.equal(stylesheets[0], '/ui.css', 'chat must load the actual evaluation theme first');
  assert.ok(stylesheets.length === 2 && /^(?:\.\/|\/)?style\.css$/.test(stylesheets[1]), 'only the shared theme and local chat layout stylesheet are loaded');
  assert.doesNotMatch(html, /target=["']_blank["']|模拟数据|演示客户/, 'ordinary chat chrome uses product language and same-tab navigation');
  const evaluationHtml = await readFile(new URL('../web/evaluation/index.html', import.meta.url), 'utf8');
  const mainNavigation = evaluationHtml.match(/<nav\b[^>]*aria-label=["']主导航["'][^>]*>[\s\S]*?<\/nav>/)?.[0];
  assert.ok(mainNavigation, 'evaluation retains the same top-level product navigation');
  assert.match(mainNavigation, /href=["']\/chat["'][^>]*>客服问答<\/a>/, 'evaluation exposes a fixed return path');
  assert.match(mainNavigation, /<a\b[^>]*aria-current=["']page["'][^>]*>评测工作台<\/a>/, 'evaluation marks the current product page');
  assert.doesNotMatch(mainNavigation, /target=["']_blank["']/);
  for (const id of ids) assert.equal([...html.matchAll(new RegExp(`\\bid=["']${id}["']`, 'g'))].length, 1, `actual HTML must bind ${id} exactly once`);
  for (const [tag, id] of [['form', 'chat-form'], ['form', 'settings-form'], ['textarea', 'chat-input'],
    ['select', 'profile-select'], ['select', 'model-select'], ['select', 'thinking-select'], ['select', 'tokens-select']])
    assert.match(html, new RegExp(`<${tag}\\b[^>]*\\bid=["']${id}["']`), `${id} must keep its native semantics`);
  for (const id of ['chat-input', 'profile-select', 'model-select', 'thinking-select', 'tokens-select'])
    assert.match(html, new RegExp(`<label\\b[^>]*\\bfor=["']${id}["']`), `${id} must retain an accessible label`);
  const nodes = new Map(ids.map(id => [id, Object.assign(new Element(id === 'chat-input' ? 'textarea' : id.endsWith('-select') ? 'select' : 'div'), { id })]));
  nodes.get('chat-messages').append(nodes.get('chat-empty'));
  nodes.get('chat-empty').append(nodes.get('starter-list'));
  new Element('details').append(nodes.get('order-hints'));
  const docEvents = new Map(), windowEvents = new Map(), pending = [], calls = [];
  let navigationReloads = 0;
  let session = null, resetError = 0, serverMessages = [];
  const fetch = async (url, options = {}) => {
    const path = String(url), body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, body });
    if (body) { assert.equal(new Headers(options.headers).get('X-Chat-Request'), '1'); assert.equal(new Headers(options.headers).get('Content-Type'), 'application/json'); }
    if (path === '/api/chat/config') return response(config);
    if (path === '/api/chat/session' && body === undefined) return response({ session, messages: serverMessages });
    if (path === '/api/chat/session') {
      assert.ok(Object.hasOwn(body, 'sessionId'), 'creation/reset always declares UUID or null');
      if (body.sessionId !== (session?.id ?? null)) return response({ error: '页面会话已失效，请重新连接。' }, 401);
      if (resetError) return response({ error: '当前消息仍在处理中' }, resetError);
      const settings = body.settings ?? defaults;
      const selected = models.find(model => model.id === settings.modelSelection);
      serverMessages = [];
      session = { id: randomUUID(), profileId: body.profileId, label: profile(body.profileId).label,
        settings: structuredClone(settings), model: { provider: selected.provider, id: selected.modelId } };
      return response({ session, messages: [] });
    }
    assert.equal(path, '/api/chat/messages/stream');
    assert.equal(body.sessionId, session.id, 'every message declares the page session before HTTP execution');
    return new Promise((resolve, reject) => pending.push({ body, resolve, reject })).then(async res => {
      if (!res.ok || res instanceof Response) return res;
      const result = await res.json();
      return streamResponse(frame('start', { sessionId: result.sessionId, requestId: result.requestId, replayed: false }, '\r\n')
        + frame('result', result, '\r\n'));
    });
  };
  const document = { getElementById: id => nodes.get(id), createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element(), { textContent: text }),
    querySelector: selector => nodes.get(selector.replace(/^#/, '')), addEventListener: (name, fn) => docEvents.set(name, fn), readyState: 'complete' };
  const context = createContext({ document, fetch, crypto: { randomUUID }, console, Headers, Response, ReadableStream, TextDecoder, TextEncoder, URL, AbortController, setTimeout, clearTimeout, structuredClone,
    window: { addEventListener: (name, fn) => windowEvents.set(name, fn), innerWidth: 1440,
      location: { origin: 'http://127.0.0.1:3002', reload: () => { navigationReloads++; } } } });
  const source = await readFile(new URL('../web/chat/app.js', import.meta.url), 'utf8');
  runInContext(source, context); docEvents.get('DOMContentLoaded')?.(); await tick();
  for (const invalid of [
    { productName: 7 }, { shopName: {} }, { createdAt: false }, { selectionText: 123 }
  ]) {
    context.invalidReply = { kind: 'order', text: '错误卡片', orders: [{ id: 'COUPON-1', status: 'paid', paidCents: 1, refundedCents: 0, couponStatuses: [], ...invalid }] };
    assert.equal(runInContext('validateReply(invalidReply)', context), false, 'optional order fields retain type validation');
  }
  context.invalidReply = { kind: 'order', text: '', orders: [], hasMore: 'yes' };
  assert.equal(runInContext('validateReply(invalidReply)', context), false, 'truncation flag must be boolean');
  const input = nodes.get('chat-input'), form = nodes.get('chat-form'), select = nodes.get('profile-select');
  assert.equal(select.value, 'demo-a'); assert.equal(input.disabled, false);
  const posts = () => calls.filter(call => call.path === '/api/chat/messages/stream');
  const send = async text => { input.value = text; input.fire('input'); form.fire('submit'); await tick(); };
  nodes.get('starter-list').querySelector('.starter-button').fire('click'); await tick();
  assert.equal(input.value, '查询到账 银行卡'); assert.equal(posts().length, 0, 'examples only fill the composer');
  await send(' '.repeat(2)); await send('字'.repeat(2001)); assert.equal(posts().length, 0, 'invalid drafts do not send');
  const draft = '查询到账 银行卡 ';
  await send(draft); assert.equal(posts().length, 1); assert.equal(select.disabled, true);
  let preventedNavigation = false;
  nodes.get('eval-link').fire('click', { preventDefault: () => { preventedNavigation = true; } });
  assert.equal(preventedNavigation, true, 'in-flight chat does not lose its active page through the evaluation link');
  assert.equal(nodes.get('eval-link').getAttribute('aria-disabled'), 'true');
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
  session = null; // The actual server invalidates the failed conversation before returning 503.
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

  const external = { ...session, id: randomUUID(), profileId: 'demo-a', label: '客户 demo-a' };
  session = external; input.value = '旧客户 B 草稿'; input.fire('input');
  const creationsBefore = calls.filter(call => call.path === '/api/chat/session' && call.body).length;
  nodes.get('new-chat').fire('click'); await tick();
  assert.equal(session.id, external.id, 'stale reset never deletes the external replacement');
  assert.equal(input.value, '旧客户 B 草稿', 'rejected reset retains the old draft');
  nodes.get('init-retry').fire('click'); await tick();
  assert.equal(session.id, external.id); assert.equal(select.value, 'demo-a'); assert.equal(input.value, '', 'reconnecting a different customer clears the old draft');
  assert.equal(calls.filter(call => call.path === '/api/chat/session' && call.body).length, creationsBefore + 1,
    'reconnect adopts the existing session through GET without another reset POST');

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
  await send('配置恢复检查'); const settingsFailure = pending.shift();
  session = null; settingsFailure.resolve(response({ error: '本轮未能完成，会话已清空。' }, 503)); await tick();
  nodes.get('init-retry').fire('click'); await tick();
  assert.deepEqual(session.settings, applied, '503 reconnect preserves the actually applied settings');
  assert.equal(input.value, '配置恢复检查', 'same-customer reconnect keeps the failed draft');
  models[0].available = false;
  session = { id: randomUUID(), profileId: 'demo-a', label: profile('demo-a').label, settings: structuredClone(defaults), model: { provider: 'deepseek', id: 'deepseek-flash' } };
  runInContext('initialize()', context); await tick();
  assert.equal(input.disabled, false, 'missing default model key must preserve host-only chat');
  nodes.get('new-chat').fire('click'); await tick();
  assert.equal(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, undefined, 'unavailable default resets use the compatible default route');
  select.value = 'demo-b'; select.fire('change'); await tick();
  assert.equal(select.value, 'demo-b'); assert.equal(calls.filter(call => call.path === '/api/chat/session' && call.body).at(-1).body.settings, undefined);
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
  await send('我有哪些订单');
  const streamed = pending.shift(), transport = openStream();
  const correlation = { sessionId: session.id, requestId: streamed.body.requestId };
  streamed.resolve(transport.response); await tick();
  transport.write(frame('start', { ...correlation, replayed: false }, '\r\n'));
  transport.write(frame('step', { ...correlation, id: 'tool-1', label: '查询最近订单', status: 'running' }));
  transport.write(frame('delta', { ...correlation, messageId: 'assistant-1', text: '正在核对这些订单' })); await tick();
  assert.ok(nodes.get('chat-messages').textContent.includes('查询最近订单'), 'real public steps appear before result');
  assert.ok(nodes.get('chat-messages').textContent.includes('正在核对这些订单'), 'real deltas are visible before the terminal frame');
  assert.equal(input.disabled, true, 'the composer remains locked throughout streaming');
  transport.write(frame('delta', { ...correlation, messageId: 'assistant-2', text: '新的答复草稿 <img src=x>' })); await tick();
  assert.ok(!nodes.get('chat-messages').textContent.includes('正在核对这些订单'), 'a new assistant message replaces the previous tool-loop draft');
  assert.ok(nodes.get('chat-messages').textContent.includes('新的答复草稿 <img src=x>'), 'streamed content is safe plain text');
  transport.write(frame('step', { ...correlation, id: 'tool-1', label: '查询最近订单', status: 'done' }));
  const recentReply = { kind: 'order', text: '这是你的最近订单。', hasMore: true, orders: [
    { id: 'COUPON-1001', status: 'paid', paidCents: 9800, refundedCents: 0, couponStatuses: ['unused'],
      productName: '<script>双人套餐</script>', shopName: '青禾餐厅', createdAt: '2026-10-09T00:00:00Z', selectionText: '选择订单 COUPON-1001' }
  ] };
  transport.write(frame('result', { ...correlation, reply: recentReply, durationMs: 5, origin: 'agent', steps: [{ id: 'tool-1', label: '查询最近订单', status: 'done' }]  })); transport.close(); await tick();
  const messages = nodes.get('chat-messages');
  assert.ok(!messages.textContent.includes('新的答复草稿'), 'final Reply supersedes draft prose');
  assert.ok(messages.textContent.includes('<script>双人套餐</script>')); assert.ok(messages.textContent.includes('青禾餐厅'));
  assert.ok(messages.textContent.includes('当前展示最近3笔'), 'truncation is explicit rather than claiming all orders');
  const selectionButton = walk(messages).find(node => node.tagName === 'BUTTON' && node.textContent === '选择这笔订单');
  assert.ok(selectionButton, 'trusted selectionText produces an actionable order card');
  const countBeforeSelection = posts().length;
  selectionButton.fire('click'); await tick();
  assert.equal(posts().length, countBeforeSelection + 1, 'order selection continues without a second send click');
  const selected = pending.shift(); assert.equal(selected.body.text, '选择订单 COUPON-1001');
  selectionButton.fire('click'); await tick(); assert.equal(posts().length, countBeforeSelection + 1, 'busy card clicks cannot duplicate a turn');
  selected.resolve(response({ sessionId: session.id, requestId: selected.body.requestId,
    reply: { kind: 'notice', text: '已选中，继续核对退款规则。' }, durationMs: 1, origin: 'host' })); await tick();

  await send('断流原文 ');
  const cut = pending.shift(), partial = openStream(), partialCorrelation = { sessionId: session.id, requestId: cut.body.requestId };
  cut.resolve(partial.response); await tick();
  partial.write(frame('start', { ...partialCorrelation, replayed: false }));
  partial.write(frame('delta', { ...partialCorrelation, messageId: 'assistant-1', text: '未完成草稿' })); partial.close(); await tick();
  assert.equal(input.value, '断流原文 ', 'EOF without result preserves the exact draft');
  assert.ok(nodes.get('app-status').classList.contains('error'), 'EOF without terminal result is a visible failure');
  await send('断流原文 '); const cutRetry = pending.shift();
  assert.equal(cutRetry.body.requestId, cut.body.requestId, 'partial stream retry retains request UUID');
  const replayResult = { ...partialCorrelation, reply: { kind: 'answer', text: '回放的实际回复' }, durationMs: 1, origin: 'host' };
  const multilineResult = 'event: result\n' + JSON.stringify(replayResult, null, 2).split('\n').map(line => 'data: ' + line).join('\n') + '\n\n';
  cutRetry.resolve(streamResponse(frame('start', { ...partialCorrelation, replayed: true }) + multilineResult));
  await tick(); assert.equal(input.value, '');
  assert.equal(walk(nodes.get('chat-messages')).filter(node => node.className.split(' ').includes('message-text') && node.textContent === '断流原文 ').length, 1,
    'retry replaces the provisional attempt instead of duplicating the user message');

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
  nodes.get('init-retry').fire('click'); await tick(); assert.equal(input.value, 'SSE业务故障');

  serverMessages = [{ id: randomUUID(), role: 'assistant', text: '恢复的回复', reply: { kind: 'answer', text: '恢复的回复' },
    steps: [{ id: 'history-step', label: '查阅服务规则', status: 'done' }] }];
  runInContext('initialize()', context); await tick();
  assert.ok(walk(nodes.get('chat-messages')).some(node => node.tagName === 'DETAILS' && node.textContent.includes('查阅服务规则')),
    'refresh restores public steps in a collapsible history trace');
  assert.ok(windowEvents.has('pageshow'), 'BFCache restoration must recheck the server session');
  windowEvents.get('pageshow')({ persisted: false });
  assert.equal(navigationReloads, 0, 'normal page loads do not reload in a loop');
  windowEvents.get('pageshow')({ persisted: true });
  assert.equal(navigationReloads, 1, 'restored DOM is not accepted as current identity or model state');
  console.log('PASS web chat UI: actual app + synthetic SSE; split UTF-8/CRLF/multiline frames, live public steps/deltas, final/history Reply, selection continuation, EOF/UUID replay, 503 and identity isolation; original raw draft/busy/IME/settings/navigation guards; 0 business model/DB/QQ.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkWebChatUI();
