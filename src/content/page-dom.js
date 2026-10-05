// 全文翻译的 DOM 收集和可撤销渲染，不负责网络与任务状态。
(() => {
    // 按实际块级容器合并行内文字，让带链接、加粗的段落只出现一份译文。
    function collectUnits(mode) {
        const units = [];
        const styles = new WeakMap();
        const excluded = 'script, style, noscript, code, pre, kbd, textarea, input, select, button, svg, math, [hidden], [data-deepl-ui], [contenteditable]:not([contenteditable="false"]), [translate="no"], [id^="deepl-"], [class*="deepl-"]';
        const styleOf = element => {
            if (!styles.has(element)) styles.set(element, window.getComputedStyle(element));
            return styles.get(element);
        };
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent || (!node.nodeValue.trim() && mode !== 'bilingual') || parent.closest(excluded) || parent.isContentEditable) {
                    return NodeFilter.FILTER_REJECT;
                }
                for (let element = parent; element; element = element.parentElement) {
                    const style = styleOf(element);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') {
                        return NodeFilter.FILTER_REJECT;
                    }
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        let node;
        while ((node = walker.nextNode())) {
            let container = node.parentElement;
            while (container !== document.body && ['inline', 'contents'].includes(styleOf(container).display)) {
                container = container.parentElement;
            }
            let unit = units[units.length - 1];
            if (mode !== 'bilingual' || !unit || unit.container !== container) {
                unit = { container, nodes: [], originals: [], parents: [], text: '' };
                units.push(unit);
            }
            // 保留 <br> 换行，避免不同句子挤在一起。
            if (unit.nodes.length) {
                const gap = document.createRange();
                gap.setStartAfter(unit.nodes[unit.nodes.length - 1]);
                gap.setEndBefore(node);
                if (gap.cloneContents().querySelector('br')) unit.text += '\n';
            }
            unit.nodes.push(node);
            unit.originals.push(node.nodeValue);
            unit.parents.push(node.parentElement);
            unit.text += node.nodeValue;
        }
        return units.filter(unit => {
            unit.text = unit.text.trim();
            return unit.text.length >= 2;
        });
    }


    function createRenderer() {
        const replacements = new Map();
        const additions = new Set();
        function restore() {
            additions.forEach(element => element.remove());
            additions.clear();
            replacements.forEach(({ original, translated }, node) => {
                if (node.isConnected && node.nodeValue === translated) node.nodeValue = original;
            });
            replacements.clear();
        }
        function apply(unit, translation, mode) {
            if (!unit.container.isConnected || !unit.nodes.every((node, index) =>
                node.isConnected && node.nodeValue === unit.originals[index]
                && node.parentElement === unit.parents[index] && unit.container.contains(node))) return false;
            if (mode === 'bilingual') {
                const element = document.createElement('span');
                element.className = 'deepl-bilingual-translation';
                element.dataset.deeplUi = '';
                element.lang = 'zh';
                element.setAttribute('translate', 'no');
                element.textContent = translation;
                let anchor = unit.nodes[unit.nodes.length - 1];
                while (anchor.parentElement !== unit.container) anchor = anchor.parentElement;
                anchor.after(element);
                additions.add(element);
            } else {
                const node = unit.nodes[0];
                const original = unit.originals[0];
                // 不使用 replace 的字符串替换模式，译文中的 $& 等须按原样显示。
                const start = original.indexOf(unit.text);
                const translated = original.slice(0, start) + translation + original.slice(start + unit.text.length);
                replacements.set(node, { original, translated });
                node.nodeValue = translated;
            }
            return true;
        }
        return { restore, apply };
    }
    DeepL.pageDom = { collectUnits, createRenderer };
})();
