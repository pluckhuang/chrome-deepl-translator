(async () => {
    const fixture = document.getElementById('fixture');
    const results = document.getElementById('deepl-test-results');
    const passed = [];
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async predicate => {
        for (let i = 0; i < 300; i++) {
            if (predicate()) return;
            await wait(10);
        }
        throw new Error('等待页面状态超时');
    };
    const test = async (name, run) => { await run(); passed.push(name); };
    try {
        await test('划词请求去重、关闭与重试、原文标记', async () => {
            fixture.innerHTML = '<p id="selection">Hello selected world.</p>';
            const paragraph = fixture.querySelector('p');
            const range = document.createRange();
            range.selectNodeContents(paragraph);
            let respond;
            translationMock.calls = [];
            translationMock.respond = (_, callback) => { respond = callback; };
            const pending = DeepL.selection.translate(paragraph.textContent, { x: 20, y: 20 }, range);
            await DeepL.selection.translate(paragraph.textContent);
            assert(translationMock.calls.length === 1, '划词重复操作只能发送一次');
            assert(paragraph.querySelectorAll('.deepl-no-select').length === 2, '应保留起止标记');
            document.querySelector('.deepl-close-button').click();
            respond({ success: true, translation: '迟到结果' });
            await pending;
            assert(!document.getElementById('deepl-translation-result'), '关闭后不得重新弹出结果');
            translationMock.respond = null;
            await DeepL.selection.translate('<img src=x onerror=alert(1)>');
            assert(document.getElementById('deepl-translation-result').textContent.includes('<img'), '翻译结果应按文本展示');
            assert(!document.getElementById('deepl-translation-result').querySelector('img'), '不得执行结果HTML');
            DeepL.selection.close();
        });
        await test('X 正文晚加载、增量监听与重复按钮', async () => {
            fixture.innerHTML = '<article data-testid="tweet"></article>';
            await wait(30);
            const tweet = fixture.querySelector('article');
            tweet.innerHTML = '<div data-testid="tweetText" lang="en">Late loaded tweet.</div>';
            await waitFor(() => tweet.querySelector('button'));
            for (let i = 0; i < 20; i++) tweet.appendChild(document.createElement('span'));
            await wait(30);
            assert(tweet.querySelectorAll('.deepl-twitter-translate-button').length === 1, '更新时不能叠加按钮');
            let respond;
            translationMock.calls = [];
            translationMock.respond = (_, callback) => { respond = callback; };
            const button = tweet.querySelector('button');
            button.click(); button.click();
            assert(translationMock.calls.length === 1, 'X 翻译按钮应避免重复请求');
            respond({ success: false, error: '<img src=x> API failed' });
            await waitFor(() => tweet.querySelector('.deepl-twitter-error'));
            assert(!tweet.querySelector('img') && !button.disabled, '错误必须安全显示且能重试');
            translationMock.respond = null;
            button.click();
            await waitFor(() => tweet.querySelector('.deepl-twitter-translation-result'));
            assert(tweet.textContent.includes('译文：Late loaded tweet.'), 'X 翻译应完成');
        });
        await test('X 复用节点后丢弃旧结果，全文功能可同时使用', async () => {
            fixture.innerHTML = '<article data-testid="tweet"><div data-testid="tweetText" lang="en">Old tweet.</div></article>';
            await waitFor(() => fixture.querySelector('button'));
            let respond;
            translationMock.respond = (_, callback) => { respond = callback; };
            fixture.querySelector('button').click();
            fixture.querySelector('[data-testid="tweetText"]').textContent = 'New tweet.';
            await waitFor(() => fixture.querySelector('button')?.textContent.includes('Translate'));
            respond({ success: true, translation: '旧帖子结果' });
            await wait(20);
            assert(!fixture.querySelector('.deepl-twitter-translation-result'), '复用节点不能显示旧译文');
            translationMock.respond = null;
            await DeepL.page.translate('bilingual');
            assert(fixture.querySelectorAll('.deepl-bilingual-translation').length === 1, '全文模块应独立工作');
            await wait(30);
            assert(fixture.querySelectorAll('.deepl-twitter-translate-button').length === 1, '全文译文不能触发X按钮重复生成');
            DeepL.page.restore();
            const textNode = fixture.querySelector('[data-testid="tweetText"]');
            textNode.lang = 'zh';
            await waitFor(() => !fixture.querySelector('.deepl-twitter-translate-button'));
            textNode.lang = 'en';
            await waitFor(() => fixture.querySelector('.deepl-twitter-translate-button'));
        });
        await test('截图多切片拼接、并发保护和页面恢复', async () => {
            fixture.innerHTML = '<div id="overlay" style="position:fixed;top:0;left:0;width:100%;height:20px">Sticky</div>'
                + '<div style="height:150px"></div><div data-testid="cellInnerDiv"><article data-testid="tweet" style="padding:20px;border:1px solid #ccc">'
                + '<div data-testid="tweetText" lang="en">Screenshot tweet.</div>'
                + '<img loading="lazy" width="1" height="1" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">'
                + Array.from({ length: 35 }, (_, i) => `<p>Long tweet content line ${i}.</p>`).join('')
                + '</article></div><div style="height:500px"></div>';
            await waitFor(() => fixture.querySelector('button'));
            document.documentElement.style.scrollBehavior = 'smooth';
            window.scrollTo({ top: 40, behavior: 'instant' });
            const initialScroll = window.scrollY;
            const canvas = document.createElement('canvas');
            canvas.width = innerWidth;
            canvas.height = innerHeight;
            canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
            translationMock.captureCalls = 0;
            translationMock.downloads = [];
            translationMock.capture = callback => callback({ success: true, dataUrl: canvas.toDataURL('image/png') });
            const tweet = fixture.querySelector('article');
            const capture = DeepL.tweetCapture.capture(tweet);
            let concurrentError = '';
            await DeepL.tweetCapture.capture(tweet).catch(error => { concurrentError = error.message; });
            assert(concurrentError.includes('正在截图'), '并发截图应被阻止');
            await capture;
            assert(translationMock.captureCalls >= 2, '长帖应捕获多张切片');
            assert(translationMock.downloads.length === 1, '只应下载一张拼接结果');
            const image = new Image();
            await new Promise((resolve, reject) => {
                image.onload = resolve; image.onerror = reject; image.src = translationMock.downloads[0].dataUrl;
            });
            assert(image.height > innerHeight, '拼接结果应覆盖视口之外的长帖');
            assert(Math.abs(window.scrollY - initialScroll) <= 1, '截图后恢复滚动位置');
            assert(!fixture.querySelector('#overlay').style.visibility, '截图后恢复固定元素');
            assert(tweet.querySelector('img').loading === 'lazy', '截图后恢复图片加载属性');
            assert(!tweet.querySelector('.deepl-twitter-btn-container').style.display, '截图后恢复翻译按钮');
        });
        await test('截图失败仍恢复页面且可重新操作', async () => {
            const initialScroll = window.scrollY;
            translationMock.capture = callback => callback({ success: false, error: '截图失败测试' });
            let error = '';
            await DeepL.tweetCapture.capture(fixture.querySelector('article')).catch(value => { error = value.message; });
            assert(error === '截图失败测试', '应报告捕获错误');
            assert(Math.abs(window.scrollY - initialScroll) <= 1, '失败后也应恢复滚动');
            assert(!fixture.querySelector('#overlay').style.visibility, '失败后恢复固定元素');
            assert(!document.documentElement.style.overflowAnchor, '失败后恢复页面样式');
            assert(document.documentElement.style.scrollBehavior === 'smooth', '应恢复网站原本的平滑滚动设置');
            document.documentElement.style.scrollBehavior = '';
        });
        await test('整页截图逐屏拼接、浮层只出现一次并恢复页面', async () => {
            fixture.innerHTML = '<div id="fixed-top" style="position:fixed;top:0;left:0;width:100%;height:30px;background:#c00">Top</div>'
                + '<div id="fixed-bottom" style="position:fixed;bottom:0;right:0;width:80px;height:30px;transition:visibility 1s">Chat</div>'
                + '<div id="sticky-bar" style="position:sticky;top:0;height:20px">Sticky</div><div style="height:3000px"></div>';
            document.documentElement.style.scrollBehavior = 'smooth';
            window.scrollTo({ top: 300, behavior: 'instant' });
            const initialScroll = window.scrollY;
            const [top, bottom, sticky] = ['fixed-top', 'fixed-bottom', 'sticky-bar'].map(id => document.getElementById(id));
            const slices = [];
            // 模拟截图：每一行像素的颜色编码它在整页中的位置，用来验证拼接没有错位。
            const encode = y => [y % 251, Math.floor(y / 251) % 251];
            const captureTab = async () => {
                const canvas = document.createElement('canvas');
                canvas.width = innerWidth * devicePixelRatio;
                canvas.height = innerHeight * devicePixelRatio;
                const context = canvas.getContext('2d');
                for (let row = 0; row < innerHeight; row++) {
                    const [r, g] = encode(Math.round(window.scrollY) + row);
                    context.fillStyle = `rgb(${r},${g},0)`;
                    context.fillRect(0, row * devicePixelRatio, canvas.width, devicePixelRatio);
                }
                return canvas.toDataURL('image/png');
            };
            const saved = [];
            const options = {
                sendToTab: async (_, message) => {
                    const result = await DeepL.pageCapture.handle(message);
                    if (message.step === 'scroll') {
                        slices.push([top, bottom].map(node => getComputedStyle(node).visibility).concat(getComputedStyle(sticky).position));
                    }
                    return result;
                },
                captureTab, saveImage: async image => { saved.push(image); }, minInterval: 0
            };
            const service = DeepL.createPageCapture(options);
            const capture = service.capture({ id: 1 });
            await assert((await DeepL.createPageCapture(options).capture({ id: 1 }).catch(error => error.message)).includes('正在截图'), '页面侧应阻止并发截图');
            await capture;
            assert(slices.length >= 4, '长页面应逐屏截取');
            assert(slices[0].join() === 'visible,hidden,relative', '第一屏保留顶部浮层，吸顶元素改为普通定位');
            assert(slices[1].join() === 'hidden,hidden,relative', '中间各屏隐藏浮层');
            assert(slices.at(-1).join() === 'hidden,visible,relative', '最后一屏保留底部浮层');
            const image = new Image();
            await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = saved[0].dataUrl; });
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            canvas.getContext('2d').drawImage(image, 0, 0);
            const pixels = canvas.getContext('2d').getImageData(5, 0, 1, image.height).data;
            const scale = image.width / innerWidth;
            assert(image.height >= 3000 * scale, '结果应覆盖整页高度');
            for (let y = 0; y * scale < image.height; y += 7) {
                const index = Math.floor(y * scale) * 4;
                const [r, g] = encode(y);
                assert(pixels[index] === r && pixels[index + 1] === g, `第 ${y}px 拼接错位`);
            }
            assert(Math.abs(window.scrollY - initialScroll) <= 1, '截图后恢复滚动位置');
            assert(!top.style.visibility && !bottom.style.visibility && bottom.style.transition === 'visibility 1s' && sticky.style.position === 'sticky', '截图后恢复浮层样式');
            assert(document.documentElement.style.scrollBehavior === 'smooth' && !document.documentElement.style.scrollbarWidth, '截图后恢复页面样式');
            assert(document.getElementById('deepl-page-capture-toast')?.dataset.tone === 'success', '完成后提示保存');

            options.captureTab = async () => { throw new Error('整页截图失败测试'); };
            const failed = await DeepL.createPageCapture(options).capture({ id: 1 }).catch(error => error.message);
            assert(failed === '整页截图失败测试', '应报告捕获错误');
            assert(Math.abs(window.scrollY - initialScroll) <= 1 && !top.style.visibility && sticky.style.position === 'sticky', '失败后也应恢复页面');
            assert(document.getElementById('deepl-page-capture-toast')?.dataset.tone === 'error', '失败后提示错误');
            document.documentElement.style.scrollBehavior = '';
        });
        results.textContent = `PASS (${passed.length})\n${passed.join('\n')}`;
        results.dataset.status = 'passed';
    } catch (error) {
        results.textContent = `FAIL: ${error.message}\n已通过：${passed.join('、')}`;
        results.dataset.status = 'failed';
        console.error(error);
    }
})();
