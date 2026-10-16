// 弹窗只负责输入和显示；请求统一经过后台翻译服务。
(() => {
    document.addEventListener('DOMContentLoaded', () => {
        const elements = Object.fromEntries(['apiKey', 'saveApiKey', 'sourceText', 'sourceLang', 'targetLang', 'translateBtn', 'result', 'capturePageBtn',
            'translationProvider', 'deeplSettings', 'localSettings', 'localEndpoint', 'localModel', 'saveLocal', 'testLocal',
            'openrouterSettings', 'openrouterApiKey', 'openrouterModelSelect', 'openrouterModel', 'saveOpenrouter', 'testOpenrouter', 'resultMeta']
            .map(id => [id, document.getElementById(id)]));

        function showResult(text, type = 'success', meta = '') {
            elements.result.textContent = text;
            elements.result.className = `result show ${type}`;
            elements.resultMeta.textContent = meta;
        }
        function showProvider() {
            const provider = elements.translationProvider.value;
            elements.deeplSettings.hidden = provider !== 'deepl';
            elements.localSettings.hidden = provider !== 'local';
            elements.openrouterSettings.hidden = provider !== 'openrouter';
        }
        function readLocalSettings() {
            return {
                localEndpoint: DeepL.normalizeEndpoint(elements.localEndpoint.value),
                localModel: elements.localModel.value.trim()
            };
        }
        function readOpenrouterSettings() {
            const select = elements.openrouterModelSelect;
            return {
                openrouterApiKey: DeepL.normalizeApiKey(elements.openrouterApiKey.value),
                openrouterModel: select.value === 'custom' ? elements.openrouterModel.value.trim() : select.value
            };
        }
        // 推荐列表里没有的模型显示为「其他模型」，并在输入框里填入模型名。
        function showOpenrouterModel(model) {
            const listed = [...elements.openrouterModelSelect.options].some(option => option.value === model && model !== 'custom');
            elements.openrouterModelSelect.value = listed ? model : 'custom';
            elements.openrouterModel.value = listed ? '' : model;
            elements.openrouterModel.hidden = listed;
        }
        // 测试连接用输入框里尚未保存的设置，显示译文、耗时和 OpenRouter 报告的花费。
        async function testModel(provider, settings) {
            showResult('正在调用模型，首次加载可能需要十几秒...', 'info');
            try {
                const response = await DeepL.client.request({ action: 'testModel', provider, ...settings });
                const cost = typeof response.cost === 'number' ? `，花费 $${response.cost.toFixed(6)}` : '';
                showResult(`✅ 连接成功（${(response.elapsed / 1000).toFixed(1)} 秒${cost}）：${response.translation}`);
            } catch (error) {
                showResult(`连接失败：${error.message}`, 'error');
            }
        }
        async function withButton(button, busyText, work) {
            if (button.disabled) return;
            const text = button.textContent;
            button.disabled = true;
            button.textContent = busyText;
            try {
                await work();
            } finally {
                button.disabled = false;
                button.textContent = text;
            }
        }
        let modelTouched = false;
        async function loadSettings() {
            try {
                const settings = { ...DeepL.TRANSLATION_DEFAULTS, ...await chrome.storage.sync.get([...DeepL.TRANSLATION_SETTING_KEYS, 'sourceLang', 'targetLang']) };
                // 避免异步读取覆盖用户已经开始输入的内容。
                if (!elements.apiKey.value) elements.apiKey.value = settings.deeplApiKey || '';
                if (!elements.localEndpoint.value) elements.localEndpoint.value = settings.localEndpoint;
                if (!elements.localModel.value) elements.localModel.value = settings.localModel;
                if (!elements.openrouterApiKey.value) elements.openrouterApiKey.value = settings.openrouterApiKey || '';
                if (!modelTouched) showOpenrouterModel(settings.openrouterModel);
                for (const id of ['translationProvider', 'sourceLang', 'targetLang']) {
                    if ([...elements[id].options].some(option => option.value === settings[id])) elements[id].value = settings[id];
                }
                showProvider();
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
        elements.translationProvider.addEventListener('change', async () => {
            const provider = elements.translationProvider.value;
            showProvider();
            try {
                await chrome.storage.sync.set({ translationProvider: provider });
                showResult(`已切换为${DeepL.PROVIDER_NAMES[provider]}，划词、全文和 X 帖子翻译都会使用它`);
            } catch (error) {
                showResult(`切换失败：${error.message}`, 'error');
            }
        });
        elements.saveLocal.addEventListener('click', () => withButton(elements.saveLocal, '保存中...', async () => {
            const settings = readLocalSettings();
            if (!settings.localEndpoint) return showResult('请输入以 http:// 或 https:// 开头的服务地址', 'error');
            if (!settings.localModel) return showResult('请输入模型名称', 'error');
            try {
                await chrome.storage.sync.set(settings);
                elements.localEndpoint.value = settings.localEndpoint;
                showResult('本地模型设置已保存');
            } catch (error) {
                showResult(`保存失败：${error.message}`, 'error');
            }
        }));
        elements.testLocal.addEventListener('click', () => withButton(elements.testLocal, '测试中...', async () => {
            const settings = readLocalSettings();
            if (!settings.localEndpoint || !settings.localModel) return showResult('请先填写服务地址和模型名称', 'error');
            await testModel('local', settings);
        }));
        elements.openrouterModelSelect.addEventListener('change', async () => {
            modelTouched = true;
            const custom = elements.openrouterModelSelect.value === 'custom';
            elements.openrouterModel.hidden = !custom;
            if (custom) {
                elements.openrouterModel.focus();
                return showResult('填写模型名后点「保存设置」', 'info');
            }
            try {
                await chrome.storage.sync.set({ openrouterModel: elements.openrouterModelSelect.value });
                showResult(`已切换为 ${elements.openrouterModelSelect.value}`);
            } catch (error) {
                showResult(`切换失败：${error.message}`, 'error');
            }
        });
        elements.openrouterModel.addEventListener('input', () => { modelTouched = true; });
        elements.saveOpenrouter.addEventListener('click', () => withButton(elements.saveOpenrouter, '保存中...', async () => {
            const settings = readOpenrouterSettings();
            if (!settings.openrouterApiKey) return showResult('请输入 OpenRouter API Key', 'error');
            if (!settings.openrouterModel) return showResult('请输入模型名称', 'error');
            try {
                await chrome.storage.sync.set(settings);
                elements.openrouterApiKey.value = settings.openrouterApiKey;
                showResult('OpenRouter 设置已保存');
            } catch (error) {
                showResult(`保存失败：${error.message}`, 'error');
            }
        }));
        elements.testOpenrouter.addEventListener('click', () => withButton(elements.testOpenrouter, '测试中...', async () => {
            const settings = readOpenrouterSettings();
            if (!settings.openrouterApiKey || !settings.openrouterModel) return showResult('请先填写 API Key 和模型名称', 'error');
            await testModel('openrouter', settings);
        }));
        elements.translateBtn.addEventListener('click', async () => {
            if (elements.translateBtn.disabled) return;
            const text = elements.sourceText.value.trim();
            const provider = elements.translationProvider.value;
            const deepl = provider === 'deepl';
            const apiKey = DeepL.normalizeApiKey(elements.apiKey.value);
            if (!text) return showResult('请输入要翻译的文本', 'error');
            if (deepl && !apiKey) return showResult('请先输入 API Key', 'error');
            elements.translateBtn.disabled = true;
            elements.translateBtn.textContent = '翻译中...';
            elements.result.classList.remove('show');
            try {
                // 弹窗里未保存的 DeepL Key 也可直接试用；本地模型和 OpenRouter 使用已保存的设置。
                const started = Date.now();
                const translation = await DeepL.client.translate(text, {
                    ...(deepl ? { apiKey } : {}), sourceLang: elements.sourceLang.value, targetLang: elements.targetLang.value
                });
                const model = { local: elements.localModel.value.trim(), openrouter: readOpenrouterSettings().openrouterModel }[provider];
                showResult(translation, 'success', [DeepL.PROVIDER_NAMES[provider], model, `${((Date.now() - started) / 1000).toFixed(1)} 秒`].filter(Boolean).join(' · '));
            } catch (error) {
                showResult(`翻译失败：${error.message}`, 'error');
            } finally {
                elements.translateBtn.disabled = false;
                elements.translateBtn.textContent = '翻译';
            }
        });
        elements.capturePageBtn.addEventListener('click', async () => {
            if (elements.capturePageBtn.disabled) return;
            elements.capturePageBtn.disabled = true;
            elements.capturePageBtn.textContent = '正在截取整页...';
            showResult('页面会自动滚动一遍，请保持当前标签页在前台，完成后会弹出保存窗口', 'info');
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab?.id == null) throw new Error('没有找到当前标签页');
                const response = await DeepL.client.request({ action: 'capturePage', tabId: tab.id });
                showResult(response.truncated
                    ? `页面过长，已截取前 ${response.capturedHeight}px，请在弹出的窗口中选择保存位置`
                    : '整页截图已生成，请在弹出的窗口中选择保存位置');
            } catch (error) {
                showResult(`截图失败：${error.message}`, 'error');
            } finally {
                elements.capturePageBtn.disabled = false;
                elements.capturePageBtn.textContent = '📸 保存整页截图';
            }
        });
        loadSettings();
        loadSelection();
    });
})();
