// content.js - 网页内容脚本
let translationBox = null;
let isTranslating = false;
let lastClickTime = 0;
let lastFocusMarker = null;
let startFocusMarker = null; // 添加起始标记变量

console.log('DeepL 翻译插件内容脚本已加载');

function addFocusMarker() {
    // 1. 移除上一次的标记
    if (lastFocusMarker) {
        try { lastFocusMarker.remove(); } catch (e) { console.warn('移除旧标记(结束)失败:', e); }
        lastFocusMarker = null;
    }
    if (startFocusMarker) {
        try { startFocusMarker.remove(); } catch (e) { console.warn('移除旧标记(起始)失败:', e); }
        startFocusMarker = null;
    }

    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
        try {
            const range = selection.getRangeAt(0);

            // ⚠️ 关键策略：先插入后面的标记，再插入前面的标记。
            // 这样前面的插入操作不会影响后面位置的引用（如果是同一个文本节点）。

            // --- 准备结束标记 Range ---
            const endRange = range.cloneRange();
            endRange.collapse(false); // 折叠到末尾

            // --- 准备起始标记 Range ---
            const startRange = range.cloneRange();
            startRange.collapse(true); // 折叠到开始
            
            // --- 插入结束标记 ---
            const endMarker = document.createElement('span');
            endMarker.className = 'deepl-focus-marker-end deepl-no-select';
            endMarker.innerHTML = '📍'; 
            endMarker.style.cssText = `
                display: inline-block;
                margin-left: 2px;
                vertical-align: middle;
                font-style: normal;
                cursor: help;
                opacity: 0.8;
                pointer-events: auto;
                user-select: none;
                -webkit-user-select: none;
            `;
            endMarker.title = '上次翻译结束位置';
            
            endRange.insertNode(endMarker);
            lastFocusMarker = endMarker;

            // --- 插入起始标记 ---
            const startMarker = document.createElement('span');
            startMarker.className = 'deepl-focus-marker-start deepl-no-select';
            startMarker.innerHTML = '🚩'; 
            startMarker.style.cssText = `
                display: inline-block;
                margin-right: 2px;
                vertical-align: middle;
                font-style: normal;
                cursor: help;
                opacity: 0.8;
                pointer-events: auto;
                user-select: none;
                -webkit-user-select: none;
            `;
            startMarker.title = '上次翻译开始位置';
            
            startRange.insertNode(startMarker);
            startFocusMarker = startMarker;

            console.log('已添加起止位置标记');
        } catch (e) {
             console.error('添加标记失败:', e);
             // 如果出错，尝试清理可能遗留的标记
             if(lastFocusMarker && !startFocusMarker) lastFocusMarker.remove();
        }
    }
}

// 监听文本选择
document.addEventListener('mouseup', function (e) {
    // 延迟处理，确保选区状态已更新
    setTimeout(() => {
        // 检查是否点击了翻译组件
        if (translationBox && (translationBox.contains(e.target) || e.target === translationBox)) {
            return;
        }

        const selection = window.getSelection();
        const selectedText = selection.toString().trim();

        // 1. 如果没有选中文本，或者点击了空白处，隐藏按钮
        if (!selectedText) {
            hideTranslateButton();
            return;
        }

        // 2. 如果正在翻译中，不处理
        if (isTranslating) {
            return;
        }

        // 3. 检查文本有效性
        if (selectedText.length > 0 && selectedText.length < 5000 && selection.rangeCount > 0) {
            try {
                const range = selection.getRangeAt(0);
                const rect = range.getBoundingClientRect();

                // 确保选区可见且有效的检查
                if (rect.width === 0 || rect.height === 0) {
                    // 如果无法获取有效矩形（例如在某些复杂布局中），回退到鼠标位置
                    showTranslateButton(e.pageX + 10, e.pageY + 10, selectedText);
                    return;
                }
                
                // 计算坐标
                const scrollX = window.scrollX || window.pageXOffset;
                const scrollY = window.scrollY || window.pageYOffset;

                // 优先显示在选区底部中间或左侧
                // 这里选择左下角 + 垂直偏移
                const x = rect.left + scrollX;
                const y = rect.bottom + scrollY;

                showTranslateButton(x, y, selectedText);
            } catch (err) {
                console.error('获取选区位置失败，回退到鼠标位置:', err);
                showTranslateButton(e.pageX + 10, e.pageY + 10, selectedText);
            }
        } else {
            hideTranslateButton();
        }
    }, 10);
}, true); // 使用 capturing 阶段，防止被阻止

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

        // 标记本次翻译原文的结束位置
        addFocusMarker();

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
    max-height: 400px;
    overflow-y: auto;
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
    opacity: 0; /* 先隐藏以计算位置 */
    transition: opacity 0.2s;
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

    // 智能调整位置，防止超出视口
    const boxRect = resultBox.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    let finalX = x;
    let finalY = y + 10;

    // 1. 水平方向调整
    if ((finalX - scrollX) + boxRect.width > viewportWidth - 20) {
        // 如果右侧超出，向左移动
        finalX = scrollX + viewportWidth - boxRect.width - 20;
    }
    if (finalX < scrollX + 20) {
        // 如果左侧超出，向右移动
        finalX = scrollX + 20;
    }

    // 2. 垂直方向调整
    if ((finalY - scrollY) + boxRect.height > viewportHeight - 20) {
        // 如果底部超出，尝试向上移动
        // 将底部边缘对齐到视口底部减去边距
        finalY = scrollY + viewportHeight - boxRect.height - 20;
    }
    if (finalY < scrollY + 20) {
        // 防止顶部超出
        finalY = scrollY + 20;
    }

    resultBox.style.left = `${finalX}px`;
    resultBox.style.top = `${finalY}px`;
    // 强制重绘后显示
    requestAnimationFrame(() => {
        resultBox.style.opacity = '1';
    });
    
    translationBox = resultBox;

    console.log('翻译结果框已添加到页面');
}

