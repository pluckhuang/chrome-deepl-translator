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
    const state = { key: 'test:fx', activeId: 7, captures: 0, downloads: [] };
    const context = vm.createContext({
        console, TextEncoder, AbortController, setTimeout, clearTimeout,
        fetch: async (_, options) => ({ ok: true, json: async () => ({ translations: JSON.parse(options.body).text.map(text => ({ text: `译文：${text}` })) }) }),
        chrome: {
            runtime: {
                onInstalled: { addListener: fn => { hooks.install = fn; } },
                onMessage: { addListener: fn => { hooks.message = fn; } }
            },
            storage: {
                sync: { get: async () => ({ deeplApiKey: state.key }) },
                onChanged: { addListener: fn => { hooks.storage = fn; } }
            },
            contextMenus: {
                removeAll: done => done(), create: item => menus.push(item),
                onClicked: { addListener: fn => { hooks.click = fn; } }
            },
            tabs: {
                sendMessage: async (id, message, options) => { messages.push({ id, message, options }); },
                query: async () => [{ id: state.activeId }],
                captureVisibleTab: async () => { state.captures++; return 'data:image/png;base64,capture'; }
            },
            downloads: { download: (options, done) => { state.downloads.push(options); done(1); } }
        }
    });
    context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
    vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
    const dispatch = (message, sender = {}) => new Promise(resolve => hooks.message(message, sender, resolve));
    return { state, hooks, menus, messages, dispatch };
}

test('右键入口和 iframe 定向路由', async () => {
    const { hooks, menus, messages } = setup();
    hooks.install();
    assert.equal(menus.length, 5);
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
