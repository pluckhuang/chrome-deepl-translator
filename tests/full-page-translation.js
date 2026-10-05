// 在独立浏览器中打开 full-page-translation.html；模拟 API，不消耗额度。
(async () => {
    const translateFullPage = DeepL.page.translate;
    const restoreFullPage = DeepL.page.restore;
    const fixture = document.getElementById('fixture');
    const results = document.getElementById('deepl-test-results');
    const passed = [];
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const translations = () => fixture.querySelectorAll('.deepl-bilingual-translation');
    const reset = html => {
        restoreFullPage();
        translationMock.calls = [];
        translationMock.key = 'test-key';
        translationMock.respond = null;
        fixture.innerHTML = html;
    };
    const test = async (name, run) => {
        await run();
        passed.push(name);
    };

    try {
        await test('段落合并、链接交互、换行、列表、表格及过滤', async () => {
            reset('<p id="paragraph">Hello <strong>world</strong>, read <a href="#example">this link</a> today.</p>'
                + '<p>First line.<br>Second line.</p><ul><li>List item.</li></ul><table><tbody><tr><td>Table cell.</td></tr></tbody></table>'
                + '<p><strong>Separate</strong> <em>inline</em> <a href="#words">words.</a></p>'
                + '<div hidden><p>Hidden text.</p></div><div style="display:none"><span>Invisible text.</span></div>'
                + '<pre><span>Code text.</span></pre><textarea>Input text.</textarea><div contenteditable="true"><p>Editable text.</p></div>'
                + '<p translate="no">Untranslated text.</p><div class="deepl-twitter-translation-result">Existing translation.</div>');
            const original = fixture.innerHTML;
            const link = fixture.querySelector('a');
            let clicks = 0;
            link.addEventListener('click', event => { event.preventDefault(); clicks++; });
            await translateFullPage('bilingual');
            assert(translations().length === 5, '应按段落、列表项、表格单元格插入5份译文');
            assert(translationMock.calls.flat().includes('Hello world, read this link today.'), '行内文字应合并为完整段落');
            assert(translationMock.calls.flat().includes('First line.\nSecond line.'), '应保留 br 换行');
            assert(translationMock.calls.flat().includes('Separate inline words.'), '应保留行内元素之间的空格');
            assert(fixture.querySelector('a') === link, '应保留链接节点');
            link.click();
            assert(clicks === 1, '链接事件应继续工作');
            assert(getComputedStyle(translations()[0]).display === 'block', '译文应独立成行');
            restoreFullPage();
            assert(fixture.innerHTML === original, '恢复应完全保留原始 DOM');
        });

        await test('重复翻译复用缓存，切换模式与恢复', async () => {
            reset('<p>Hello world.</p><p>Another paragraph.</p>');
            const original = fixture.innerHTML;
            await translateFullPage('bilingual');
            await translateFullPage('bilingual');
            assert(translations().length === 2 && translationMock.calls.length === 1, '重复执行不应叠加译文或请求');
            await translateFullPage();
            assert(translations().length === 0 && fixture.textContent.includes('译文：'), '替换模式应移除双语译文并替换原文');
            await translateFullPage('bilingual');
            assert(translations().length === 2, '替换后仍能切回双语');
            restoreFullPage();
            assert(fixture.innerHTML === original, '模式切换后应能恢复原文');
        });

        await test('恢复原文取消迟到响应，并阻止并发请求', async () => {
            reset('<p>Delayed response.</p>');
            let respond;
            translationMock.respond = (_, callback) => { respond = callback; };
            const pending = translateFullPage('bilingual');
            await new Promise(resolve => setTimeout(resolve, 0));
            await translateFullPage('bilingual');
            assert(translationMock.calls.length === 1, '翻译中重复点击不应并发');
            translationMock.dispatch({ action: 'restoreFullPage' });
            respond({ success: true, translations: ['迟到的译文'] });
            await pending;
            assert(translations().length === 0, '恢复后迟到结果不应重新出现');
        });

        await test('请求期间网页变动不被覆盖', async () => {
            reset('<p>Original text.</p>');
            translationMock.respond = (_, callback) => {
                fixture.querySelector('p').firstChild.nodeValue = 'New page content.';
                callback({ success: true, translations: ['旧内容译文'] });
            };
            await translateFullPage('bilingual');
            assert(translations().length === 0 && fixture.textContent === 'New page content.', '应跳过发生变化的段落');
            reset('<p>Replace text.</p>');
            await translateFullPage();
            fixture.querySelector('p').firstChild.nodeValue = 'Website update.';
            restoreFullPage();
            assert(fixture.textContent === 'Website update.', '恢复不应撤销网站自己的更新');
        });

        await test('API Key 缺失、失败、数量不匹配与重试', async () => {
            reset('<p>Retry paragraph.</p>');
            translationMock.key = '';
            await translateFullPage('bilingual');
            assert(translationMock.calls.length === 0, '缺少 Key 时应释放翻译状态且不发请求');
            translationMock.key = 'test-key';
            translationMock.respond = (_, callback) => callback({ success: false, error: 'rate_limit' });
            await translateFullPage('bilingual');
            assert(!translations().length && document.getElementById('deepl-page-translation-toast').textContent.includes('未完成'), '失败不能显示翻译成功');
            translationMock.respond = (_, callback) => callback({ success: true, translations: [] });
            await translateFullPage('bilingual');
            assert(!translations().length && document.getElementById('deepl-page-translation-toast').textContent.includes('不匹配'), '应校验返回数量');
            translationMock.respond = null;
            await translateFullPage('bilingual');
            assert(translations().length === 1, '失败后应能重试');
        });

        await test('超过30段分批翻译，安全显示译文', async () => {
            reset(Array.from({ length: 31 }, (_, i) => `<p>Paragraph ${i}.</p>`).join(''));
            translationMock.respond = (message, callback) => callback({ success: true,
                translations: message.text.map(() => '<img src=x onerror=alert(1)>') });
            await translateFullPage('bilingual');
            assert(translationMock.calls.length === 2 && translations().length === 31, '31段应分成2批');
            assert(!fixture.querySelector('img'), '译文应作为文本显示');
        });

        await test('移动节点与替换字符安全', async () => {
            reset('<p id="moving">Moving paragraph.</p><div id="destination"></div>');
            translationMock.respond = (_, callback) => {
                fixture.querySelector('#destination').appendChild(fixture.querySelector('#moving').firstChild);
                callback({ success: true, translations: ['移动前译文'] });
            };
            await translateFullPage('bilingual');
            assert(translations().length === 0, '已移动节点应跳过，不能插入旧容器');
            reset('<p>Literal replacement.</p>');
            translationMock.respond = (_, callback) => callback({ success: true, translations: ['$& $$ $1'] });
            await translateFullPage();
            assert(fixture.textContent === '$& $$ $1', '译文中的替换字符应保持原样');
        });

        restoreFullPage();
        results.textContent = `PASS (${passed.length})\n${passed.join('\n')}`;
        results.dataset.status = 'passed';
    } catch (error) {
        results.textContent = `FAIL: ${error.message}\n已通过：${passed.join('、')}`;
        results.dataset.status = 'failed';
        console.error(error);
    }
})();
