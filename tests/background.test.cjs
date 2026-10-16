const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function setup() {
    const hooks = {};
    const menus = [];
    const messages = [];
    const state = { key: 'test:fx', settings: {}, activeId: 7, captures: 0, downloads: [], rules: [], fetches: [] };
    const context = vm.createContext({
        console, TextEncoder, AbortController, setTimeout, clearTimeout,
        fetch: async (url, options) => {
            state.fetches.push({ url, headers: options.headers, body: JSON.parse(options.body) });
            if (url.endsWith('/chat/completions')) {
                return { ok: true, json: async () => ({ choices: [{ message: { content: '细节决定成败。' } }], usage: { cost: 0.000012, total_tokens: 60 } }) };
            }
            return { ok: true, json: async () => ({ translations: JSON.parse(options.body).text.map(text => ({ text: `译文：${text}` })) }) };
        },
        chrome: {
            runtime: {
                id: 'test-extension-id',
                onInstalled: { addListener: fn => { hooks.install = fn; } },
                onMessage: { addListener: fn => { hooks.message = fn; } }
            },
            storage: {
                sync: { get: async () => ({ deeplApiKey: state.key, ...state.settings }) },
                onChanged: { addListener: fn => { hooks.storage = fn; } }
            },
            contextMenus: {
                removeAll: done => done(), create: item => menus.push(item),
                onClicked: { addListener: fn => { hooks.click = fn; } }
            },
            tabs: {
                sendMessage: async (id, message, options) => { messages.push({ id, message, options }); },
                get: async id => ({ id, windowId: 1 }),
                query: async () => [{ id: state.activeId }],
                captureVisibleTab: async () => { state.captures++; return 'data:image/png;base64,capture'; }
            },
            downloads: { download: (options, done) => { state.downloads.push(options); done(1); } },
            action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
            declarativeNetRequest: { updateDynamicRules: async ({ addRules }) => { state.rules = addRules; } }
        }
    });
    context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
    vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
    const dispatch = (message, sender = {}) => new Promise(resolve => hooks.message(message, sender, resolve));
    return { state, hooks, menus, messages, dispatch };
}

test('右键入口和 iframe 定向路由', async () => {
    const { hooks, menus, messages, state } = setup();
    hooks.install();
    assert.equal(menus.length, 6);
    await new Promise(resolve => setImmediate(resolve));
    const [rule] = state.rules;
    assert.deepEqual(Array.from(rule.condition.initiatorDomains), ['test-extension-id'], '只改本插件自己的请求');
    assert.deepEqual(Array.from(rule.condition.requestDomains), ['127.0.0.1', 'localhost']);
    assert.equal(rule.action.requestHeaders[0].header, 'origin');
    await hooks.click({ menuItemId: 'translateWithDeepL', selectionText: 'Hello', frameId: 4 }, { id: 7 });
    await hooks.click({ menuItemId: 'translateBilingualPageWithDeepL', frameId: 4 }, { id: 7 });
    await hooks.click({ menuItemId: 'restorePageWithDeepL' }, { id: 7 });
    await hooks.click({ menuItemId: 'captureXTweetScreenshot' }, { id: 7 });
    assert.equal(messages[0].options.frameId, 4);
    assert.equal(messages[1].message.mode, 'bilingual');
    assert.equal(Object.keys(messages[1].options).length, 0);
    assert.equal(messages[2].message.action, 'restoreFullPage');
    assert.equal(messages[3].options.frameId, 0);
    await hooks.click({ menuItemId: 'translatePageWithDeepL' }, null);
    assert.equal(messages.length, 4);
});

test('整页截图只与顶层页面通信，页面无响应时报告错误', async () => {
    const { hooks, messages, dispatch } = setup();
    const warn = console.warn;
    console.warn = () => {};
    try {
        await hooks.click({ menuItemId: 'capturePageScreenshot', frameId: 3 }, { id: 7, windowId: 1 });
    } finally {
        console.warn = warn;
    }
    assert.deepEqual({ ...messages[0].message }, { action: 'pageCapture', step: 'prepare' });
    assert.equal(messages[0].options.frameId, 0);
    const response = await dispatch({ action: 'capturePage', tabId: 7 });
    assert.equal(response.success, false);
    assert.match(response.error, /页面没有响应/);
});

