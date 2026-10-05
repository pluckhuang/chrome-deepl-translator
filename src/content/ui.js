(() => {
    const app = globalThis.DeepL;
    const timers = new Map();
    function toast(id, message, tone = 'info', duration = 0) {
        clearTimeout(timers.get(id));
        timers.delete(id);
        document.getElementById(id)?.remove();
        const element = document.createElement('div');
        element.id = id;
        element.className = 'deepl-toast';
        element.dataset.deeplUi = '';
        element.dataset.tone = tone;
        element.setAttribute('role', 'status');
        element.textContent = message;
        document.body.appendChild(element);
        if (duration) dismissLater(element, duration);
        return element;
    }
    function dismissLater(element, duration) {
        clearTimeout(timers.get(element.id));
        timers.set(element.id, setTimeout(() => {
            element.remove();
            timers.delete(element.id);
        }, duration));
    }
    function position(element, x, y) {
        const rect = element.getBoundingClientRect();
        element.style.left = `${Math.max(window.scrollX + 12, Math.min(x, window.scrollX + innerWidth - rect.width - 12))}px`;
        element.style.top = `${Math.max(window.scrollY + 12, Math.min(y + 10, window.scrollY + innerHeight - rect.height - 12))}px`;
    }
    function readOriginalText(element) {
        const copy = element.cloneNode(true);
        copy.querySelectorAll('[data-deepl-ui], .deepl-bilingual-translation, .deepl-no-select').forEach(node => node.remove());
        return copy.textContent.trim();
    }
    app.ui = { toast, dismissLater, position, readOriginalText };
})();
