// 内容脚本入口：各功能状态由独立模块维护。
(() => {
    chrome.runtime.onMessage.addListener((request, sender, respond) => {
        switch (request.action) {
            case 'translateFullPage':
                DeepL.page.translate(request.mode);
                break;
            case 'restoreFullPage':
                DeepL.page.restore();
                break;
            case 'translate':
                DeepL.selection.translate(request.text);
                break;
            case 'pageCapture':
                DeepL.pageCapture.handle(request).then(
                    result => respond({ success: true, ...result }),
                    error => respond({ success: false, error: error.message })
                );
                return true;
        }
    });
})();
