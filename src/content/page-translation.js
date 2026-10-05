// 全文任务只管理生命周期；DOM、请求、状态提示分别由独立模块处理。
(() => {
    const { client, ui, pageDom } = DeepL;
    const renderer = pageDom.createRenderer();
    const cache = new DeepL.TextCache();
    const toastId = 'deepl-page-translation-toast';
    const batchSize = 30;
    let currentRun = null;

    function restore() {
        currentRun = null;
        renderer.restore();
        ui.toast(toastId, '✅ 已恢复网页原文', 'success', 3000);
    }
    async function loadBatch(batch, run) {
        const values = new Map(batch.map(unit => [unit.text, cache.get(unit.text)]));
        const missing = [...values.keys()].filter(text => values.get(text) === undefined);
        if (missing.length) {
            const translations = await client.translate(missing);
            if (currentRun !== run) return values;
            missing.forEach((text, index) => {
                cache.set(text, translations[index]);
                values.set(text, translations[index]);
            });
        }
        return values;
    }
    function finishMessage(run) {
        if (!run.failed) return `✅ ${run.label}完成！右键可恢复原文`;
        const reason = run.error || '页面内容已变化';
        return `⚠️ 已翻译 ${run.completed} / ${run.total}，${run.failed} 处未完成：${reason}，可再次点击重试`;
    }
    async function translate(mode = 'replace') {
        if (!document.body || currentRun) return;
        mode = mode === 'bilingual' ? 'bilingual' : 'replace';
        const run = { label: mode === 'bilingual' ? '全文双语翻译' : '全网页翻译', completed: 0, failed: 0, total: 0, error: '' };
        currentRun = run;
        const toast = ui.toast(toastId, `🔄 正在准备${run.label}...`);
        try {
            const settings = await client.request({ action: 'getSettings' });
            if (currentRun !== run) return;
            if (!settings.configured) throw new Error('请先设置 DeepL API Key');
            renderer.restore();
            const units = pageDom.collectUnits(mode);
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
                    values = new Map(batch.map(unit => [unit.text, cache.get(unit.text)]));
                }
                if (currentRun !== run) return;
                for (const unit of batch) {
                    const translated = values.get(unit.text);
                    if (translated && renderer.apply(unit, translated, mode)) run.completed++;
                    else run.failed++;
                }
                toast.textContent = `🔄 翻译进度: ${run.completed} / ${run.total}`;
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
