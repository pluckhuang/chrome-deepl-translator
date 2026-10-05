(() => {
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

    DeepL.twitterSelectors = SELECTORS;
})();
