
// twitter_translator.js - Twitter/X specific translation logic

console.log('DeepL Twitter Translator loaded');

// Configuration
const SELECTORS = {
    tweetCell: 'div[data-testid="cellInnerDiv"]',
    tweet: 'article[data-testid="tweet"]',
    tweetText: 'div[data-testid="tweetText"]',
    actionBar: 'div[role="group"]',
    tweetHeaderContainer: 'div:has(> div[data-testid="Tweet-User-Avatar"]):has(div[data-testid="User-Name"])',
    tweetHeader: 'div[data-testid="User-Name"]',
    tweetAvatar: 'div[data-testid="Tweet-User-Avatar"]',
    replyComposer: [
        'div[data-testid="inline_reply_offscreen"]',
        'div[data-testid="tweetTextarea_0"]',
        'div[role="textbox"][contenteditable="true"]',
        'textarea'
    ].join(', ')
};

const PROCESSED_ATTR = 'data-deepl-translated-processed';
const TRANSLATION_RESULT_CLASS = 'deepl-twitter-translation-result';
let lastContextTweet = null;

document.addEventListener('contextmenu', (event) => {
    const tweet = event.target?.closest?.(SELECTORS.tweet);
    lastContextTweet = tweet && document.contains(tweet) ? tweet : null;
}, true);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'captureTweetScreenshot') {
        captureTweetScreenshot(sendResponse);
        return true;
    }
});

// Initialize Observer
const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (mutation.addedNodes.length) {
            processTweets();
        }
    }
});

function startObserver() {
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
    processTweets(); // Initial run
}

// Check if document body is ready
if (document.body) {
    startObserver();
} else {
    document.addEventListener('DOMContentLoaded', startObserver);
}

function processTweets() {
    const tweets = document.querySelectorAll(`${SELECTORS.tweet}:not([${PROCESSED_ATTR}])`);
    
    tweets.forEach(tweet => {
        tweet.setAttribute(PROCESSED_ATTR, 'true');
        
        const textNode = tweet.querySelector(SELECTORS.tweetText);
        if (!textNode) return;

        const text = textNode.textContent;
        // Check language attribute first
        const lang = textNode.getAttribute('lang');
        if (lang && lang.startsWith('zh')) {
            return; // Skip explicit Chinese tweets
        }

        // Check if text contains Chinese characters (fallback)
        // If > 50% of characters are Chinese, consider it Chinese
        const chineseMatches = text.match(/[\u4e00-\u9fa5]/g);
        const chineseCount = chineseMatches ? chineseMatches.length : 0;
        if (chineseCount > 0 && chineseCount > text.length * 0.5) {
             return; // Skip mostly Chinese tweets
        }

        // Add translate button
        addTranslateButton(tweet, textNode, text);
    });
}

function addTranslateButton(tweet, textNode, text) {
    // Create button container
    const btnContainer = document.createElement('div');
    btnContainer.className = 'deepl-twitter-btn-container';
    btnContainer.style.cssText = `
        margin-top: 8px;
        display: flex;
        align-items: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    `;

    const btn = document.createElement('button');
    btn.textContent = 'Translate with DeepL';
    btn.style.cssText = `
        background: none;
        border: none;
        color: #1d9bf0;
        cursor: pointer;
        font-size: 13px;
        padding: 0;
        display: flex;
        align-items: center;
        gap: 4px;
    `;
    btn.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true" style="width: 16px; height: 16px; fill: currentColor;"><g><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"></path></g></svg>
        <span>Translate</span>
    `;

    btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Show loading state
        btn.innerHTML = '<span>Translating...</span>';
        btn.disabled = true;
        btn.style.cursor = 'wait';

        try {
            const apiKey = await getApiKey();
            if (!apiKey) {
                alert('Please set your DeepL API Key in the extension popup first.');
                resetButton(btn);
                return;
            }

            const translation = await translateText(text, apiKey);
            showTranslation(btnContainer, translation);
            btn.remove(); // Remove button after successful translation
        } catch (err) {
            console.error('Translation failed:', err);
            btn.innerHTML = `<span style="color: red;">Error: ${err.message}</span>`;
            setTimeout(() => resetButton(btn), 3000);
        }
    };

    btnContainer.appendChild(btn);
    
    // Insert after the text node
    textNode.parentNode.insertBefore(btnContainer, textNode.nextSibling);
}

function resetButton(btn) {
    btn.disabled = false;
    btn.style.cursor = 'pointer';
    btn.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true" style="width: 16px; height: 16px; fill: currentColor;"><g><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"></path></g></svg>
        <span>Translate</span>
    `;
}

