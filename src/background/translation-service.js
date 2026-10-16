(() => {
    const app = globalThis.DeepL;
    const MAX_BATCH = 30;
    const MAX_BODY_BYTES = 120 * 1024; // DeepL 请求上限为128 KiB，保留余量。
    const encoder = new TextEncoder();
    const LANGUAGE_NAMES = {
        ZH: ['中文', 'Chinese'], EN: ['英语', 'English'], 'EN-US': ['英语', 'English'], 'EN-GB': ['英语', 'English'],
        JA: ['日语', 'Japanese'], KO: ['韩语', 'Korean'], FR: ['法语', 'French'], DE: ['德语', 'German'],
        ES: ['西班牙语', 'Spanish'], IT: ['意大利语', 'Italian'], RU: ['俄语', 'Russian']
    };

    // 专用翻译模型用官方推荐的简短提示词；通用大模型用系统提示约束译文风格。
    function buildLocalRequest(text, model, targetLang) {
        const [name, englishName] = LANGUAGE_NAMES[targetLang] || LANGUAGE_NAMES.ZH;
        if (/hunyuan-mt/i.test(model)) {
            const content = targetLang === 'ZH' || /[一-鿿]/.test(text)
                ? `把下面的文本翻译成${name}，不要额外解释。\n\n${text}`
                : `Translate the following segment into ${englishName}, without additional explanation.\n\n${text}`;
            return { messages: [{ role: 'user', content }], temperature: 0.7, top_p: 0.6 };
        }
        return {
            messages: [
                { role: 'system', content: `你是专业译者。把用户发来的文本翻译成${name}：意译，符合${name}的表达习惯；专有名词、代码、链接和数字保持原样；只输出译文，不要解释，不要加引号。` },
                { role: 'user', content: text }
            ],
            temperature: 0.3
        };
    }

    // 本地模型常给习语补括号说明（如「细节决定成败（或：魔鬼藏在细节之中）」）；原文没有括号时，括号内容都是模型加的。
    function dropAddedNotes(source, translation) {
        if (/[()（）]/.test(source)) return translation;
        const cleaned = translation.replace(/\s*[（(][^（）()]*[）)]/g, '').trim();
        return cleaned || translation;
    }

    app.createTranslationService = ({
        getSettings, getApiKey, fetchImpl = fetch,
        timeoutMs = 25000, concurrency = 2, localTimeoutMs = 120000, localConcurrency = 1
    }) => {
        const cache = new app.TextCache();
        const pending = new Map();
        const readSettings = getSettings || (async () => ({ deeplApiKey: await getApiKey() }));
        const queues = { deepl: createQueue(concurrency), local: createQueue(localConcurrency) };

        function createQueue(limit) {
            const queue = [];
            let active = 0;
            function pump() {
                if (active >= limit || !queue.length) return;
                const { work, resolve, reject } = queue.shift();
                active++;
                Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; pump(); });
            }
            return work => new Promise((resolve, reject) => {
                queue.push({ work, resolve, reject });
                pump();
            });
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
        async function fetchJson(url, options, timeout, timeoutMessage) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            try {
                const response = await fetchImpl(url, { ...options, signal: controller.signal });
                return { response, data: await response.json().catch(() => ({})) };
            } catch (error) {
                if (controller.signal.aborted) throw new Error(timeoutMessage);
                throw error;
            } finally {
                clearTimeout(timer);
            }
        }
        async function fetchDeepL(texts, { apiKey, params }) {
            const url = apiKey.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
            const { response, data } = await fetchJson(url, {
                method: 'POST',
                headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...params, text: texts })
            }, timeoutMs, '翻译请求超时，请稍后重试');
            if (!response.ok) {
                const messages = {
                    403: 'API Key 无效或无权限，请检查设置',
                    429: '请求过于频繁，请稍后重试',
                    456: 'DeepL 翻译额度已用完，可在插件弹窗将「翻译引擎」切换为本地模型'
                };
                throw Object.assign(new Error(messages[response.status] || data.message || `HTTP ${response.status}`), { status: response.status });
            }
            if (!Array.isArray(data.translations) || data.translations.length !== texts.length
                || !data.translations.every(item => typeof item?.text === 'string' && item.text.trim())) {
                throw new Error('翻译结果数量不匹配或结果为空');
            }
            return data.translations.map(item => item.text);
        }
        async function fetchLocal([text], { endpoint, model, targetLang }) {
            let result;
            try {
                result = await fetchJson(`${endpoint}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, stream: false, ...buildLocalRequest(text, model, targetLang) })
                }, localTimeoutMs, '本地模型响应超时，请确认模型能正常运行，或换用更小的模型');
            } catch (error) {
                if (/超时/.test(error.message)) throw error;
                throw new Error(`无法连接本地模型服务（${endpoint}），请确认 Ollama 或 LM Studio 已启动`);
            }
            const { response, data } = result;
            if (!response.ok) {
                const detail = data.error?.message || (typeof data.error === 'string' ? data.error : '');
                const messages = {
                    403: '本地模型服务拒绝了插件请求（403），Ollama 需设置 OLLAMA_ORIGINS="chrome-extension://*" 后重启',
                    404: `未找到模型 ${model} 或服务地址有误，请检查设置（Ollama 需先执行 ollama pull ${model}）`
                };
                throw Object.assign(new Error(messages[response.status] || `本地模型出错：${detail || `HTTP ${response.status}`}`), { status: response.status });
            }
            const content = data.choices?.[0]?.message?.content;
            // 部分通用模型会先输出思考过程，只保留译文。
            const translation = typeof content === 'string' ? content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '';
            if (!translation) throw new Error('本地模型没有返回译文');
            return [dropAddedNotes(text, translation)];
        }
        function resolveProvider(request, settings) {
            const provider = (request.provider ?? settings.translationProvider) === 'local' ? 'local' : 'deepl';
            const targetLang = request.targetLang || 'ZH';
            if (provider === 'local') {
                const endpoint = app.normalizeEndpoint(request.localEndpoint ?? settings.localEndpoint);
                const model = String(request.localModel ?? settings.localModel ?? '').trim();
                if (!endpoint || !model) throw new Error('请先在插件弹窗填写本地模型的服务地址和模型名称');
                // 本地模型一段一请求，模型自行判断源语言。
                return {
                    queue: queues.local, scope: ['local', endpoint, model, targetLang],
                    batches: texts => texts.map(text => [text]),
                    fetch: batch => fetchLocal(batch, { endpoint, model, targetLang })
                };
            }
            const apiKey = app.normalizeApiKey(request.apiKey ?? settings.deeplApiKey);
            if (!apiKey) throw new Error('请先在插件中设置 DeepL API Key');
            const params = { target_lang: targetLang };
            if (request.sourceLang && request.sourceLang !== 'AUTO') params.source_lang = request.sourceLang;
            return {
                queue: queues.deepl, scope: ['deepl', apiKey, params.source_lang || 'AUTO', targetLang],
                batches: texts => splitBatches(texts, params),
                fetch: batch => fetchDeepL(batch, { apiKey, params })
            };
        }
        async function translate(request) {
            const texts = Array.isArray(request.text) ? request.text : [request.text];
            if (!texts.length || !texts.every(text => typeof text === 'string' && text.trim())) {
                throw new Error('请输入要翻译的文本');
            }
            const provider = resolveProvider(request, { ...app.TRANSLATION_DEFAULTS, ...await readSettings() });
            const keyOf = text => JSON.stringify([...provider.scope, text]);
            const values = new Map();
            const missing = [];
            for (const text of new Set(texts)) {
                const key = keyOf(text);
                const cached = request.noCache ? undefined : cache.get(key);
                if (cached !== undefined) values.set(text, Promise.resolve(cached));
                else if (!request.noCache && pending.has(key)) values.set(text, pending.get(key));
                else missing.push(text);
            }
            // 先验证所有批次大小，避免一部分已经发出后才发现超限。
            const batches = provider.batches(missing);
            for (const batch of batches) {
                const task = provider.queue(() => provider.fetch(batch));
                batch.forEach((text, index) => {
                    const key = keyOf(text);
                    const promise = task.then(translations => {
                        cache.set(key, translations[index]);
                        return translations[index];
                    }).finally(() => { if (pending.get(key) === promise) pending.delete(key); });
                    if (!request.noCache) pending.set(key, promise);
                    values.set(text, promise);
                });
            }
            return Promise.all(texts.map(text => values.get(text)));
        }
        return { translate, clearCache: () => cache.clear() };
    };
})();
