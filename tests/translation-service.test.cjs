const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function createService(fetchImpl, options = {}) {
    const context = vm.createContext({ TextEncoder, AbortController, setTimeout, clearTimeout, fetch: fetchImpl });
    for (const file of ['src/shared/core.js', 'src/background/translation-service.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
    }
    return context.DeepL.createTranslationService({ fetchImpl, getApiKey: async () => 'test:fx', ...options });
}
const ok = texts => ({ ok: true, json: async () => ({ translations: texts.map(text => ({ text: `译文：${text}` })) }) });
const turn = () => new Promise(resolve => setImmediate(resolve));

test('清理 Key 后选择免费端点，保持返回顺序并复用重复原文', async () => {
    const requests = [];
    const service = createService(async (url, options) => {
        requests.push({ url, options });
        return ok(JSON.parse(options.body).text);
    });
    const result = await service.translate({ text: ['Hello', 'World', 'Hello'], apiKey: ' test:fx\n\u200b' });
    assert.deepEqual(Array.from(result), ['译文：Hello', '译文：World', '译文：Hello']);
    assert.equal(requests[0].url, 'https://api-free.deepl.com/v2/translate');
    assert.equal(requests[0].options.headers.Authorization, 'DeepL-Auth-Key test:fx');
    await service.translate({ text: 'Hello' });
    assert.equal(requests.length, 1);
    await service.translate({ text: 'Hello', targetLang: 'JA' });
    await service.translate({ text: 'Hello', apiKey: 'other-pro-key' });
    assert.equal(requests.length, 3, '语言和账户应隔离缓存');
});

test('并发相同原文合并为一个请求', async () => {
    let finish;
    let calls = 0;
    const service = createService(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const first = service.translate({ text: 'Concurrent' });
    const second = service.translate({ text: ['Concurrent', 'Concurrent'] });
    await turn();
    assert.equal(calls, 1);
    finish(ok(['Concurrent']));
    assert.deepEqual(Array.from(await first), ['译文：Concurrent']);
    assert.deepEqual(Array.from(await second), ['译文：Concurrent', '译文：Concurrent']);
});

test('请求数量与UTF-8字节数分批，限制并发', async () => {
    let active = 0;
    let maximum = 0;
    const requests = [];
    const service = createService(async (_, options) => {
        requests.push(JSON.parse(options.body).text);
        assert.ok(Buffer.byteLength(options.body) <= 120 * 1024);
        maximum = Math.max(maximum, ++active);
        await turn();
        active--;
        return ok(JSON.parse(options.body).text);
    });
    await service.translate({ text: Array.from({ length: 65 }, (_, index) => `Text ${index}`) });
    assert.deepEqual(requests.map(batch => batch.length), [30, 30, 5]);
    assert.equal(maximum, 2);
    requests.length = 0;
    await service.translate({ text: ['中'.repeat(30000), '文'.repeat(30000)] });
    assert.equal(requests.length, 2);
    await assert.rejects(service.translate({ text: '中'.repeat(50000) }), /过长/);
});

test('错误和数量不匹配不会进入缓存，失败后可重试', async () => {
    let attempt = 0;
    const service = createService(async () => {
        attempt++;
        if (attempt === 1) return { ok: false, status: 429, json: async () => ({}) };
        if (attempt === 2) return { ok: true, json: async () => ({ translations: [] }) };
        return ok(['Retry']);
    });
    await assert.rejects(service.translate({ text: 'Retry' }), /频繁/);
    await assert.rejects(service.translate({ text: 'Retry' }), /不匹配/);
    await service.translate({ text: 'Retry' });
    assert.equal(attempt, 3);
});

test('超时释放队列，后续任务正常执行', async () => {
    let attempt = 0;
    const service = createService((_, options) => {
        if (++attempt > 1) return Promise.resolve(ok(['Next']));
        return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }, { timeoutMs: 10, concurrency: 1 });
    const first = assert.rejects(service.translate({ text: 'Timeout' }), /超时/);
    const next = service.translate({ text: 'Next' });
    await first;
    assert.deepEqual(Array.from(await next), ['译文：Next']);
});

const chat = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const localSettings = (extra = {}) => ({ getSettings: async () => ({ deeplApiKey: 'test:fx', translationProvider: 'local', ...extra }) });

test('本地模型逐段请求、串行执行，按模型选择提示词并去掉思考内容', async () => {
    let active = 0;
    let maximum = 0;
    const requests = [];
    const service = createService(async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push({ url, body });
        maximum = Math.max(maximum, ++active);
        await turn();
        active--;
        return chat(`<think>先想一想</think>\n 译文：${body.messages.at(-1).content.split('\n\n').at(-1)} `);
    }, localSettings());
    const result = await service.translate({ text: ['First', 'Second', 'First'] });
    assert.deepEqual(Array.from(result), ['译文：First', '译文：Second', '译文：First']);
    assert.equal(requests.length, 2, '重复原文只请求一次');
    assert.equal(maximum, 1, '本地模型默认串行');
    assert.equal(requests[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[0].body.messages[0].content, '把下面的文本翻译成中文，不要额外解释。\n\nFirst');
    assert.deepEqual([requests[0].body.temperature, requests[0].body.top_p], [0.7, 0.6], 'Hunyuan-MT 使用官方推荐参数');

    const general = createService(async (_, options) => {
        requests.push({ body: JSON.parse(options.body) });
        return chat('你好');
    }, localSettings({ localEndpoint: 'http://127.0.0.1:1234/v1/', localModel: 'qwen3-8b' }));
    await general.translate({ text: 'Hello', targetLang: 'JA' });
    const { body } = requests.at(-1);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /日语/);
    assert.equal(body.messages[1].content, 'Hello');
    await general.translate({ text: 'Hello', targetLang: 'JA' });
    assert.equal(requests.length, 3, '同一模型命中缓存');
});

test('原文没有括号时去掉本地模型补充的括号说明', async () => {
    const outputs = {
        'The devil is in the details.': '细节决定成败（或：魔鬼藏在细节之中）。',
        "It's not rocket science, really.": '这又不是什么高深的学问（或技术），真的。',
        'See Figure 2 (left).': '请参见图2（左侧）。',
        'Hi': '（你好）'
    };
    const service = createService(async (_, options) => {
        const source = JSON.parse(options.body).messages[0].content.split('\n\n').at(-1);
        return chat(outputs[source]);
    }, localSettings());
    const result = await service.translate({ text: Object.keys(outputs) });
    assert.deepEqual(Array.from(result), ['细节决定成败。', '这又不是什么高深的学问，真的。', '请参见图2（左侧）。', '（你好）']);
});

test('引擎、地址和模型隔离缓存，DeepL 额度用完只提示切换而不自动回退', async () => {
    const settings = { deeplApiKey: 'test:fx', translationProvider: 'deepl' };
    const urls = [];
    const service = createService(async (url, options) => {
        urls.push(url);
        if (url.includes('deepl')) return { ok: false, status: 456, json: async () => ({}) };
        return chat(`${JSON.parse(options.body).model}：你好`);
    }, { getSettings: async () => settings });
    await assert.rejects(service.translate({ text: 'Hello' }), /额度已用完.*切换为本地模型/);
    assert.equal(urls.length, 1);
    assert.ok(urls.every(url => url.includes('deepl')), '额度用完时不能自动改用本地模型');
    settings.translationProvider = 'local';
    assert.equal(await service.translate({ text: 'Hello' }).then(values => values[0]), 'hf.co/mradermacher/Hunyuan-MT-7B-GGUF:Q5_K_M：你好');
    settings.localModel = 'qwen3';
    assert.equal(await service.translate({ text: 'Hello' }).then(values => values[0]), 'qwen3：你好', '换模型后不复用旧译文');
    assert.equal(urls.length, 3);
});

test('本地模型的连接、权限、模型缺失、空结果和超时都有明确提示', async () => {
    const cases = [
        [() => Promise.reject(new TypeError('Failed to fetch')), /无法连接本地模型服务（http:\/\/127\.0\.0\.1:11434\/v1）/],
        [async () => ({ ok: false, status: 403, json: async () => ({}) }), /OLLAMA_ORIGINS/],
        [async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'model not found' } }) }), /ollama pull hf\.co/],
        [async () => ({ ok: false, status: 500, json: async () => ({ error: 'out of memory' }) }), /本地模型出错：out of memory/],
        [async () => chat('<think>只有思考</think>'), /没有返回译文/]
    ];
    for (const [fetchImpl, message] of cases) {
        await assert.rejects(createService(fetchImpl, localSettings()).translate({ text: 'Hello' }), message);
    }
    const slow = createService((_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))),
        { ...localSettings(), localTimeoutMs: 10 });
    await assert.rejects(slow.translate({ text: 'Hello' }), /本地模型响应超时/);
    await assert.rejects(createService(async () => chat('x'), localSettings({ localEndpoint: 'ftp://host' })).translate({ text: 'Hello' }), /服务地址/);
});

test('缓存容量有界，最近访问的记录被保留', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(root, 'src/shared/core.js'), 'utf8'), context);
    const cache = new context.DeepL.TextCache(2, 10);
    cache.set('a', '1'); cache.set('b', '2'); cache.get('a'); cache.set('c', '3');
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), '1');
    cache.set('large', 'too large');
    assert.equal(cache.get('large'), undefined);
    cache.clear();
    assert.equal(cache.chars, 0);
});

test('manifest 和 popup 引用的脚本均存在且语法正确', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const scripts = new Set([manifest.background.service_worker, ...manifest.content_scripts.flatMap(script => script.js)]);
    const popup = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
    for (const match of popup.matchAll(/<script src="([^"]+)"/g)) scripts.add(match[1]);
    for (const script of scripts) new vm.Script(fs.readFileSync(path.join(root, script), 'utf8'), { filename: script });
});