test('后台读取凭证，兼容单条和批量翻译并报告缺失Key', async () => {
    const { dispatch, state } = setup();
    const settings = await dispatch({ action: 'getSettings' });
    assert.equal(settings.configured, true);
    assert.equal(settings.apiKey, undefined, '内容脚本不需要获取原始Key');
    assert.equal((await dispatch({ action: 'translate', text: 'Single' })).translation, '译文：Single');
    assert.deepEqual(Array.from((await dispatch({ action: 'translate', text: ['First', 'Second'] })).translations), ['译文：First', '译文：Second']);
    state.key = '';
    const missing = await dispatch({ action: 'translate', text: 'Single' });
    assert.equal(missing.success, false);
    assert.match(missing.error, /API Key/);
});

test('按弹窗保存的引擎翻译，网页请求不能指定引擎，连接测试不走缓存', async () => {
    const { dispatch, state } = setup();
    assert.equal((await dispatch({ action: 'getSettings' })).batchSize, 30);
    state.settings = { translationProvider: 'local' };
    const settings = await dispatch({ action: 'getSettings' });
    assert.deepEqual([settings.provider, settings.configured, settings.batchSize], ['local', true, 8], '本地模型使用默认地址和模型');
    assert.equal((await dispatch({ action: 'translate', text: 'Hello' })).translation, '细节决定成败。');
    assert.equal(state.fetches[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(state.fetches[0].body.model, 'hf.co/mradermacher/Hunyuan-MT-7B-GGUF:Q5_K_M');
    state.settings = {};
    await dispatch({ action: 'translate', text: 'Page', provider: 'local', localEndpoint: 'http://evil.example' });
    assert.match(state.fetches.at(-1).url, /deepl\.com/, '网页侧请求只能使用已保存的引擎');
    for (let i = 0; i < 2; i++) {
        const tested = await dispatch({ action: 'testModel', provider: 'local', localEndpoint: 'http://127.0.0.1:1234/v1', localModel: 'qwen3' });
        assert.equal(tested.translation, '细节决定成败。');
        assert.equal(typeof tested.elapsed, 'number');
    }
    assert.equal(state.fetches.filter(item => item.url === 'http://127.0.0.1:1234/v1/chat/completions').length, 2, '每次测试都应真实请求');
    state.settings = { translationProvider: 'local', localModel: ' ' };
    assert.equal((await dispatch({ action: 'getSettings' })).configured, false);
    assert.match((await dispatch({ action: 'testModel', provider: 'deepl' })).error, /只能测试/);
});

test('OpenRouter 使用保存的 Key 和模型，连接测试返回花费', async () => {
    const { dispatch, state } = setup();
    state.settings = { translationProvider: 'openrouter' };
    assert.equal((await dispatch({ action: 'getSettings' })).configured, false, '没有 Key 时未配置');
    state.settings = { translationProvider: 'openrouter', openrouterApiKey: 'sk-or-saved' };
    const settings = await dispatch({ action: 'getSettings' });
    assert.deepEqual([settings.provider, settings.configured, settings.batchSize], ['openrouter', true, 8]);
    assert.equal((await dispatch({ action: 'translate', text: 'Hello' })).translation, '细节决定成败。');
    const [request] = state.fetches;
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer sk-or-saved');
    assert.equal(request.body.model, 'tencent/hy-mt2-30b-a3b', '默认用 Hy-MT2-30B');
    const tested = await dispatch({ action: 'testModel', provider: 'openrouter', openrouterApiKey: 'sk-or-unsaved', openrouterModel: 'qwen/qwen3.8-flash' });
    assert.equal(tested.cost, 0.000012);
    const last = state.fetches.at(-1);
    assert.equal(last.headers.Authorization, 'Bearer sk-or-unsaved', '测试连接使用输入框里的 Key');
    assert.deepEqual({ ...last.body.usage }, { include: true });
});

test('截图仅捕获发起请求的活动标签页，下载校验PNG数据', async () => {
    const { dispatch, state } = setup();
    const sender = { tab: { id: 7, windowId: 1 } };
    const response = await dispatch({ action: 'captureVisibleTab' }, sender);
    assert.equal(response.success, true);
    assert.equal(state.captures, 1);
    state.activeId = 9;
    const switched = await dispatch({ action: 'captureVisibleTab' }, sender);
    assert.equal(switched.success, false);
    assert.equal(state.captures, 1, '不能截图其他活动标签页');
    assert.equal((await dispatch({ action: 'downloadImage', dataUrl: 'https://example.com' })).success, false);
    assert.equal(state.downloads.length, 0);
    const saved = await dispatch({ action: 'downloadImage', dataUrl: response.dataUrl, filename: 'x-post.png' });
    assert.equal(saved.success, true);
    assert.equal(state.downloads[0].saveAs, true);
});