function showTranslation(container, text) {
    const resultDiv = document.createElement('div');
    resultDiv.className = TRANSLATION_RESULT_CLASS;
    resultDiv.style.cssText = `
        background-color: #f7f9f9;
        border-radius: 4px;
        padding: 8px 12px;
        margin-top: 8px;
        font-size: 15px;
        line-height: 1.5;
        color: #0f1419;
        border-left: 3px solid #1d9bf0;
        white-space: pre-wrap;
    `;
    
    // Check for dark mode on Twitter to adjust styles
    const bgColor = window.getComputedStyle(document.body).backgroundColor;
    if (bgColor === 'rgb(21, 32, 43)' || bgColor === 'rgb(0, 0, 0)') {
         resultDiv.style.backgroundColor = 'rgba(29, 155, 240, 0.1)';
         resultDiv.style.color = '#e7e9ea';
    }

    resultDiv.textContent = text;
    container.appendChild(resultDiv);
}

// Helpers duplicated from content.js since we can't share code easily
function getApiKey() {
    return new Promise((resolve) => {
        chrome.storage.sync.get(['deeplApiKey'], (result) => {
            resolve(result.deeplApiKey);
        });
    });
}

async function translateText(text, apiKey) {
    const response = await sendRuntimeMessage({
        action: 'translate',
        text: text,
        apiKey: apiKey,
        sourceLang: 'AUTO',
        targetLang: 'ZH'
    });

    if (response && response.success) {
        return response.translation;
    }

    throw new Error(response?.error || 'Translation failed');
}

async function captureTweetScreenshot(sendResponse) {
    showToast('正在生成帖子截图...');

    try {
        const tweet = getActiveTweetForScreenshot();
        if (!tweet) {
            throw new Error('请先在帖子内容区域内右键，再使用这个菜单');
        }

        const { captureTarget, captureRect, filename, restore } = await prepareTweetForCapture(tweet);
        let dataUrl;

        try {
            dataUrl = await captureTweetByStitching(tweet, captureTarget, captureRect);
        } finally {
            restore();
        }

        const response = await sendRuntimeMessage({
            action: 'downloadImage',
            dataUrl,
            filename
        });

        if (!response?.success) {
            throw new Error(response?.error || '保存截图失败');
        }

        showToast('帖子截图已准备好，浏览器将弹出保存位置');
        sendResponse({ success: true });
    } catch (error) {
        console.error('帖子截图失败:', error);
        showToast(`截图失败：${error.message || '未知错误'}`, true, 4500);
        sendResponse({
            success: false,
            error: error.message || '截图失败'
        });
    }
}

function getActiveTweetForScreenshot() {
    if (lastContextTweet && document.contains(lastContextTweet)) {
        return lastContextTweet;
    }

    return null;
}

async function prepareTweetForCapture(tweet) {
    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;
    const captureTarget = getTweetCaptureTarget(tweet);
    const buttonContainers = Array.from(tweet.querySelectorAll('.deepl-twitter-btn-container'));
    const hiddenButtons = [];

    buttonContainers.forEach((node) => {
        if (node.querySelector(`.${TRANSLATION_RESULT_CLASS}`)) {
            return;
        }

        hiddenButtons.push({
            node,
            display: node.style.display
        });
        node.style.display = 'none';
    });

    document.getElementById('deepl-x-toast')?.remove();
    await settleLayout();

    captureTarget.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'auto'
    });

    await settleLayout();
    await waitForAssets(captureTarget);

    const captureRect = getTweetCaptureRect(tweet, captureTarget);

    if (captureRect.height <= 0 || captureRect.width <= 0) {
        restoreCaptureState(hiddenButtons, originalScrollX, originalScrollY);
        throw new Error('没有识别到可截图的帖子内容');
    }

    if (captureRect.width > window.innerWidth) {
        restoreCaptureState(hiddenButtons, originalScrollX, originalScrollY);
        throw new Error('帖子宽度超出当前窗口，请先把浏览器窗口调宽后再截图');
    }

    return {
        captureTarget,
        captureRect,
        filename: buildScreenshotFilename(tweet),
        restore: () => restoreCaptureState(hiddenButtons, originalScrollX, originalScrollY)
    };
}

