// 弹窗只负责输入和显示；请求统一经过后台翻译服务。
(() => {
    document.addEventListener('DOMContentLoaded', () => {
        const elements = Object.fromEntries(['apiKey', 'saveApiKey', 'sourceText', 'sourceLang', 'targetLang', 'translateBtn', 'result']
            .map(id => [id, document.getElementById(id)]));

        function showResult(text, type = 'success') {
            elements.result.textContent = text;
            elements.result.className = `result show ${type}`;
        }
        async function loadSettings() {
            try {
                const settings = await chrome.storage.sync.get(['deeplApiKey', 'sourceLang', 'targetLang']);
                // 避免异步读取覆盖用户已经开始输入的 Key。
                if (!elements.apiKey.value) elements.apiKey.value = settings.deeplApiKey || '';
                for (const id of ['sourceLang', 'targetLang']) {
                    if ([...elements[id].options].some(option => option.value === settings[id])) elements[id].value = settings[id];
                }
            } catch (error) {
                showResult(`读取设置失败：${error.message}`, 'error');
            }
        }
        async function loadSelection() {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab?.id == null || (tab.url && !/^(https?|file):/.test(tab.url))) return;
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    func: () => window.getSelection()?.toString().trim() || ''
                });
                const selected = results.find(result => result.result)?.result;
                if (selected && !elements.sourceText.value) {
                    elements.sourceText.value = selected;
                    elements.translateBtn.focus();
                }
            } catch {
                // 浏览器内部页面无法注入，但仍可在弹窗手动输入。
            }
        }
        elements.saveApiKey.addEventListener('click', async () => {
            const apiKey = DeepL.normalizeApiKey(elements.apiKey.value);
            if (!apiKey) return showResult('请输入有效的 API Key', 'error');
            elements.saveApiKey.disabled = true;
            try {
                await chrome.storage.sync.set({ deeplApiKey: apiKey });
                elements.apiKey.value = apiKey;
                showResult('API Key 保存成功！');
            } catch (error) {
                showResult(`保存失败：${error.message}`, 'error');
            } finally {
                elements.saveApiKey.disabled = false;
            }
        });
        for (const id of ['sourceLang', 'targetLang']) {
            elements[id].addEventListener('change', () => {
                chrome.storage.sync.set({ [id]: elements[id].value }).catch(error => showResult(`保存语言失败：${error.message}`, 'error'));
            });
        }
        elements.translateBtn.addEventListener('click', async () => {
            if (elements.translateBtn.disabled) return;
            const text = elements.sourceText.value.trim();
            const apiKey = DeepL.normalizeApiKey(elements.apiKey.value);
            if (!text) return showResult('请输入要翻译的文本', 'error');
            if (!apiKey) return showResult('请先输入 API Key', 'error');
            elements.translateBtn.disabled = true;
            elements.translateBtn.textContent = '翻译中...';
            elements.result.classList.remove('show');
            try {
                const translation = await DeepL.client.translate(text, {
                    apiKey, sourceLang: elements.sourceLang.value, targetLang: elements.targetLang.value
                });
                showResult(translation);
            } catch (error) {
                showResult(`翻译失败：${error.message}`, 'error');
            } finally {
                elements.translateBtn.disabled = false;
                elements.translateBtn.textContent = '翻译';
            }
        });
        loadSettings();
        loadSelection();
    });
})();
