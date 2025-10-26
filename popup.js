// popup.js - 弹窗逻辑
document.addEventListener('DOMContentLoaded', function () {
    const apiKeyInput = document.getElementById('apiKey');
    const saveApiKeyBtn = document.getElementById('saveApiKey');
    const sourceText = document.getElementById('sourceText');
    const sourceLang = document.getElementById('sourceLang');
    const targetLang = document.getElementById('targetLang');
    const translateBtn = document.getElementById('translateBtn');
    const resultDiv = document.getElementById('result');

    // 加载保存的 API Key
    chrome.storage.sync.get(['deeplApiKey'], function (result) {
        if (result.deeplApiKey) {
            apiKeyInput.value = result.deeplApiKey;
        }
    });

    // 获取当前页面选中的文本
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs[0] && tabs[0].id) {
            const tab = tabs[0];

            // 检查是否是特殊页面（chrome://, about:, edge:// 等）
            if (tab.url && (
                tab.url.startsWith('chrome://') ||
                tab.url.startsWith('about:') ||
                tab.url.startsWith('edge://') ||
                tab.url.startsWith('chrome-extension://')
            )) {
                // 特殊页面无法注入脚本，直接返回
                console.log('特殊页面，无法获取选中文本');
                return;
            }

            // 尝试获取选中文本
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => window.getSelection().toString()
            }).then(results => {
                if (results && results[0] && results[0].result) {
                    const selectedText = results[0].result.trim();
                    if (selectedText) {
                        sourceText.value = selectedText;
                        // 自动聚焦到翻译按钮
                        translateBtn.focus();
                    }
                }
            }).catch(err => {
                // 静默处理错误，不影响用户使用
                console.log('无法获取选中文本:', err.message);
            });
        }
    });

    // 保存 API Key
    saveApiKeyBtn.addEventListener('click', function () {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            showResult('请输入有效的 API Key', 'error');
            return;
        }

        chrome.storage.sync.set({ deeplApiKey: apiKey }, function () {
            showResult('API Key 保存成功！', 'success');
        });
    });

    // 翻译按钮点击事件
    translateBtn.addEventListener('click', async function () {
        const text = sourceText.value.trim();
        const apiKey = apiKeyInput.value.trim();

        if (!text) {
            showResult('请输入要翻译的文本', 'error');
            return;
        }

        if (!apiKey) {
            showResult('请先输入并保存 API Key', 'error');
            return;
        }

        // 禁用按钮，显示加载状态
        translateBtn.disabled = true;
        translateBtn.textContent = '翻译中...';
        resultDiv.classList.remove('show');

        try {
            const translation = await translateText(
                text,
                apiKey,
                sourceLang.value === 'AUTO' ? null : sourceLang.value,
                targetLang.value
            );

            showResult(translation, 'success');
        } catch (error) {
            showResult(`翻译失败: ${error.message}`, 'error');
        } finally {
            translateBtn.disabled = false;
            translateBtn.textContent = '翻译';
        }
    });

    // 显示结果
    function showResult(text, type) {
        resultDiv.textContent = text;
        resultDiv.className = 'result show';
        if (type === 'error') {
            resultDiv.classList.add('error');
        }
    }

    // 调用 DeepL API 进行翻译
    async function translateText(text, apiKey, sourceLang, targetLang) {
        // 判断是免费版还是付费版 API
        const apiUrl = apiKey.endsWith(':fx')
            ? 'https://api-free.deepl.com/v2/translate'
            : 'https://api.deepl.com/v2/translate';

        const params = new URLSearchParams({
            auth_key: apiKey,
            text: text,
            target_lang: targetLang
        });

        if (sourceLang) {
            params.append('source_lang', sourceLang);
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.translations && data.translations.length > 0) {
            return data.translations[0].text;
        } else {
            throw new Error('翻译结果为空');
        }
    }
});
