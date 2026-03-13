// background.js - 后台服务脚本

console.log('DeepL 翻译插件后台服务已启动');

const MENU_IDS = {
    translate: 'translateWithDeepL',
    translatePage: 'translatePageWithDeepL',
    captureTweet: 'captureXTweetScreenshot'
};

// 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        createContextMenus();
    });
});

function createContextMenus() {
    chrome.contextMenus.create({
        id: MENU_IDS.translate,
        title: '使用 DeepL 翻译选中文本',
        contexts: ['selection']
    });

    chrome.contextMenus.create({
        id: MENU_IDS.translatePage,
        title: '翻译整个网页',
        contexts: ['page']
    });

    chrome.contextMenus.create({
        id: MENU_IDS.captureTweet,
        title: '保存当前帖子截图',
        contexts: ['all'],
        documentUrlPatterns: ['*://twitter.com/*', '*://x.com/*']
    });

    console.log('右键菜单已创建');
}

// 监听右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_IDS.translate && info.selectionText) {
        console.log('右键菜单被点击，文本:', info.selectionText);
        // 向内容脚本发送消息
        chrome.tabs.sendMessage(tab.id, {
            action: 'translate',
            text: info.selectionText
        }).catch(err => {
            console.warn('发送消息失败，可能是页面未重新加载:', err);
        });

        return;
    }

    if (info.menuItemId === MENU_IDS.translatePage) {
        console.log('请求全网页翻译');
        chrome.tabs.sendMessage(tab.id, {
            action: 'translateFullPage'
        }).catch(err => {
            console.warn('发送全页翻译消息失败:', err);
        });
        return;
    }

    if (info.menuItemId === MENU_IDS.captureTweet && tab?.id) {
        console.log('触发 X 帖子截图');

        chrome.tabs.sendMessage(tab.id, {
            action: 'captureTweetScreenshot'
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('发送截图消息失败:', chrome.runtime.lastError.message);
                return;
            }

            if (!response?.success) {
                console.warn('帖子截图未完成:', response?.error || '未知错误');
            }
        });
    }
});

// 监听来自内容脚本的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('收到消息:', request.action);

    if (request.action === 'getApiKey') {
        chrome.storage.sync.get(['deeplApiKey'], (result) => {
            sendResponse({ apiKey: result.deeplApiKey });
        });
        return true; // 保持消息通道开启
    }

    // 处理翻译请求
    if (request.action === 'translate') {
        handleTranslateRequest(request, sendResponse);
        return true; // 保持消息通道开启
    }

    if (request.action === 'downloadImage') {
        handleImageDownload(request, sendResponse);
        return true;
    }

    if (request.action === 'captureVisibleTab') {
        handleVisibleTabCapture(sender, sendResponse);
        return true;
    }
});

// 处理翻译请求
async function handleTranslateRequest(request, sendResponse) {
    const textPreview = Array.isArray(request.text) 
        ? `[数组, 共 ${request.text.length} 项] ${request.text[0]?.substring(0, 30)}...`
        : request.text?.substring(0, 50) + '...';
        
    console.log('处理翻译请求:', textPreview);

    try {
        const { text, apiKey, sourceLang, targetLang } = request;

        if (!apiKey) {
            sendResponse({
                success: false,
                error: '请先设置 DeepL API Key'
            });
            return;
        }

        // 判断使用免费版还是付费版 API
        const apiUrl = apiKey.endsWith(':fx')
            ? 'https://api-free.deepl.com/v2/translate'
            : 'https://api.deepl.com/v2/translate';

        const params = {
            target_lang: targetLang || 'ZH',
            text: Array.isArray(text) ? text : [text]
        };

        if (sourceLang && sourceLang !== 'AUTO') {
            params.source_lang = sourceLang;
        }

        // 确保 apiKey 中没有隐藏的 Unicode 不可见字符或多余的换行/空格
        const cleanApiKey = apiKey.replace(/[^\x20-\x7E]/g, '').trim();

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `DeepL-Auth-Key ${cleanApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(params)
        });

        console.log('API 响应状态:', response.status);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMsg = errorData.message || `HTTP ${response.status}: ${response.statusText}`;
            console.error('API 错误:', errorMsg);
            sendResponse({
                success: false,
                error: errorMsg
            });
            return;
        }

        const data = await response.json();

        if (data.translations && data.translations.length > 0) {
            // 如果请求是一个数组，或者长度>1，返回 translations 数组，包含所有结果
            // 否则为了兼容旧代码返回单个字符串
            if (Array.isArray(text)) {
                sendResponse({
                    success: true,
                    translations: data.translations.map(t => t.text)
                });
            } else {
                sendResponse({
                    success: true,
                    translation: data.translations[0].text
                });
            }
        } else {
            sendResponse({
                success: false,
                error: '翻译结果为空'
            });
        }
    } catch (error) {
        console.error('翻译失败:', error);
        sendResponse({
            success: false,
            error: error.message || '网络请求失败'
        });
    }
}

function handleImageDownload(request, sendResponse) {
    chrome.downloads.download({
        url: request.dataUrl,
        filename: request.filename || `x-post-${Date.now()}.png`,
        saveAs: true
    }, (downloadId) => {
        if (chrome.runtime.lastError) {
            console.error('下载截图失败:', chrome.runtime.lastError);
            sendResponse({
                success: false,
                error: chrome.runtime.lastError.message
            });
            return;
        }

        sendResponse({
            success: true,
            downloadId: downloadId
        });
    });
}

function handleVisibleTabCapture(sender, sendResponse) {
    const windowId = sender.tab?.windowId;

    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
            console.error('捕获页面截图失败:', chrome.runtime.lastError);
            sendResponse({
                success: false,
                error: chrome.runtime.lastError.message
            });
            return;
        }

        sendResponse({
            success: true,
            dataUrl
        });
    });
}
