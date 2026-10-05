// 所有浏览器测试都模拟扩展消息，无真实 API 请求、下载或用户资料访问。
(() => {
    const listeners = [];
    window.translationMock = {
        calls: [], key: 'test-key', respond: null, storage: {}, captureCalls: 0, downloads: [],
        dispatch(message) {
            let response;
            listeners.forEach(listener => listener(message, {}, value => { response = value; }));
            return response;
        }
    };
    window.chrome = {
        runtime: {
            onMessage: { addListener(listener) { listeners.push(listener); } },
            sendMessage(message, callback) {
                const mock = translationMock;
                if (message.action === 'getSettings') return callback({ success: true, configured: Boolean(mock.key) });
                if (message.action === 'captureVisibleTab') {
                    mock.captureCalls++;
                    if (mock.capture) return mock.capture(callback);
                }
                if (message.action === 'downloadImage') {
                    mock.downloads.push(message);
                    return callback({ success: true, downloadId: 1 });
                }
                mock.calls.push(message.text);
                if (mock.respond) return mock.respond(message, callback);
                if (Array.isArray(message.text)) callback({ success: true, translations: message.text.map(text => `译文：${text}`) });
                else callback({ success: true, translation: `译文：${message.text}` });
            }
        },
        storage: { sync: {
            async get() { return { deeplApiKey: translationMock.key, ...translationMock.storage }; },
            async set(values) {
                if (translationMock.storageError) throw new Error(translationMock.storageError);
                Object.assign(translationMock.storage, values);
            }
        } },
        tabs: { async query() { return [{ id: 1, url: 'https://example.com' }]; } },
        scripting: { async executeScript() { return [{ result: translationMock.selectedText || '' }]; } }
    };
})();
