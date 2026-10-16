// 全文任务只管理生命周期；DOM、请求、状态提示分别由独立模块处理。
(() => {
    const { client, ui, pageDom } = DeepL;
    const renderer = pageDom.createRenderer();
    const cache = new DeepL.TextCache();
    const toastId = 'deepl-page-translation-toast';
    let currentRun = null;

    function restore() {
        currentRun = null;
        renderer.restore();
        ui.toast(toastId, '✅ 已恢复网页原文', 'success', 3000);
    }
    // 缓存按引擎区分：切换引擎后重新翻译，不会显示另一个引擎的旧译文。
    const cacheKey = (run, text) => `${run.provider}\n${text}`;
    const cachedValues = (batch, run) => new Map(batch.map(unit => [unit.text, cache.get(cacheKey(run, unit.text))]));
    async function loadBatch(batch, run) {
        const values = cachedValues(batch, run);
        const missing = [...values.keys()].filter(text => values.get(text) === undefined);
        if (missing.length) {
            const translations = await client.translate(missing);
            if (currentRun !== run) return values;
            missing.forEach((text, index) => {
                cache.set(cacheKey(run, text), translations[index]);
                values.set(text, translations[index]);
            });
        }
        return values;
    }
    // 先译屏幕内的段落，再译下方、最后译上方；同组内保持原文顺序。本地模型较慢时，正在读的地方最先出译文。
    function visibleFirst(units) {
        return units.map((unit, index) => {
            const rect = unit.container.getBoundingClientRect();
            return { unit, index, group: rect.bottom < 0 ? 2 : rect.top <= window.innerHeight ? 0 : 1 };
        }).sort((a, b) => a.group - b.group || a.index - b.index).map(item => item.unit);
    }
    function finishMessage(run) {
        if (!run.failed) return `✅ ${run.label}完成！右键可恢复原文`;
        const reason = run.error || '页面内容已变化';
        return `⚠️ 已翻译 ${run.completed} / ${run.total}，${run.failed} 处未完成：${reason}，可再次点击重试`;
    }
    async function translate(mode = 'replace') {
        if (!document.body || currentRun) return;
        mode = mode === 'bilingual' ? 'bilingual' : 'replace';
        const run = { label: mode === 'bilingual' ? '全文双语翻译' : '全网页翻译', provider: 'deepl', completed: 0, failed: 0, total: 0, error: '' };
        currentRun = run;
        const toast = ui.toast(toastId, `🔄 正在准备${run.label}...`);
        try {
            const settings = await client.request({ action: 'getSettings' });
            if (currentRun !== run) return;
            if (!settings.configured) throw new Error('请先在插件弹窗完成翻译引擎设置');
            run.provider = settings.provider || 'deepl';
            const engine = DeepL.PROVIDER_NAMES[run.provider] || run.provider;
            const batchSize = settings.batchSize || 30;
            toast.textContent = `🔄 正在准备${run.label}（${engine}）...`;
            renderer.restore();
            const units = visibleFirst(pageDom.collectUnits(mode));
            run.total = units.length;
            if (!units.length) {
                toast.textContent = '⚠️ 未找到需要翻译的文本';
                return;
            }
            for (let i = 0; i < units.length; i += batchSize) {
                const batch = units.slice(i, i + batchSize);
                let values;
                try {
                    values = await loadBatch(batch, run);
                } catch (error) {
                    run.error = error.message;
                    values = cachedValues(batch, run);
                }
                if (currentRun !== run) return;
                for (const unit of batch) {
                    const translated = values.get(unit.text);
                    if (translated && renderer.apply(unit, translated, mode)) run.completed++;
                    else run.failed++;
                }
                toast.textContent = `🔄 ${engine}翻译进度: ${run.completed} / ${run.total}`;
                // 缓存命中时也让出主线程，长页仍能点击“恢复原文”。
                if (i + batchSize < units.length) await new Promise(resolve => setTimeout(resolve, 0));
                if (currentRun !== run) return;
            }
            toast.textContent = finishMessage(run);
            toast.dataset.tone = run.failed ? 'warning' : 'success';
        } catch (error) {
            if (currentRun !== run) return;
            toast.textContent = `❌ ${error.message}`;
            toast.dataset.tone = 'error';
        } finally {
            if (currentRun === run) {
                currentRun = null;
                ui.dismissLater(toast, 5000);
            }
        }
    }
    DeepL.page = { translate, restore };
})();