function restoreCaptureState(hiddenButtons, scrollX, scrollY) {
    hiddenButtons.forEach(({ node, display }) => {
        node.style.display = display;
    });

    window.scrollTo(scrollX, scrollY);
}

function getTweetCaptureRect(tweet, captureTarget) {
    const tweetRect = tweet.getBoundingClientRect();
    const targetRect = captureTarget.getBoundingClientRect();
    const headerRect = getTweetHeaderRect(captureTarget);
    const padding = {
        top: 20,
        right: 20,
        bottom: 12,
        left: 20
    };
    const rawLeft = Math.min(targetRect.left, tweetRect.left, headerRect?.left ?? targetRect.left);
    const rawTop = Math.min(targetRect.top, tweetRect.top, headerRect?.top ?? targetRect.top);
    const rawRight = Math.max(targetRect.right, tweetRect.right, headerRect?.right ?? targetRect.right);
    const composerTop = getReplyComposerTop(captureTarget, tweetRect.bottom);
    const bottomLimit = composerTop === null ? targetRect.bottom : composerTop - 12;
    const rawBottom = Math.max(rawTop + 1, tweetRect.bottom, bottomLimit);
    const left = Math.max(0, Math.floor(window.scrollX + rawLeft - padding.left));
    const top = Math.max(0, Math.floor(window.scrollY + rawTop - padding.top));
    const right = Math.ceil(window.scrollX + rawRight + padding.right);
    const finalBottom = Math.ceil(window.scrollY + rawBottom + padding.bottom);

    return {
        left,
        top,
        right,
        bottom: finalBottom,
        width: Math.max(1, right - left),
        height: Math.max(1, finalBottom - top)
    };
}

function getTweetHeaderRect(captureTarget) {
    const headerContainer = captureTarget.querySelector(SELECTORS.tweetHeaderContainer);
    const header = captureTarget.querySelector(SELECTORS.tweetHeader);
    const avatar = captureTarget.querySelector(SELECTORS.tweetAvatar);

    if (headerContainer) {
        const rect = headerContainer.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            return rect;
        }
    }

    if (!header && !avatar) {
        return null;
    }

    const rects = [header, avatar]
        .filter(Boolean)
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);

    if (rects.length === 0) {
        return null;
    }

    return rects.reduce((merged, rect) => ({
        left: Math.min(merged.left, rect.left),
        top: Math.min(merged.top, rect.top),
        right: Math.max(merged.right, rect.right),
        bottom: Math.max(merged.bottom, rect.bottom)
    }));
}

function getReplyComposerTop(captureTarget, minimumTop) {
    const composers = Array.from(captureTarget.querySelectorAll(SELECTORS.replyComposer));

    for (const composer of composers) {
        const rect = composer.getBoundingClientRect();
        if (rect.height <= 0) {
            continue;
        }

        if (rect.top >= minimumTop - 4) {
            return rect.top;
        }
    }

    return null;
}

function getTweetCaptureTarget(tweet) {
    const tweetCell = tweet.closest(SELECTORS.tweetCell);

    return tweetCell || tweet;
}

