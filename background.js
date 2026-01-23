// background.js - 后台服务脚本

console.log('DeepL 翻译插件后台服务已启动');

// 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'translateWithDeepL',
        title: '使用 DeepL 翻译',
        contexts: ['selection']
    });
    console.log('右键菜单已创建');
});

// 监听右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'translateWithDeepL' && info.selectionText) {
        console.log('右键菜单被点击，文本:', info.selectionText);
        // 向内容脚本发送消息
        chrome.tabs.sendMessage(tab.id, {
            action: 'translate',
            text: info.selectionText
        }).catch(err => {
            console.warn('发送消息失败，可能是页面未重新加载:', err);
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
});

// 处理翻译请求
async function handleTranslateRequest(request, sendResponse) {
    console.log('处理翻译请求:', request.text?.substring(0, 50) + '...');

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

        console.log('API 地址:', apiUrl);

        const params = new URLSearchParams({
            text: text,
            target_lang: targetLang || 'ZH'
        });

        if (sourceLang && sourceLang !== 'AUTO') {
            params.append('source_lang', sourceLang);
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `DeepL-Auth-Key ${apiKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params
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
        console.log('API 返回数据:', data);

        if (data.translations && data.translations.length > 0) {
            const translation = data.translations[0].text;
            console.log('翻译成功:', translation.substring(0, 50) + '...');
            sendResponse({
                success: true,
                translation: translation
            });
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
