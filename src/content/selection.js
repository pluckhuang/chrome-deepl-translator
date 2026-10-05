// 划词翻译：一个结果框对应一个请求，关闭后忽略迟到响应。
(() => {
    const { client, ui } = DeepL;
    let panel = null;
    let currentRequest = null;
    let selectionTimer = null;
    let markers = [];

    function removePanel() {
        panel?.remove();
        panel = null;
    }
    function close() {
        currentRequest = null;
        removePanel();
    }
    function selectionPosition(range, fallback = { x: scrollX + innerWidth / 2, y: scrollY + innerHeight / 2 }) {
        const rect = range?.getBoundingClientRect();
        return rect?.width || rect?.height ? { x: rect.left + scrollX, y: rect.bottom + scrollY } : fallback;
    }
    function addMarkers(range) {
        markers.forEach(marker => marker.remove());
        markers = [];
        if (!range || range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected) return;
        const parent = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
            ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
        if (parent?.closest('input, textarea, [contenteditable]')) return;
        try {
            const end = range.cloneRange();
            const start = range.cloneRange();
            end.collapse(false);
            start.collapse(true);
            for (const [point, kind, symbol, title] of [
                [end, 'end', '📍', '上次翻译结束位置'], [start, 'start', '🚩', '上次翻译开始位置']
            ]) {
                const marker = document.createElement('span');
                marker.className = `deepl-focus-marker-${kind} deepl-no-select`;
                marker.dataset.deeplUi = '';
                marker.textContent = symbol;
                marker.title = title;
                point.insertNode(marker);
                markers.push(marker);
            }
        } catch {
            markers.forEach(marker => marker.remove());
            markers = [];
        }
    }
    function renderResult(position, text, isError = false) {
        removePanel();
        const result = document.createElement('div');
        result.id = 'deepl-translation-result';
        result.dataset.deeplUi = '';
        result.dataset.tone = isError ? 'error' : 'info';
        result.setAttribute('role', 'status');
        const content = document.createElement('span');
        content.textContent = text;
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'deepl-close-button';
        closeButton.textContent = '✕';
        closeButton.setAttribute('aria-label', '关闭翻译结果');
        closeButton.addEventListener('click', event => { event.stopPropagation(); close(); });
        result.append(content, closeButton);
        document.body.appendChild(result);
        panel = result;
        ui.position(result, position.x, position.y);
    }
    async function translate(text, position, range) {
        if (currentRequest || !text?.trim() || !document.body) return;
        const selection = window.getSelection();
        range = range || (selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null);
        position = position || selectionPosition(range);
        const request = {};
        currentRequest = request;
        addMarkers(range);
        selection?.removeAllRanges();
        renderResult(position, '⏳ 翻译中，请稍候...');
        try {
            const result = await client.translate(text.trim());
            if (currentRequest === request) renderResult(position, result);
        } catch (error) {
            if (currentRequest === request) renderResult(position, `❌ 翻译失败：${error.message}`, true);
        } finally {
            if (currentRequest === request) currentRequest = null;
        }
    }
    function showButton(text, position, range) {
        removePanel();
        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'deepl-translate-button';
        button.dataset.deeplUi = '';
        button.textContent = '🌐 翻译';
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            translate(text, position, range);
        }, { once: true });
        document.body.appendChild(button);
        panel = button;
        ui.position(button, position.x, position.y);
    }
    document.addEventListener('mouseup', event => {
        if (event.target.closest?.('[data-deepl-ui]')) return;
        clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => {
            if (currentRequest) return;
            const selection = window.getSelection();
            const text = selection?.toString().trim();
            if (!text || text.length >= 5000 || !selection.rangeCount) return close();
            const range = selection.getRangeAt(0).cloneRange();
            const position = selectionPosition(range, { x: event.pageX + 10, y: event.pageY + 10 });
            showButton(text, position, range);
        }, 10);
    }, true);
    document.addEventListener('mousedown', event => {
        if (panel && !panel.contains(event.target)) close();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    DeepL.selection = { translate, close };
})();
