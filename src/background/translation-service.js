(() => {
    const app = globalThis.DeepL;
    const MAX_BATCH = 30;
    const MAX_BODY_BYTES = 120 * 1024; // DeepL 请求上限为128 KiB，保留余量。
    const encoder = new TextEncoder();

    app.createTranslationService = ({ getApiKey, fetchImpl = fetch, timeoutMs = 25000, concurrency = 2 }) => {
        const cache = new app.TextCache();
        const pending = new Map();
        const queue = [];
        let active = 0;

        function schedule(work) {
            return new Promise((resolve, reject) => {
                queue.push({ work, resolve, reject });
                pump();
            });
        }
        function pump() {
            if (active >= concurrency || !queue.length) return;
            const { work, resolve, reject } = queue.shift();
            active++;
            Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; pump(); });
        }
        function splitBatches(texts, params) {
            const batches = [];
            let batch = [];
            for (const text of texts) {
                if (encoder.encode(JSON.stringify({ ...params, text: [text] })).length > MAX_BODY_BYTES) {
                    throw new Error('单段文本过长，请分成较小段落后重试');
                }
                const candidate = [...batch, text];
                if (batch.length && (candidate.length > MAX_BATCH
                    || encoder.encode(JSON.stringify({ ...params, text: candidate })).length > MAX_BODY_BYTES)) {
                    batches.push(batch);
                    batch = [];
                }
                batch.push(text);
            }
            if (batch.length) batches.push(batch);
            return batches;
        }
        async function fetchBatch(texts, apiKey, params) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const url = apiKey.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
                const response = await fetchImpl(url, {
                    method: 'POST', signal: controller.signal,
                    headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...params, text: texts })
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    const messages = { 403: 'API Key 无效或无权限，请检查设置', 429: '请求过于频繁，请稍后重试', 456: 'DeepL 翻译额度已用完' };
                    throw Object.assign(new Error(messages[response.status] || data.message || `HTTP ${response.status}`), { status: response.status });
                }
                if (!Array.isArray(data.translations) || data.translations.length !== texts.length
                    || !data.translations.every(item => typeof item?.text === 'string' && item.text.trim())) {
                    throw new Error('翻译结果数量不匹配或结果为空');
                }
                return data.translations.map(item => item.text);
            } catch (error) {
                if (controller.signal.aborted) throw new Error('翻译请求超时，请稍后重试');
                throw error;
            } finally {
                clearTimeout(timeout);
            }
        }
        async function translate(request) {
            const texts = Array.isArray(request.text) ? request.text : [request.text];
            if (!texts.length || !texts.every(text => typeof text === 'string' && text.trim())) {
                throw new Error('请输入要翻译的文本');
            }
            const apiKey = app.normalizeApiKey(request.apiKey ?? await getApiKey());
            if (!apiKey) throw new Error('请先在插件中设置 DeepL API Key');
            const params = { target_lang: request.targetLang || 'ZH' };
            if (request.sourceLang && request.sourceLang !== 'AUTO') params.source_lang = request.sourceLang;
            const keyOf = text => JSON.stringify([apiKey, params.source_lang || 'AUTO', params.target_lang, text]);
            const values = new Map();
            const missing = [];
            for (const text of new Set(texts)) {
                const key = keyOf(text);
                const cached = cache.get(key);
                if (cached !== undefined) values.set(text, Promise.resolve(cached));
                else if (pending.has(key)) values.set(text, pending.get(key));
                else missing.push(text);
            }
            // 先验证所有批次大小，避免一部分已经发出后才发现超限。
            const batches = splitBatches(missing, params);
            for (const batch of batches) {
                const task = schedule(() => fetchBatch(batch, apiKey, params));
                batch.forEach((text, index) => {
                    const key = keyOf(text);
                    const promise = task.then(translations => {
                        cache.set(key, translations[index]);
                        return translations[index];
                    }).finally(() => pending.delete(key));
                    pending.set(key, promise);
                    values.set(text, promise);
                });
            }
            return Promise.all(texts.map(text => values.get(text)));
        }
        return { translate, clearCache: () => cache.clear() };
    };
})();
