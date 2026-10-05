(() => {
    const app = globalThis.DeepL;
    function request(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, response => {
                const error = chrome.runtime.lastError;
                if (error) reject(new Error(error.message));
                else if (!response?.success) reject(new Error(response?.error || '扩展未返回有效结果，请重新加载插件和网页'));
                else resolve(response);
            });
        });
    }
    async function translate(text, options = {}) {
        const response = await request({ action: 'translate', text, sourceLang: 'AUTO', targetLang: 'ZH', ...options });
        const translations = Array.isArray(text) ? response.translations : [response.translation];
        const expected = Array.isArray(text) ? text.length : 1;
        if (!Array.isArray(translations) || translations.length !== expected
            || !translations.every(value => typeof value === 'string' && value.trim())) {
            throw new Error('翻译结果数量不匹配或结果为空');
        }
        return Array.isArray(text) ? translations : translations[0];
    }
    app.client = { request, translate };
})();
