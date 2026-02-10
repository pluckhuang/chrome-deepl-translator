
// twitter_translator.js - Twitter/X specific translation logic

console.log('DeepL Twitter Translator loaded');

// Configuration
const SELECTORS = {
    tweet: 'article[data-testid="tweet"]',
    tweetText: 'div[data-testid="tweetText"]',
    actionBar: 'div[role="group"]'
};

const PROCESSED_ATTR = 'data-deepl-translated-processed';

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
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (response && response.success) {
                    resolve(response.translation);
                } else {
                    reject(new Error(response?.error || 'Translation failed'));
                }
            }
        );
    });
}
