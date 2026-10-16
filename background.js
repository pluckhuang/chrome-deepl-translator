// Service worker：右键路由、统一翻译服务、截图与下载。
importScripts('src/shared/core.js', 'src/background/translation-service.js', 'src/background/page-capture.js');

const pageMenus = [
    { id: 'translatePageWithDeepL', title: '翻译整个网页', message: { action: 'translateFullPage', mode: 'replace' } },
    { id: 'translateBilingualPageWithDeepL', title: '全文双语翻译（保留原文）', message: { action: 'translateFullPage', mode: 'bilingual' } },
    { id: 'restorePageWithDeepL', title: '恢复网页原文', message: { action: 'restoreFullPage' } }
];
const translator = DeepL.createTranslationService({
    getApiKey: async () => (await chrome.storage.sync.get('deeplApiKey')).deeplApiKey
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.deeplApiKey) translator.clearCache();
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: 'translateWithDeepL', title: '使用 DeepL 翻译选中文本', contexts: ['selection'] });
        pageMenus.forEach(({ id, title }) => chrome.contextMenus.create({ id, title, contexts: ['page'] }));
        chrome.contextMenus.create({ id: 'capturePageScreenshot', title: '保存整个网页截图', contexts: ['page'] });
        chrome.contextMenus.create({
            id: 'captureXTweetScreenshot', title: '保存当前帖子截图', contexts: ['all'],
            documentUrlPatterns: ['*://twitter.com/*', '*://x.com/*']
        });
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (tab?.id == null) return;
    if (info.menuItemId === 'capturePageScreenshot') {
        return pageCapture.capture(tab).catch(error => console.warn('整页截图失败:', error.message));
    }
    const pageMenu = pageMenus.find(menu => menu.id === info.menuItemId);
    let message = pageMenu?.message;
    if (info.menuItemId === 'translateWithDeepL' && info.selectionText) {
        message = { action: 'translate', text: info.selectionText };
    } else if (info.menuItemId === 'captureXTweetScreenshot') {
        message = { action: 'captureTweetScreenshot' };
    }
    if (!message) return;
    try {
        // 划词只发给选区所在 frame；全文操作仍覆盖网页内已注入的 frame。
        const options = pageMenu ? {} : { frameId: info.frameId ?? 0 };
        const response = await chrome.tabs.sendMessage(tab.id, message, options);
        if (response?.success === false) console.warn('页面操作未完成:', response.error);
    } catch (error) {
        console.warn('无法操作此页面，请刷新网页后重试:', error.message);
    }
});

function downloadImage(request) {
    if (typeof request.dataUrl !== 'string' || !request.dataUrl.startsWith('data:image/png;base64,')) {
        throw new Error('截图数据无效');
    }
    const filename = (request.filename || `x-post-${Date.now()}.png`).replace(/[\\/:*?"<>|]/g, '-');
    return new Promise((resolve, reject) => {
        chrome.downloads.download({ url: request.dataUrl, filename, saveAs: true }, downloadId => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve({ downloadId });
        });
    });
}

async function captureVisibleTab(tab) {
    if (!tab) throw new Error('请从网页发起截图');
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (activeTab?.id !== tab.id) throw new Error('截图期间请保持该标签页处于前台');
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    // 捕获过程中也可能切换标签页，丢弃这种截图。
    const [currentTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (currentTab?.id !== tab.id) throw new Error('截图期间标签页已切换，请重试');
    return { dataUrl };
}

async function sendToPage(tabId, message) {
    let response;
    try {
        response = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch (error) {
        if (/Receiving end does not exist|Could not establish connection/i.test(error.message)) {
            throw new Error('无法在此页面截图，请刷新网页后重试（浏览器内部页面不支持）');
        }
        throw error;
    }
    if (!response?.success) throw new Error(response?.error || '页面没有响应，请刷新网页后重试');
    return response;
}

const pageCapture = DeepL.createPageCapture({
    sendToTab: sendToPage,
    captureTab: async tab => (await captureVisibleTab(tab)).dataUrl,
    saveImage: downloadImage,
    // 截图期间页面上不能放进度提示，进度显示在工具栏图标上。
    setProgress(tabId, text) {
        if (text) chrome.action.setBadgeBackgroundColor({ tabId, color: '#0066cc' }).catch(() => {});
        chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    }
});

const handlers = {
    async getSettings() {
        const settings = await chrome.storage.sync.get('deeplApiKey');
        return { configured: Boolean(DeepL.normalizeApiKey(settings.deeplApiKey)) };
    },
    async translate(request) {
        const translations = await translator.translate(request);
        return Array.isArray(request.text) ? { translations } : { translation: translations[0] };
    },
    downloadImage,
    captureVisibleTab: (_, sender) => captureVisibleTab(sender.tab),
    capturePage: async request => pageCapture.capture(await chrome.tabs.get(request.tabId))
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handler = Object.hasOwn(handlers, request?.action) ? handlers[request.action] : null;
    if (!handler) return;
    Promise.resolve().then(() => handler(request, sender)).then(
        result => sendResponse({ success: true, ...result }),
        error => sendResponse({ success: false, error: error.message || '操作失败', status: error.status })
    );
    return true;
});