// 监听来自 background.js 的消息 (用于右键菜单翻译)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'translateFullPage') {
        console.log('收到全网页翻译请求');
        translateFullPage();
        return;
    }

    if (request.action === 'translate') {
        console.log('收到后台翻译请求:', request.text);
        
        // 尝试标记结束位置
        addFocusMarker();

        // 尝试获取当前选区的坐标
        let x = window.innerWidth / 2;
        let y = window.innerHeight / 2;
        
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            try {
                const range = selection.getRangeAt(0);
                const rect = range.getBoundingClientRect();
                // 简单的坐标计算，确保在视口内
                if (rect.width > 0 && rect.height > 0) {
                    x = rect.left + window.scrollX;
                    y = rect.bottom + window.scrollY;
                }
            } catch (e) {
                console.error('获取选区位置失败:', e);
            }
        }
        
        translateSelectedText(request.text, x, y);
    }
});

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

// 收集并翻译全部网页可见文本
async function translateFullPage() {
    console.log('开始全网页翻译...');
    
    // 添加简单的屏幕提示
    let toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#0066cc;color:white;padding:10px 20px;border-radius:4px;z-index:999999;font-size:14px;box-shadow:0 2px 10px rgba(0,0,0,0.2)';
    toast.textContent = '🔄 正在准备翻译全网页...';
    document.body.appendChild(toast);

    let apiKey = '';
    
    // 获取API key
    try {
        const result = await new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'getApiKey' }, resolve);
        });
        if (result && result.apiKey) {
            apiKey = result.apiKey;
        } else {
            alert('请先设置 DeepL API Key');
            return;
        }
    } catch (err) {
        console.error('获取 API Key 失败', err);
        toast.textContent = '❌ 获取 API Key 失败';
        setTimeout(() => toast.remove(), 3000);
        return;
    }

    // 筛选有效文本节点
    const textNodes = [];
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: function(node) {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                // 忽略非显示相关的标签
                const tag = parent.tagName.toLowerCase();
                const ignoreTags = ['script', 'style', 'noscript', 'code', 'pre', 'kbd'];
                if (ignoreTags.includes(tag)) return NodeFilter.FILTER_REJECT;
                // 空白或太短无意义
                const text = node.nodeValue.trim();
                if (text.length < 2) return NodeFilter.FILTER_REJECT;
                // 简单过滤隐藏的节点 (注意：getComputedStyle 比较耗时，仅在需要时使用，已暂时注释防卡顿)
                // const style = window.getComputedStyle(parent);
                // if (style.display === 'none' || style.visibility === 'hidden') {
                //    return NodeFilter.FILTER_REJECT;
                // }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    let node;
    while ((node = walker.nextNode())) {
        textNodes.push(node);
    }

    if (textNodes.length === 0) {
        console.log('未找到需要翻译的文本');
        toast.textContent = '⚠️ 未找到需要翻译的文本';
        setTimeout(() => toast.remove(), 3000);
        return;
    }
    
    console.log(`找到 ${textNodes.length} 个文本节点，开始批量翻译`);
    toast.textContent = `🔄 共找到 ${textNodes.length} 个文本片段，正在翻译...`;

    // 分批翻译，每批30个，或者按字符数限制
    const batchSize = 30;
    let translatedCount = 0;

    for (let i = 0; i < textNodes.length; i += batchSize) {
        const batchNodes = textNodes.slice(i, i + batchSize);
        const batchTexts = batchNodes.map(n => n.nodeValue.trim());

        try {
            const response = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage(
                    {
                        action: 'translate',
                        text: batchTexts,
                        apiKey: apiKey,
                        sourceLang: 'AUTO',
                        targetLang: 'ZH'
                    },
                    (res) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else if (res && res.success) {
                            resolve(res.translations);
                        } else {
                            reject(new Error(res?.error || '翻译批次失败'));
                        }
                    }
                );
            });

            // 成功后按顺序更新 DOM
            if (response && response.length === batchNodes.length) {
                batchNodes.forEach((node, idx) => {
                    if (response[idx]) {
                        node.nodeValue = node.nodeValue.replace(batchTexts[idx], response[idx]);
                    }
                });
                translatedCount += batchNodes.length;
                toast.textContent = `🔄 翻译进度: ${translatedCount} / ${textNodes.length}`;
            } else {
                console.warn('API 返回的结果数量与请求不匹配，或 response为空', response, batchNodes.length);
            }
        } catch (error) {
            console.error(`批量翻译失败 (${i} 到 ${i + batchSize}):`, error);
        }
    }
    
    console.log('全网页翻译完成！');
    toast.textContent = '✅ 全网页翻译完成！';
    toast.style.background = '#4caf50';
    setTimeout(() => toast.remove(), 3000);
}
