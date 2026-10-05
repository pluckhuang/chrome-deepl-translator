document.addEventListener('DOMContentLoaded', async () => {
    const result = parent.document.getElementById('deepl-test-results');
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const turn = () => new Promise(resolve => setTimeout(resolve, 0));
    const get = id => document.getElementById(id);
    try {
        await turn();
        get('apiKey').value = ' test-key:fx\u200b ';
        get('saveApiKey').click();
        await turn();
        assert(translationMock.storage.deeplApiKey === 'test-key:fx', '保存时应清理 Key');
        translationMock.storageError = '模拟存储失败';
        get('saveApiKey').click();
        await turn();
        assert(get('result').textContent.includes('模拟存储失败') && !get('saveApiKey').disabled, '保存失败应报告且恢复按钮');
        translationMock.storageError = null;
        get('targetLang').value = 'JA';
        get('targetLang').dispatchEvent(new Event('change'));
        await turn();
        assert(translationMock.storage.targetLang === 'JA', '语言选择应保存');
        get('sourceText').value = 'Popup text.';
        let respond;
        let request;
        translationMock.respond = (message, callback) => { request = message; respond = callback; };
        get('translateBtn').click(); get('translateBtn').click();
        assert(translationMock.calls.length === 1 && get('translateBtn').disabled, '弹窗应阻止并发');
        assert(request.targetLang === 'JA' && request.apiKey === 'test-key:fx', '应传递所选语言与清理后的Key');
        respond({ success: false, error: '模拟网络失败' });
        await turn();
        assert(get('result').textContent.includes('模拟网络失败') && !get('translateBtn').disabled, '翻译失败可重试');
        translationMock.respond = null;
        get('translateBtn').click();
        await turn();
        assert(get('result').textContent === '译文：Popup text.', '弹窗应经统一服务显示译文');
        result.textContent = 'PASS (1)\n弹窗设置、保存失败、语言持久化、请求去重与重试';
        result.dataset.status = 'passed';
    } catch (error) {
        result.textContent = `FAIL: ${error.message}`;
        result.dataset.status = 'failed';
    }
});
