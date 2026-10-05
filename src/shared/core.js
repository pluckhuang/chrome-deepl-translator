// 普通脚本、弹窗和 service worker 共用；不依赖 DOM 或构建工具。
(() => {
    const app = globalThis.DeepL = globalThis.DeepL || {};
    app.normalizeApiKey = value => typeof value === 'string' ? value.replace(/[^\x21-\x7E]/g, '') : '';

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
