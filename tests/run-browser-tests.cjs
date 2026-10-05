// Node 22+ 的 WebSocket 连接独立 Chrome；按真实帧率等待 UI，不修改页面时钟。
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const chrome = process.env.CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const pages = process.argv.slice(2);
if (!pages.length) pages.push('full-page-translation.html', 'content-features.html', 'popup.html');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect(url) {
    const socket = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') console.error('Browser error:', message.params.exceptionDetails);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
    });
    return {
        send(method, params = {}) {
            return new Promise((resolve, reject) => {
                const requestId = ++id;
                const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
                pending.set(requestId, { resolve, reject, timer });
                socket.send(JSON.stringify({ id: requestId, method, params }));
            });
        },
        close() { socket.close(); }
    };
}

(async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'deepl-browser-'));
    const browser = spawn(chrome, ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run',
        '--no-default-browser-check', `--user-data-dir=${temp}/profile`, '--remote-debugging-port=0',
        '--allow-file-access-from-files', '--window-size=1000,800', 'about:blank'], { stdio: 'ignore' });
    let client;
    let launchError;
    browser.on('error', error => { launchError = error; });
    try {
        let port;
        for (let i = 0; i < 100; i++) {
            if (launchError) throw launchError;
            try { port = (await fs.readFile(path.join(temp, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
            catch { await delay(100); }
        }
        assert.ok(port, 'Chrome 启动超时，请设置 CHROME_PATH');
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        client = await connect(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
        await client.send('Runtime.enable');
        await client.send('Page.enable');
        for (const page of pages) {
            await client.send('Page.navigate', { url: pathToFileURL(path.join(__dirname, page)).href });
            let result;
            for (let attempt = 0; attempt < 450; attempt++) {
                const response = await client.send('Runtime.evaluate', {
                    expression: `(() => { const e = document.getElementById('deepl-test-results'); return e ? { status: e.dataset.status, text: e.textContent } : null; })()`,
                    returnByValue: true
                });
                result = response.result.value;
                if (result?.status) break;
                await delay(100);
            }
            console.log(`${page}: ${result?.text || '测试未返回结果'}`);
            if (result?.status !== 'passed') {
                const screenshot = await client.send('Page.captureScreenshot');
                const screenshotPath = path.join(os.tmpdir(), `deepl-failed-${page}.png`);
                await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
                throw new Error(`${page} failed; screenshot: ${screenshotPath}`);
            }
        }
    } finally {
        client?.close();
        browser.kill('SIGTERM');
        await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(2000)]);
        if (browser.exitCode === null) browser.kill('SIGKILL');
        await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
