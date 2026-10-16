// 普通脚本、弹窗和 service worker 共用；不依赖 DOM 或构建工具。
(() => {
    const app = globalThis.DeepL = globalThis.DeepL || {};
    app.normalizeApiKey = value => typeof value === 'string' ? value.replace(/[^\x21-\x7E]/g, '') : '';
    // 只接受 http(s) 地址，去掉末尾斜杠，方便拼接 /chat/completions。
    app.normalizeEndpoint = value => {
        const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
        return /^https?:\/\/[^\s/]+/i.test(text) ? text : '';
    };
    // 翻译引擎只能在弹窗里手动切换，默认仍用 DeepL。
    app.TRANSLATION_DEFAULTS = {
        translationProvider: 'deepl',
        localEndpoint: 'http://127.0.0.1:11434/v1',
        localModel: 'hf.co/mradermacher/Hunyuan-MT-7B-GGUF:Q5_K_M',
        openrouterApiKey: '',
        openrouterModel: 'tencent/hy-mt2-30b-a3b'
    };
    app.TRANSLATION_SETTING_KEYS = ['deeplApiKey', ...Object.keys(app.TRANSLATION_DEFAULTS)];
    app.PROVIDER_NAMES = { deepl: 'DeepL', local: '本地模型', openrouter: 'OpenRouter' };

    // 页面和后台缓存都有容量上限，避免长时间浏览不断积累文本。
    app.TextCache = class {
        constructor(maxEntries = 500, maxChars = 500000) {
            this.entries = new Map();
            this.maxEntries = maxEntries;
            this.maxChars = maxChars;
            this.chars = 0;
        }
        get(key) {
            if (!this.entries.has(key)) return undefined;
            const value = this.entries.get(key);
            this.entries.delete(key);
            this.entries.set(key, value);
            return value;
        }
        set(key, value) {
            this.delete(key);
            if (key.length + value.length > this.maxChars) return;
            this.entries.set(key, value);
            this.chars += key.length + value.length;
            while (this.entries.size > this.maxEntries || this.chars > this.maxChars) {
                this.delete(this.entries.keys().next().value);
            }
        }
        delete(key) {
            if (!this.entries.has(key)) return;
            this.chars -= key.length + this.entries.get(key).length;
            this.entries.delete(key);
        }
        clear() {
            this.entries.clear();
            this.chars = 0;
        }
    };
})();
