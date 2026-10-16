// 整页截图的页面侧：选定滚动容器、预加载懒加载内容，按后台指令逐屏滚动并临时处理浮层。
(() => {
    const app = globalThis.DeepL;
    const TOAST_ID = 'deepl-page-capture-toast';
    const IMAGE_TIMEOUT = 1500;      // 每屏最多等多久图片
    const PRIME_BUDGET = 15000;      // 预滚动加载懒加载内容的总时长上限
    const PRIME_MAX_HEIGHT = 40000;  // 无限滚动页面只预加载到这个高度（CSS px）
    const IDLE_RESTORE = 30000;      // 后台中断后自动恢复页面
    const FREEZE_STYLES = [
        ['scroll-behavior', 'auto'],   // 站点的平滑滚动会让截图早于滚动到位
        ['overflow-anchor', 'none'],   // 关掉滚动锚定，避免浏览器偷偷改滚动位置
        ['scroll-snap-type', 'none'],  // 吸附滚动会把位置拉到别处
        ['scrollbar-width', 'none']    // 滚动条不进截图
    ];
    let session = null;

    async function handle(request) {
        switch (request.step) {
            case 'prepare': {
                const plan = await prepare();
                keepAlive(session);
                return plan;
            }
            case 'scroll': {
                const current = activeSession();
                try {
                    return await scroll(current, request);
                } finally {
                    if (session === current) keepAlive(current);
                }
            }
            case 'restore':
                restore();
                return {};
            case 'notify':
                app.ui.toast(TOAST_ID, request.message, request.tone || 'info', 4500);
                return {};
            default:
                throw new Error('未知的截图步骤');
        }
    }

    async function prepare() {
        if (session) throw new Error('正在截图，请等待当前截图完成');
        const current = session = {
            styles: createStylePatch(), floating: new Map(), scroller: null, timer: 0,
            origin: { x: window.scrollX, y: window.scrollY }
        };
        try {
            app.ui.toast(TOAST_ID, '正在加载整页内容，请勿滚动或切换标签页…');
            [document.documentElement, document.body].filter(Boolean).forEach(element => freeze(current, element));
            const scroller = current.scroller = findScroller();
            if (scroller.element) {
                current.origin.top = scroller.element.scrollTop;
                freeze(current, scroller.element);
            }
            await primeLazyContent(scroller);
            document.querySelectorAll('.deepl-toast').forEach(node => node.remove());
            document.querySelectorAll('#deepl-translate-button, #deepl-translation-result')
                .forEach(node => current.styles.set(node, 'visibility', 'hidden'));
            await scrollTo(scroller, 0);
            scanFloating(current);
            await settle();
            return {
                height: scroller.height(), rect: scroller.rect(), viewportWidth: window.innerWidth,
                background: pageBackground(scroller.element), title: document.title, url: location.href
            };
        } catch (error) {
            restore();
            throw error;
        }
    }

    async function scroll(current, { y, first, last }) {
        await scrollTo(current.scroller, y);
        await waitForImages();
        scanFloating(current);
        // 顶部浮层只留在第一屏，底部浮层只留在最后一屏，中间各屏不重复出现。
        for (const [element, group] of current.floating) {
            if (group !== 'top' && group !== 'bottom') continue;
            if ((group === 'top' && first) || (group === 'bottom' && last)) {
                current.styles.reset(element);
            } else {
                current.styles.set(element, 'transition', 'none');
                current.styles.set(element, 'visibility', 'hidden');
            }
        }
        await settle();
        await delay(50);
        return { y: current.scroller.y(), rect: current.scroller.rect() };
    }

    function restore() {
        const current = session;
        if (!current) return;
        session = null;
        clearTimeout(current.timer);
        current.styles.restoreAll();
        if (current.scroller?.element) current.scroller.element.scrollTop = current.origin.top;
        window.scrollTo({ left: current.origin.x, top: current.origin.y, behavior: 'instant' });
        document.getElementById(TOAST_ID)?.remove();
    }

    function activeSession() {
        if (!session) throw new Error('截图已中断，请重试');
        clearTimeout(session.timer);
        return session;
    }

    function keepAlive(current) {
        current.timer = setTimeout(() => { if (session === current) restore(); }, IDLE_RESTORE);
    }

    function freeze(current, element) {
        FREEZE_STYLES.forEach(([property, value]) => current.styles.set(element, property, value));
    }

    // 只改动内联样式里涉及的属性，恢复时逐项还原，不覆盖网站在截图期间的其他改动。
    function createStylePatch() {
        const saved = new Map();
        const unstyled = new WeakSet();
        function reset(element) {
            const properties = saved.get(element);
            if (!properties) return;
            saved.delete(element);
            for (const [property, [value, priority]] of properties) {
                if (value) element.style.setProperty(property, value, priority);
                else element.style.removeProperty(property);
            }
            if (unstyled.has(element) && !element.getAttribute('style')) element.removeAttribute('style');
        }
        return {
            set(element, property, value) {
                if (!saved.has(element)) {
                    saved.set(element, new Map());
                    if (!element.hasAttribute('style')) unstyled.add(element);
                }
                const properties = saved.get(element);
                if (!properties.has(property)) {
                    properties.set(property, [element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]);
                }
                element.style.setProperty(property, value, 'important');
            },
            reset,
            restoreAll() { [...saved.keys()].forEach(reset); }
        };
    }

    // 页面本身不滚动时（常见于 100vh 的单页应用），改为截取视口内面积最大的滚动容器。
    function findScroller() {
        const root = document.scrollingElement || document.documentElement;
        const windowRange = root.scrollHeight - root.clientHeight;
        if (windowRange > root.clientHeight * 0.25) return windowScroller(root);
        let best = null;
        let bestArea = window.innerWidth * window.innerHeight * 0.3;
        for (const element of walk(document.documentElement)) {
            const range = element.scrollHeight - element.clientHeight;
            if (range <= Math.max(4, windowRange) || !/auto|scroll|overlay/.test(getComputedStyle(element).overflowY)) continue;
            const rect = element.getBoundingClientRect();
            const area = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0))
                * Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
            if (area > bestArea) {
                best = element;
                bestArea = area;
            }
        }
        return best ? elementScroller(best) : windowScroller(root);
    }

    function windowScroller(root) {
        return {
            element: null,
            height: () => root.scrollHeight,
            rect: () => ({ left: 0, top: 0, width: root.clientWidth, height: root.clientHeight }),
            y: () => window.scrollY,
            scrollTo: y => window.scrollTo({ left: window.scrollX, top: y, behavior: 'instant' })
        };
    }

    // y 是可见区域顶边对应的内容坐标；容器被视口裁掉一部分时也能对齐。
    function elementScroller(element) {
        const box = () => {
            const rect = element.getBoundingClientRect();
            const contentTop = rect.top + element.clientTop;
            const left = Math.max(0, rect.left + element.clientLeft);
            const top = Math.max(0, contentTop);
            const bottom = Math.min(contentTop + element.clientHeight, window.innerHeight);
            return {
                offset: top - contentTop,
                rect: { left, top, width: Math.min(element.clientWidth, window.innerWidth - left), height: Math.max(0, bottom - top) }
            };
        };
        return {
            element,
            height: () => element.scrollHeight,
            rect: () => box().rect,
            y: () => element.scrollTop + box().offset,
            scrollTo: y => element.scrollTo({ top: y - box().offset, behavior: 'instant' })
        };
    }

    async function scrollTo(scroller, y) {
        let previous = Number.NaN;
        for (let attempt = 0; attempt < 10; attempt++) {
            scroller.scrollTo(y);
            await settle();
            const current = scroller.y();
            if (Math.abs(current - y) <= 1 || current === previous) return;
            previous = current;
        }
    }

    // 先整页滚一遍，让懒加载的图片和内容就位，避免拼接中途页面变高导致错位。
    async function primeLazyContent(scroller) {
        const deadline = performance.now() + PRIME_BUDGET;
        const step = Math.max(200, scroller.rect().height);
        for (let y = 0; y < Math.min(scroller.height(), PRIME_MAX_HEIGHT) && performance.now() < deadline; y += step) {
            scroller.scrollTo(y);
            await settle();
            await waitForImages(Math.min(IMAGE_TIMEOUT, deadline - performance.now()));
        }
    }

    // 记录固定和吸顶元素；每屏重新扫描，滚动后才变成固定定位的元素也能处理。
    function scanFloating(current) {
        const scrollerElement = current.scroller.element;
        for (const element of walk(document.documentElement)) {
            if (current.floating.has(element)) continue;
            const style = getComputedStyle(element);
            if (style.position === 'sticky') {
                // 吸顶元素改回普通定位：只出现在原本位置，不在每一屏重复。
                current.styles.set(element, 'position', 'relative');
                ['top', 'right', 'bottom', 'left'].forEach(side => current.styles.set(element, side, 'auto'));
                current.floating.set(element, 'sticky');
            } else if (style.position === 'fixed') {
                if (scrollerElement && element.contains(scrollerElement)) {
                    current.floating.set(element, 'shell');
                    continue;
                }
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                const rect = element.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                // 铺满视口的固定背景或遮罩每屏都保留；其余按靠近顶边还是底边分组。
                const backdrop = rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9;
                current.floating.set(element, backdrop ? 'backdrop' : rect.top <= window.innerHeight - rect.bottom ? 'top' : 'bottom');
            }
        }
    }

    // 遍历元素，包括开放的 Shadow DOM（不少 Cookie 横幅和客服挂件在里面）。
    function* walk(root) {
        const stack = [root];
        while (stack.length) {
            for (const child of stack.pop().children) {
                yield child;
                stack.push(child);
                if (child.shadowRoot) stack.push(child.shadowRoot);
            }
        }
    }

    function pageBackground(scrollerElement) {
        for (const element of [scrollerElement, document.body, document.documentElement]) {
            const color = element && getComputedStyle(element).backgroundColor;
            if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
        }
        return '#ffffff';
    }

    async function waitForImages(timeout = IMAGE_TIMEOUT) {
        await settle();
        const pending = [...document.images].filter(image => {
            if (image.complete) return false;
            const rect = image.getBoundingClientRect();
            return (rect.width > 0 || rect.height > 0) && rect.bottom > 0 && rect.top < window.innerHeight;
        });
        if (!pending.length || timeout <= 0) return;
        await Promise.race([
            Promise.all(pending.map(image => new Promise(resolve => {
                image.addEventListener('load', resolve, { once: true });
                image.addEventListener('error', resolve, { once: true });
            }))),
            delay(timeout)
        ]);
        await settle();
    }

    // 标签页被切到后台时 requestAnimationFrame 会停，用定时器兜底，交给后台报错。
    function settle() {
        return new Promise(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
            setTimeout(resolve, 300);
        });
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    app.pageCapture = { handle };
})();
