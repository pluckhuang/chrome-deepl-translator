const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// 模拟 1000px 高的视口和 2500px 高的页面；截图宽度是视口的 2 倍（高分屏）。
function setup({ height = 2500, viewport = 1000, captureErrors = [], ...options } = {}) {
    const context = vm.createContext({ console, setTimeout, clearTimeout, URL });
    for (const file of ['src/shared/core.js', 'src/background/page-capture.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
    }
    const state = { steps: [], draws: [], canvases: [], saved: [], progress: [], captures: 0 };
    const createCanvas = (width, canvasHeight) => {
        const canvas = { width, height: canvasHeight, getContext: () => ({
            fillRect() {}, drawImage: (...args) => state.draws.push({ canvas, args })
        }) };
        state.canvases.push(canvas);
        return canvas;
    };
    const service = context.DeepL.createPageCapture({
        sendToTab: async (tabId, message) => {
            state.steps.push(message);
            if (message.step === 'prepare') {
                return { height, rect: { left: 0, top: 0, width: 400, height: viewport }, viewportWidth: 400, title: 'A/B: 测试页', url: 'https://example.com/a' };
            }
            if (message.step === 'scroll') return { y: Math.min(message.y, height - viewport), rect: { left: 0, top: 0, width: 400, height: viewport } };
            return {};
        },
        captureTab: async () => {
            state.captures++;
            const error = captureErrors.shift();
            if (error) throw new Error(error);
            return 'data:image/png;base64,shot';
        },
        decodeImage: async () => ({ width: 800, height: viewport * 2 }),
        encodeImage: async canvas => `data:image/png;base64,${canvas.width}x${canvas.height}`,
        saveImage: async image => { state.saved.push(image); },
        setProgress: (tabId, text) => state.progress.push(text),
        createCanvas, minInterval: 0, ...options
    });
    return { service, state };
}

test('逐屏滚动并按页面坐标拼接，最后一屏只补未覆盖部分', async () => {
    const { service, state } = setup();
    const result = await service.capture({ id: 3 });
    const scrolls = state.steps.filter(step => step.step === 'scroll');
    assert.deepEqual(scrolls.map(({ y, first, last }) => [y, first, last]), [[0, true, false], [1000, false, false], [1500, false, true]]);
    assert.equal(state.canvases[0].width, 800);
    assert.equal(state.canvases[0].height, 5000);
    // [源 y, 源高, 目标 y, 目标高]：第三屏从视口 500px 处开始，只补 2000-2500。
    assert.deepEqual(state.draws.map(({ args }) => [args[2], args[4], args[6], args[8]]), [[0, 2000, 0, 2000], [0, 2000, 2000, 2000], [1000, 1000, 4000, 1000]]);
    assert.deepEqual(state.steps.map(step => step.step), ['prepare', 'scroll', 'scroll', 'scroll', 'restore', 'notify']);
    assert.equal(state.saved.length, 1);
    assert.equal(state.saved[0].dataUrl, 'data:image/png;base64,800x5000');
    assert.match(state.saved[0].filename, /^A B 测试页-\d{4}-\d{2}-\d{2}-\d{6}\.png$/);
    assert.equal(result.truncated, false);
    assert.equal(state.progress.at(-1), '', '结束后清除进度');
});

test('超长页面先降分辨率，仍放不下时截断并提示', async () => {
    const { service, state } = setup({ height: 12000, maxSide: 8000 });
    const result = await service.capture({ id: 3 });
    assert.equal(state.canvases[0].height, 8000, '降到 1 倍后截取前 8000px');
    assert.equal(result.truncated, true);
    assert.equal(result.capturedHeight, 8000);
    assert.equal(state.steps.filter(step => step.step === 'scroll').length, 8);
    assert.equal(state.steps.at(-1).tone, 'warning');
    const scaled = setup({ height: 6000, maxSide: 8000 });
    await scaled.service.capture({ id: 3 });
    assert.equal(scaled.state.canvases[0].height, 8000, '能放下时按比例缩小而不截断');
    assert.equal(scaled.state.canvases[0].width, Math.round(400 * 8000 / 6000));
});

test('限流时重试，失败也恢复页面并允许重新截图', async () => {
    const retry = setup({ captureErrors: ['MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND'] });
    await retry.service.capture({ id: 3 });
    assert.equal(retry.state.captures, 4);
    const { service, state } = setup({ captureErrors: ['截图期间标签页已切换，请重试'] });
    const first = service.capture({ id: 3 });
    await assert.rejects(service.capture({ id: 3 }), /正在截图/);
    await assert.rejects(first, /标签页已切换/);
    assert.deepEqual(state.steps.slice(-2).map(step => step.step), ['restore', 'notify']);
    assert.equal(state.steps.at(-1).tone, 'error');
    assert.equal(state.saved.length, 0);
    await service.capture({ id: 3 });
    assert.equal(state.saved.length, 1, '失败后可以再次截图');
});