async function cropTweetFromVisibleTab(dataUrl, captureRect) {
    const image = await loadImage(dataUrl);
    const scaleX = image.naturalWidth / window.innerWidth;
    const scaleY = image.naturalHeight / window.innerHeight;
    const sourceX = Math.max(0, Math.floor((captureRect.left - window.scrollX) * scaleX));
    const sourceY = Math.max(0, Math.floor((captureRect.top - window.scrollY) * scaleY));
    const sourceWidth = Math.max(1, Math.min(image.naturalWidth - sourceX, Math.ceil(captureRect.width * scaleX)));
    const sourceHeight = Math.max(1, Math.min(image.naturalHeight - sourceY, Math.ceil(captureRect.height * scaleY)));
    const canvas = document.createElement('canvas');

    canvas.width = sourceWidth;
    canvas.height = sourceHeight;

    const context = canvas.getContext('2d');
    context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight
    );

    return canvas.toDataURL('image/png');
}

async function captureTweetByStitching(tweet, captureTarget, initialCaptureRect) {
    const viewportSafeArea = getViewportSafeArea();
    const captureTopMargin = Math.max(32, viewportSafeArea.top + 24);
    const captureBottomMargin = Math.max(24, viewportSafeArea.bottom + 16);
    const sliceViewportHeight = window.innerHeight - captureTopMargin - captureBottomMargin;

    if (sliceViewportHeight < 120) {
        throw new Error('当前窗口高度太小，无法完成帖子截图');
    }

    let currentOffset = 0;
    let stitchedCanvas = null;
    let stitchedContext = null;
    let scaleX = 1;
    let scaleY = 1;

    while (currentOffset < initialCaptureRect.height) {
        await positionTweetSlice(initialCaptureRect, currentOffset, captureTopMargin);
        await settleLayout();
        await delay(120);
        await waitForAssets(captureTarget);

        const liveCaptureRect = getTweetCaptureRect(tweet, captureTarget);
        const visiblePageTop = Math.max(liveCaptureRect.top, window.scrollY + captureTopMargin);
        const visiblePageBottom = Math.min(liveCaptureRect.bottom, window.scrollY + window.innerHeight - captureBottomMargin);

        if (visiblePageBottom <= visiblePageTop) {
            throw new Error('页面截图失败：帖子切片不可见');
        }

        const visibleTabResponse = await sendRuntimeMessage({
            action: 'captureVisibleTab'
        });

        if (!visibleTabResponse?.success || !visibleTabResponse.dataUrl) {
            throw new Error(visibleTabResponse?.error || '页面截图失败');
        }

        const image = await loadImage(visibleTabResponse.dataUrl);
        if (!stitchedCanvas) {
            scaleX = image.naturalWidth / window.innerWidth;
            scaleY = image.naturalHeight / window.innerHeight;
            stitchedCanvas = document.createElement('canvas');
            stitchedCanvas.width = Math.max(1, Math.ceil(initialCaptureRect.width * scaleX));
            stitchedCanvas.height = Math.max(1, Math.ceil(initialCaptureRect.height * scaleY));
            stitchedContext = stitchedCanvas.getContext('2d');
        }

        const cropViewportRect = {
            left: liveCaptureRect.left - window.scrollX,
            top: visiblePageTop - window.scrollY,
            width: liveCaptureRect.width,
            height: visiblePageBottom - visiblePageTop
        };

        drawCapturedSlice(
            stitchedContext,
            image,
            cropViewportRect,
            {
                top: visiblePageTop - initialCaptureRect.top,
                left: liveCaptureRect.left - initialCaptureRect.left
            },
            scaleX,
            scaleY
        );

        const nextOffset = Math.ceil(visiblePageBottom - initialCaptureRect.top);
        if (nextOffset <= currentOffset) {
            currentOffset += sliceViewportHeight;
        } else {
            currentOffset = nextOffset;
        }
    }

    return stitchedCanvas.toDataURL('image/png');
}

async function positionTweetSlice(captureRect, offset, topMargin) {
    const targetScrollY = Math.max(0, Math.floor(captureRect.top + offset - topMargin));
    window.scrollTo(window.scrollX, targetScrollY);
}

