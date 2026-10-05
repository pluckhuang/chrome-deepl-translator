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
