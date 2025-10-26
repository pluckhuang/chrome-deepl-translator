// content.js - 网页内容脚本
let translationBox = null;
let isTranslating = false;
let lastClickTime = 0;

console.log('DeepL 翻译插件内容脚本已加载');

// 监听文本选择
document.addEventListener('mouseup', function (e) {
    // 如果点击的是翻译按钮或结果框，不处理
    if (translationBox && translationBox.contains(e.target)) {
        console.log('点击了翻译相关元素，忽略');
        return;
    }

    // 如果正在翻译，不处理
    if (isTranslating) {
        console.log('正在翻译中，忽略选择事件');
        return;
    }

    // 防止频繁触发（100ms 内只处理一次）
    const now = Date.now();
    if (now - lastClickTime < 100) {
        return;
    }
    lastClickTime = now;

    const selectedText = window.getSelection().toString().trim();

    console.log('选中文本:', selectedText ? `"${selectedText.substring(0, 50)}..." (${selectedText.length}字符)` : '无');

    if (selectedText.length > 0 && selectedText.length < 5000) {
        // 显示翻译按钮
        showTranslateButton(e.pageX, e.pageY, selectedText);
    } else {
        hideTranslateButton();
    }
});

// 点击其他地方隐藏翻译框
document.addEventListener('mousedown', function (e) {
    if (translationBox && !translationBox.contains(e.target)) {
        hideTranslateButton();
    }
});

function showTranslateButton(x, y, text) {
    hideTranslateButton();

    console.log('显示翻译按钮，位置:', x, y);

    const button = document.createElement('div');
    button.id = 'deepl-translate-button';
    button.className = 'deepl-no-select'; // 添加标识类
    button.innerHTML = '🌐 翻译';
    button.style.cssText = `
    position: absolute;
    left: ${x}px;
    top: ${y + 10}px;
    background: #0066cc;
    color: white;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    z-index: 999999;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    user-select: none;
    -webkit-user-select: none;
    pointer-events: auto;
  `;

    button.addEventListener('mousedown', function (e) {
        e.stopPropagation();
        e.preventDefault();
    });

    button.addEventListener('click', async function (e) {
        e.stopPropagation();
        e.preventDefault();
        console.log('翻译按钮被点击');

        if (isTranslating) {
            console.log('正在翻译中，忽略点击');
            return;
        }

        // 清除文本选择，避免再次触发
        window.getSelection().removeAllRanges();

        await translateSelectedText(text, x, y);
    }, { once: true }); // 只触发一次

    document.body.appendChild(button);
    translationBox = button;
    console.log('翻译按钮已添加到页面');
}

function hideTranslateButton() {
    if (translationBox) {
        console.log('隐藏翻译框');
        translationBox.remove();
        translationBox = null;
    }
    isTranslating = false;
}

async function translateSelectedText(text, x, y) {
    console.log('开始翻译:', text.substring(0, 50) + '...');
    isTranslating = true;

    // 获取 API Key
    try {
        const result = await chrome.storage.sync.get(['deeplApiKey']);
        console.log('API Key 状态:', result.deeplApiKey ? '已设置' : '未设置');

        if (!result.deeplApiKey) {
            showTranslationResult(x, y, '❌ 请先在插件中设置 DeepL API Key\n\n点击插件图标 → 输入 API Key → 保存', true);
            return;
        }

        showTranslationResult(x, y, '⏳ 翻译中，请稍候...', false, true);

        const translation = await translateText(text, result.deeplApiKey);
        console.log('翻译成功:', translation.substring(0, 50) + '...');
        showTranslationResult(x, y, translation, false, false);
    } catch (error) {
        console.error('翻译失败:', error);
        showTranslationResult(x, y, `❌ 翻译失败: ${error.message}`, true, false);
    } finally {
        isTranslating = false;
    }
}

function showTranslationResult(x, y, text, isError, isLoading = false) {
    hideTranslateButton();

    console.log('显示翻译结果:', isError ? '错误' : (isLoading ? '加载中' : '成功'));

    const resultBox = document.createElement('div');
    resultBox.id = 'deepl-translation-result';
    resultBox.className = 'deepl-no-select'; // 添加标识类
    resultBox.style.cssText = `
    position: absolute;
    left: ${x}px;
    top: ${y + 10}px;
    background: ${isError ? '#fff5f5' : 'white'};
    color: ${isError ? '#d32f2f' : '#333'};
    padding: 15px;
    padding-right: 30px;
    border-radius: 8px;
    max-width: 500px;
    min-width: 200px;
    z-index: 999999;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    font-size: 14px;
    line-height: 1.8;
    border: 2px solid ${isError ? '#ffcdd2' : '#0066cc'};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    word-wrap: break-word;
    white-space: pre-wrap;
    user-select: text;
    -webkit-user-select: text;
    pointer-events: auto;
  `;

    resultBox.textContent = text;

    // 防止点击结果框时触发 mouseup
    resultBox.addEventListener('mousedown', (e) => {
        e.stopPropagation();
    });

    resultBox.addEventListener('mouseup', (e) => {
        e.stopPropagation();
    });

    // 添加关闭按钮
    const closeBtn = document.createElement('span');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = `
    position: absolute;
    top: 8px;
    right: 10px;
    cursor: pointer;
    color: #999;
    font-size: 18px;
    font-weight: bold;
    line-height: 1;
    transition: color 0.2s;
    user-select: none;
    -webkit-user-select: none;
  `;
    closeBtn.addEventListener('mouseover', () => closeBtn.style.color = '#333');
    closeBtn.addEventListener('mouseout', () => closeBtn.style.color = '#999');
    closeBtn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
    });
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        hideTranslateButton();
    });
    resultBox.appendChild(closeBtn);

    document.body.appendChild(resultBox);
    translationBox = resultBox;

    console.log('翻译结果框已添加到页面');
}

async function translateText(text, apiKey) {
    console.log('通过 background.js 调用 DeepL API...');

    // 通过消息传递给 background.js 处理
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            {
                action: 'translate',
                text: text,
                apiKey: apiKey,
                sourceLang: 'AUTO',
                targetLang: 'ZH'
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    console.error('消息发送失败:', chrome.runtime.lastError);
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }

                console.log('收到 background.js 响应:', response);

                if (response && response.success) {
                    resolve(response.translation);
                } else {
                    reject(new Error(response?.error || '翻译失败'));
                }
            }
        );
    });
}