function getViewportSafeArea() {
    const visibleElements = Array.from(document.body.querySelectorAll('*')).filter((element) => {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }

        if (style.position !== 'fixed' && style.position !== 'sticky') {
            return false;
        }

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        if (rect.left > window.innerWidth || rect.top > window.innerHeight || rect.right < 0 || rect.bottom < 0) {
            return false;
        }

        return true;
    });

    let top = 0;
    let bottom = 0;

    visibleElements.forEach((element) => {
        const rect = element.getBoundingClientRect();

        if (rect.top <= 0 && rect.bottom > 0 && rect.width >= window.innerWidth * 0.4) {
            top = Math.max(top, rect.bottom);
        }

        if (rect.bottom >= window.innerHeight && rect.top < window.innerHeight && rect.width >= window.innerWidth * 0.4) {
            bottom = Math.max(bottom, window.innerHeight - rect.top);
        }
    });

    return {
        top,
        bottom
    };
}

function drawCapturedSlice(context, image, cropViewportRect, destinationOffset, scaleX, scaleY) {
    const sourceX = Math.max(0, Math.floor(cropViewportRect.left * scaleX));
    const sourceY = Math.max(0, Math.floor(cropViewportRect.top * scaleY));
    const sourceWidth = Math.max(1, Math.min(image.naturalWidth - sourceX, Math.ceil(cropViewportRect.width * scaleX)));
    const sourceHeight = Math.max(1, Math.min(image.naturalHeight - sourceY, Math.ceil(cropViewportRect.height * scaleY)));
    const destinationX = Math.max(0, Math.round(destinationOffset.left * scaleX));
    const destinationY = Math.max(0, Math.round(destinationOffset.top * scaleY));

    context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        destinationX,
        destinationY,
        sourceWidth,
        sourceHeight
    );
}

function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('截图裁剪失败'));
        image.src = dataUrl;
    });
}

function delay(ms) {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

function settleLayout() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
}

async function waitForAssets(root) {
    await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    const images = Array.from(root.querySelectorAll('img'));
    await Promise.all(images.map(waitForImage));
}

function waitForImage(image) {
    if (image.complete && image.naturalWidth > 0) {
        if (typeof image.decode === 'function') {
            return image.decode().catch(() => undefined);
        }

        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const finish = () => resolve();
        image.addEventListener('load', finish, { once: true });
        image.addEventListener('error', finish, { once: true });
    });
}

function getTweetBackgroundColor(tweet) {
    const backgroundColor = window.getComputedStyle(tweet).backgroundColor;

    if (!backgroundColor || backgroundColor === 'rgba(0, 0, 0, 0)') {
        return window.getComputedStyle(document.body).backgroundColor || '#ffffff';
    }

    return backgroundColor;
}

function buildScreenshotFilename(tweet) {
    const statusLink = tweet.querySelector('a[href*="/status/"]');
    const handleMatch = statusLink?.getAttribute('href')?.match(/^\/([^/]+)\/status\//);
    const handle = sanitizeFilename(handleMatch?.[1] || 'x-post');
    const timeValue = tweet.querySelector('time')?.getAttribute('datetime');
    const timestamp = formatTimestamp(timeValue ? new Date(timeValue) : new Date());

    return `${handle}-${timestamp}.png`;
}

function formatTimestamp(date) {
    const parts = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
        String(date.getHours()).padStart(2, '0'),
        String(date.getMinutes()).padStart(2, '0'),
        String(date.getSeconds()).padStart(2, '0')
    ];

    return `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}

function sanitizeFilename(value) {
    return value.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'x-post';
}

function showToast(message, isError = false, duration = 2500) {
    const existingToast = document.getElementById('deepl-x-toast');
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.id = 'deepl-x-toast';
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        top: 24px;
        right: 24px;
        max-width: 320px;
        padding: 12px 16px;
        border-radius: 12px;
        background: ${isError ? '#b42318' : '#111827'};
        color: #ffffff;
        font-size: 14px;
        line-height: 1.5;
        z-index: 2147483647;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.28);
    `;

    document.body.appendChild(toast);

    window.setTimeout(() => {
        toast.remove();
    }, duration);
}

function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            resolve(response);
        });
    });
}
