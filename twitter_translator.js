// X 的帖子翻译和菜单入口。只处理发生变动的帖子，不反复扫描整条时间线。
(() => {
    const selectors = DeepL.twitterSelectors;
    const states = new WeakMap();
    const pendingTweets = new Set();
    let scheduled = false;
    let lastContextTweet = null;

    function shouldTranslate(text, lang) {
        if (!text || lang?.toLowerCase().startsWith('zh')) return false;
        const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        return chineseCount <= text.length * 0.5;
    }
    function updateTweet(tweet) {
        if (!tweet.isConnected) return;
        const textNode = tweet.querySelector(selectors.tweetText);
        const text = textNode ? DeepL.ui.readOriginalText(textNode) : '';
        const lang = textNode?.lang || '';
        const previous = states.get(tweet);
        if (previous?.textNode === textNode && previous.text === text && previous.lang === lang && previous.container.isConnected) return;
        previous?.container.remove();
        states.delete(tweet);
        if (!textNode || !shouldTranslate(text, lang)) return;

        const container = document.createElement('div');
        container.className = 'deepl-twitter-btn-container';
        container.dataset.deeplUi = '';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '🌐 Translate';
        button.className = 'deepl-twitter-translate-button';
        const state = { textNode, text, lang, container };
        states.set(tweet, state);
        button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            if (button.disabled) return;
            button.disabled = true;
            button.textContent = 'Translating...';
            container.querySelector('.deepl-twitter-error')?.remove();
            try {
                const translation = await DeepL.client.translate(text);
                if (states.get(tweet) !== state || !textNode.isConnected || DeepL.ui.readOriginalText(textNode) !== text) return;
                const result = document.createElement('div');
                result.className = 'deepl-twitter-translation-result';
                result.lang = 'zh';
                result.setAttribute('translate', 'no');
                result.textContent = translation;
                container.replaceChildren(result);
            } catch (error) {
                if (states.get(tweet) !== state || !container.isConnected) return;
                const message = document.createElement('div');
                message.className = 'deepl-twitter-error';
                message.setAttribute('role', 'alert');
                message.textContent = `翻译失败：${error.message}`;
                container.appendChild(message);
            } finally {
                button.disabled = false;
                button.textContent = '🌐 Translate';
            }
        });
        container.appendChild(button);
        textNode.after(container);
    }
    function queueTweet(tweet) {
        if (!tweet) return;
        pendingTweets.add(tweet);
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            const tweets = [...pendingTweets];
            pendingTweets.clear();
            tweets.forEach(updateTweet);
        });
    }
    function inspectNode(node) {
        const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!element || element.closest('[data-deepl-ui]')) return;
        queueTweet(element.closest(selectors.tweet));
        element.querySelectorAll(selectors.tweet).forEach(queueTweet);
    }
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            if (mutation.target.parentElement?.closest('[data-deepl-ui]') || mutation.target.closest?.('[data-deepl-ui]')) continue;
            // 文本晚加载、节点被复用或整段被替换时，都重新核对当前正文。
            queueTweet((mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement)?.closest(selectors.tweet));
            mutation.addedNodes.forEach(inspectNode);
        }
    });
    function start() {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['lang'] });
        document.querySelectorAll(selectors.tweet).forEach(queueTweet);
    }
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });

    document.addEventListener('contextmenu', event => {
        lastContextTweet = event.target.closest?.(selectors.tweet) || null;
    }, true);
    chrome.runtime.onMessage.addListener((request, sender, respond) => {
        if (request.action !== 'captureTweetScreenshot') return;
        DeepL.tweetCapture.capture(lastContextTweet).then(
            () => respond({ success: true }),
            error => respond({ success: false, error: error.message })
        );
        return true;
    });
})();
