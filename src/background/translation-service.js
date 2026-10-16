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

    const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';
    // 中文译文的要求即「信达雅」，但不直接写这几个字：实测 7B 模型看到「雅」会往文绉绉的方向写。
    const ZH_RULES = [
        '忠实原文：不增删信息，保留原文的转折、递进、条件等逻辑关系和语气',
        '避免翻译腔：长句按中文习惯拆分、调整语序，被动句尽量改主动，少用“被”“进行”“对……进行”；习语和俚语译出真实含义，换成中文里自然的说法',
        '语气和正式程度与原文一致：原文口语就译成口语，原文正式就译得正式；用词精准简练，不用文言词和书面腔，不堆砌辞藻',
        '专有名词、代码、链接和数字保持原样，不加括号注释'
    ];
    const isTranslationModel = model => /hunyuan-mt|hy-mt/i.test(model);

    // 按模型选提示词：Hunyuan-MT 只认官方的简短模板；Hy-MT2 能遵循官方「个性化」模板里的编号要求；通用大模型用系统提示。
    function buildChatRequest(text, model, targetLang) {
        const [name, englishName] = LANGUAGE_NAMES[targetLang] || LANGUAGE_NAMES.ZH;
        if (/hunyuan-mt/i.test(model)) {
            const content = targetLang === 'ZH' || /[\u4e00-\u9fff]/.test(text)
                ? `把下面的文本翻译成${name}，不要额外解释。\n\n${text}`
                : `Translate the following segment into ${englishName}, without additional explanation.\n\n${text}`;
            return { messages: [{ role: 'user', content }], temperature: 0.7, top_p: 0.6 };
        }
        if (/hy-mt/i.test(model)) {
            // 官方推荐采样：1.8B/7B 为 temperature 0.7、top_p 0.6，30B-A3B 的 top_p 为 1。
            const sampling = /30b/i.test(model) ? { temperature: 0.7 } : { temperature: 0.7, top_p: 0.6 };
            const content = targetLang === 'ZH'
                ? `【待翻译文本】\n${text}\n\n【翻译任务】\n${ZH_RULES.map((rule, index) => `${index + 1}、${rule}`).join('\n')}\n${ZH_RULES.length + 1}、将【待翻译文本】翻译为简体中文。`
                : `将以下文本翻译为${name}，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`;
            return { messages: [{ role: 'user', content }], ...sampling };
        }
        const system = targetLang === 'ZH'
            ? `你是专业译者，把用户发来的文本翻译成简体中文，只输出译文，不要解释，不要加引号：\n${ZH_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}`
            : `你是专业译者。把用户发来的文本翻译成${name}：忠实原文，表达地道自然；专有名词、代码、链接和数字保持原样；只输出译文，不要解释，不要加引号。`;
        return { messages: [{ role: 'system', content: system }, { role: 'user', content: text }], temperature: 0.3 };
    }

    // 模型常给习语补括号说明（如「细节决定成败（或：魔鬼藏在细节之中）」）；原文没有括号时，括号内容都是模型加的。
    function dropAddedNotes(source, translation) {
        if (/[()（）]/.test(source)) return translation;
        const cleaned = translation.replace(/\s*[（(][^（）()]*[）)]/g, '').trim();
        return cleaned || translation;
    }

    app.createTranslationService = ({
        getSettings, getApiKey, fetchImpl = fetch,
        timeoutMs = 25000, concurrency = 2, localTimeoutMs = 120000, localConcurrency = 1,
        remoteTimeoutMs = 60000, openrouterConcurrency = 6
    }) => {
        const cache = new app.TextCache();
        const pending = new Map();
        const readSettings = getSettings || (async () => ({ deeplApiKey: await getApiKey() }));
        const queues = { deepl: createQueue(concurrency), local: createQueue(localConcurrency), openrouter: createQueue(openrouterConcurrency) };

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
        // 本地模型和 OpenRouter 都是 OpenAI 兼容的 /chat/completions 接口。
        async function fetchChat(text, { provider, endpoint, model, targetLang, apiKey, withUsage = false }) {
            const remote = provider === 'openrouter';
            const body = { model, stream: false, ...buildChatRequest(text, model, targetLang) };
            // 通用大模型默认先「思考」，翻译不需要：调到最低且不返回思考内容（思考仍按输出计费）。
            if (remote && !isTranslationModel(model)) body.reasoning = { effort: 'low', exclude: true };
            if (remote && withUsage) body.usage = { include: true };
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
            if (remote) headers['X-Title'] = 'chrome-deepl-translator';
            let result;
            try {
                result = await fetchJson(`${endpoint}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) },
                    remote ? remoteTimeoutMs : localTimeoutMs,
                    remote ? 'OpenRouter 响应超时，请稍后重试或换一个模型' : '本地模型响应超时，请确认模型能正常运行，或换用更小的模型');
            } catch (error) {
                if (/超时/.test(error.message)) throw error;
                throw new Error(remote ? '无法连接 OpenRouter，请检查网络或代理设置' : `无法连接本地模型服务（${endpoint}），请确认 Ollama 或 LM Studio 已启动`);
            }
            const { response, data } = result;
            if (!response.ok) throw chatError(response.status, data, remote, model);
            const content = data.choices?.[0]?.message?.content;
            // 部分通用模型会把思考过程写进正文，只保留译文。
            const translation = typeof content === 'string' ? content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '';
            if (!translation) {
                if (data.error) throw chatError(data.error.code, data, remote, model);
                throw new Error(remote ? `OpenRouter 上的 ${model} 没有返回译文` : '本地模型没有返回译文');
            }
            return { translation: dropAddedNotes(text, translation), usage: data.usage };
        }
        function chatError(status, data, remote, model) {
            const detail = data.error?.message || (typeof data.error === 'string' ? data.error : '');
            const messages = remote ? {
                401: 'OpenRouter API Key 无效，请在插件弹窗检查',
                402: 'OpenRouter 余额不足，请充值，或在插件弹窗切换翻译引擎',
                404: `OpenRouter 上没有模型 ${model}，请检查模型名称`,
                429: 'OpenRouter 请求过于频繁，请稍后重试'
            } : {
                403: '本地模型服务拒绝了插件请求（403），Ollama 需设置 OLLAMA_ORIGINS="chrome-extension://*" 后重启',
                404: `未找到模型 ${model} 或服务地址有误，请检查设置（Ollama 需先执行 ollama pull ${model}）`
            };
            const fallback = `${remote ? 'OpenRouter ' : '本地模型'}出错：${detail || `HTTP ${status}`}`;
            return Object.assign(new Error(messages[status] || fallback), { status });
        }
        function resolveProvider(request, settings) {
            const chosen = request.provider ?? settings.translationProvider;
            const provider = ['local', 'openrouter'].includes(chosen) ? chosen : 'deepl';
            const targetLang = request.targetLang || 'ZH';
            // 本地模型和 OpenRouter 一段一请求，模型自行判断源语言。
            const chat = (options, scope) => ({
                queue: queues[provider], scope, options,
                batches: texts => texts.map(text => [text]),
                fetch: async ([text]) => [(await fetchChat(text, options)).translation]
            });
            if (provider === 'openrouter') {
                const apiKey = app.normalizeApiKey(request.openrouterApiKey ?? settings.openrouterApiKey);
                const model = String(request.openrouterModel ?? settings.openrouterModel ?? '').trim();
                if (!apiKey || !model) throw new Error('请先在插件弹窗填写 OpenRouter 的 API Key 和模型名称');
                return chat({ provider, endpoint: OPENROUTER_ENDPOINT, model, targetLang, apiKey }, ['openrouter', model, targetLang]);
            }
            if (provider === 'local') {
                const endpoint = app.normalizeEndpoint(request.localEndpoint ?? settings.localEndpoint);
                const model = String(request.localModel ?? settings.localModel ?? '').trim();
                if (!endpoint || !model) throw new Error('请先在插件弹窗填写本地模型的服务地址和模型名称');
                return chat({ provider, endpoint, model, targetLang }, ['local', endpoint, model, targetLang]);
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
                const cached = cache.get(key);
                if (cached !== undefined) values.set(text, Promise.resolve(cached));
                else if (pending.has(key)) values.set(text, pending.get(key));
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
                    pending.set(key, promise);
                    values.set(text, promise);
                });
            }
            return Promise.all(texts.map(text => values.get(text)));
        }
        // 弹窗的「测试连接」：用输入框里的设置直接请求，不走缓存，返回耗时和 OpenRouter 报告的花费。
        async function testModel(request) {
            const provider = resolveProvider({ ...request, targetLang: 'ZH' }, { ...app.TRANSLATION_DEFAULTS, ...await readSettings() });
            if (!provider.options) throw new Error('只能测试本地模型或 OpenRouter');
            const started = Date.now();
            const { translation, usage } = await provider.queue(() => fetchChat(request.text, { ...provider.options, withUsage: true }));
            return { translation, elapsed: Date.now() - started, cost: usage?.cost, tokens: usage?.total_tokens };
        }
        return { translate, testModel, clearCache: () => cache.clear() };
    };
})();
