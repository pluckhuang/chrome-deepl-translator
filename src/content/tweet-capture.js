// X 帖子截图：集中管理捕获状态与恢复，保留多切片拼接算法。
(() => {
    const SELECTORS = DeepL.twitterSelectors;
    const TRANSLATION_RESULT_CLASS = 'deepl-twitter-translation-result';
    const CAPTURE_EDGE_MARGIN = 8;          // 每个切片上下留的安全边距
    const CAPTURE_MAX_SLICES = 80;          // 防止布局一直变化时死循环
    const CAPTURE_IMAGE_TIMEOUT = 2500;     // 单张图片最多等多久
    const CAPTURE_SIZE_TOLERANCE = 1;       // 帖子尺寸抖动容忍值（CSS px）

    let capturing = false;
    async function capture(tweet) {
        if (capturing) throw new Error('正在截图，请等待当前截图完成');
        if (!tweet?.isConnected) throw new Error('请先在帖子内容区域内右键，再使用这个菜单');
        capturing = true;
        const notify = (message, tone = 'info', duration = 2500) => DeepL.ui.toast('deepl-x-toast', message, tone, duration);
        notify('正在生成帖子截图...');
        try {
            const { captureTarget, geometry, filename, restore } = await prepareTweetForCapture(tweet);
            let dataUrl;
            try {
                dataUrl = await captureTweetByStitching(tweet, captureTarget, geometry);
            } finally {
                restore();
            }
            await DeepL.client.request({ action: 'downloadImage', dataUrl, filename });
            notify('帖子截图已准备好，浏览器将弹出保存位置', 'success');
        } catch (error) {
            notify(`截图失败：${error.message}`, 'error', 4500);
            throw error;
        } finally {
            capturing = false;
        }
    }

    async function prepareTweetForCapture(tweet) {
        const originalScrollX = window.scrollX;
        const originalScrollY = window.scrollY;
        const captureTarget = getTweetCaptureTarget(tweet);
        const restoreCallbacks = [];
        const lazyImages = [...captureTarget.querySelectorAll('img[loading="lazy"]')];
        restoreCallbacks.push(() => lazyImages.forEach(image => image.setAttribute('loading', 'lazy')));

        tweet.querySelectorAll('.deepl-twitter-btn-container').forEach((node) => {
            if (node.querySelector(`.${TRANSLATION_RESULT_CLASS}`)) {
                return;
            }

            const display = node.style.display;
            node.style.display = 'none';
            restoreCallbacks.push(() => {
                node.style.display = display;
            });
        });

        document.getElementById('deepl-x-toast')?.remove();
        restoreCallbacks.push(freezeScrollBehavior());
        restoreCallbacks.push(hideStickyOverlays(captureTarget));

        const restore = () => {
            while (restoreCallbacks.length) {
                const callback = restoreCallbacks.pop();
                try {
                    callback();
                } catch (error) {
                    console.warn('恢复页面状态失败:', error);
                }
            }

            window.scrollTo({ left: originalScrollX, top: originalScrollY, behavior: 'instant' });
        };

        try {
            captureTarget.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
            await settleLayout();

            // 先把帖子（含引用帖的贴图）整体滚一遍，逼懒加载的图片全部就位，
            // 否则截图中途图片才撑开容器，后面的切片就会错位、把贴图割成两半。
            await primeTweetMedia(tweet, captureTarget);

            const geometry = await measureStableGeometry(tweet, captureTarget);

            if (geometry.height <= 0 || geometry.width <= 0) {
                throw new Error('没有识别到可截图的帖子内容');
            }

            if (geometry.width > window.innerWidth) {
                throw new Error('帖子宽度超出当前窗口，请先把浏览器窗口调宽后再截图');
            }

            return {
                captureTarget,
                geometry,
                filename: buildScreenshotFilename(tweet),
                restore
            };
        } catch (error) {
            restore();
            throw error;
        }
    }

    function freezeScrollBehavior() {
        const targets = [document.documentElement, document.body].filter(Boolean);
        const previous = targets.map((element) => ({
            element,
            scrollBehavior: element.style.scrollBehavior,
            overflowAnchor: element.style.overflowAnchor
        }));

        targets.forEach((element) => {
            element.style.scrollBehavior = 'auto';  // 站点的 smooth 滚动会让截图早于滚动到位
            element.style.overflowAnchor = 'none';  // 关掉滚动锚定，避免浏览器偷偷改 scrollY
        });

        return () => {
            previous.forEach(({ element, scrollBehavior, overflowAnchor }) => {
                element.style.scrollBehavior = scrollBehavior;
                element.style.overflowAnchor = overflowAnchor;
            });
        };
    }

    function hideStickyOverlays(captureTarget) {
        const hidden = [];

        document.body.querySelectorAll('*').forEach((element) => {
            if (element.contains(captureTarget) || captureTarget.contains(element)) {
                return;
            }

            const style = window.getComputedStyle(element);
            if (style.position !== 'fixed' && style.position !== 'sticky') {
                return;
            }

            if (style.display === 'none' || style.visibility === 'hidden') {
                return;
            }

            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return;
            }

            hidden.push({
                element,
                visibility: element.style.visibility
            });
            // 用 visibility 而不是 display，保持占位，页面高度不会变
            element.style.visibility = 'hidden';
        });

        return () => {
            hidden.forEach(({ element, visibility }) => {
                element.style.visibility = visibility;
            });
        };
    }

    async function primeTweetMedia(tweet, captureTarget) {
        const step = Math.max(160, Math.floor(window.innerHeight * 0.7));

        for (let pass = 0; pass < 3; pass++) {
            const startHeight = getTweetCaptureRect(tweet, captureTarget).height;
            let offset = 0;
            let guard = 0;

            while (true) {
                const rect = getTweetCaptureRect(tweet, captureTarget);
                if (offset >= rect.height || ++guard > CAPTURE_MAX_SLICES) {
                    break;
                }

                eagerLoadImages(captureTarget);
                await scrollWindowTo(rect.top + offset - CAPTURE_EDGE_MARGIN);
                await waitForViewportImages();
                offset += step;
            }

            await settleLayout();
            await delay(120);

            if (Math.abs(getTweetCaptureRect(tweet, captureTarget).height - startHeight) <= CAPTURE_SIZE_TOLERANCE) {
                return;
            }
        }
    }

    function eagerLoadImages(root) {
        root.querySelectorAll('img[loading="lazy"]').forEach((image) => {
            image.loading = 'eager';
        });
    }

    async function measureStableGeometry(tweet, captureTarget) {
        let previous = getTweetCaptureRect(tweet, captureTarget);

        for (let attempt = 0; attempt < 8; attempt++) {
            await settleLayout();
            await delay(100);
            await waitForViewportImages();

            const current = getTweetCaptureRect(tweet, captureTarget);
            if (isSameCaptureSize(previous, current)) {
                return current;
            }

            previous = current;
        }

        return previous;
    }

    function isSameCaptureSize(a, b) {
        return Math.abs(a.width - b.width) <= CAPTURE_SIZE_TOLERANCE
            && Math.abs(a.height - b.height) <= CAPTURE_SIZE_TOLERANCE;
    }

    async function scrollWindowTo(targetY) {
        const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const desiredY = Math.max(0, Math.min(maxScrollY, targetY));

        let previousY = Number.NaN;

        for (let attempt = 0; attempt < 12; attempt++) {
            window.scrollTo({ top: desiredY, left: window.scrollX, behavior: 'instant' });
            await settleLayout();

            const currentY = window.scrollY;
            if (Math.abs(currentY - desiredY) <= 1 || currentY === previousY) {
                break;
            }

            previousY = currentY;
        }
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
        // 保留小数：取整会随 scrollY 的小数部分抖动，切片之间就会差 1px
        const left = Math.max(0, window.scrollX + rawLeft - padding.left);
        const top = Math.max(0, window.scrollY + rawTop - padding.top);
        const right = window.scrollX + rawRight + padding.right;
        const finalBottom = window.scrollY + rawBottom + padding.bottom;

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

    async function captureTweetByStitching(tweet, captureTarget, initialGeometry) {
        const safeArea = getViewportSafeArea();
        const margin = {
            top: Math.max(CAPTURE_EDGE_MARGIN, safeArea.top),
            bottom: Math.max(CAPTURE_EDGE_MARGIN, safeArea.bottom)
        };

        if (window.innerHeight - margin.top - margin.bottom < 120) {
            throw new Error('当前窗口高度太小，无法完成帖子截图');
        }

        let geometry = initialGeometry;
        let sizeReference = initialGeometry;
        let canvas = null;
        let context = null;
        let scaleX = 1;
        let scaleY = 1;
        let widthPx = 0;
        let totalHeightPx = 0;
        let drawnPx = 0;       // 已经拼好的高度，单位是截图的物理像素，相对帖子自己的顶部
        let restarts = 0;
        let misses = 0;
        let slices = 0;

        while (!canvas || drawnPx < totalHeightPx) {
            if (++slices > CAPTURE_MAX_SLICES) {
                throw new Error('帖子过长，截图未能完成');
            }

            // 每一片都以帖子当前的实际位置为基准，不再用第一次测到的坐标，
            // 这样上方内容（回复、广告、懒加载图片）把帖子推上推下也不会错位。
            let live = getTweetCaptureRect(tweet, captureTarget);
            await scrollWindowTo(live.top + drawnPx / scaleY - margin.top);
            await waitForViewportImages();
            await delay(80);

            live = getTweetCaptureRect(tweet, captureTarget);

            if (canvas && !isSameCaptureSize(live, sizeReference)) {
                // 帖子自身高度变了（通常是贴图刚加载完），旧的画布已经对不上，重新拼
                if (++restarts > 3) {
                    throw new Error('页面布局一直在变化，截图未能完成，请稍后重试');
                }

                geometry = await measureStableGeometry(tweet, captureTarget);
                sizeReference = geometry;
                canvas = null;
                context = null;
                drawnPx = 0;
                totalHeightPx = 0;
                continue;
            }

            geometry = live;

            const bandViewportTop = geometry.top + drawnPx / scaleY - window.scrollY;
            const bandViewportLimit = window.innerHeight - margin.bottom;

            if (bandViewportTop < -0.5 || bandViewportTop > bandViewportLimit - 1) {
                // 滚动没到位（页面又跳了），重试这一片而不是拼一段错的内容
                if (++misses > 4) {
                    throw new Error('页面截图失败：帖子切片不可见');
                }

                continue;
            }

            const shot = await captureViewport();

            if (!canvas) {
                scaleX = shot.naturalWidth / window.innerWidth;
                scaleY = shot.naturalHeight / window.innerHeight;
                widthPx = Math.max(1, Math.round(geometry.width * scaleX));
                totalHeightPx = Math.max(1, Math.round(geometry.height * scaleY));
                sizeReference = geometry;
                canvas = document.createElement('canvas');
                canvas.width = widthPx;
                canvas.height = totalHeightPx;
                context = canvas.getContext('2d');
                context.fillStyle = getTweetBackgroundColor(tweet);
                context.fillRect(0, 0, canvas.width, canvas.height);
            }

            const sourceTop = Math.round(bandViewportTop * scaleY);
            const sourceBottom = Math.min(
                shot.naturalHeight,
                Math.round(bandViewportLimit * scaleY),
                sourceTop + (totalHeightPx - drawnPx)
            );
            const sliceHeightPx = sourceBottom - sourceTop;

            if (sourceTop < 0 || sliceHeightPx <= 0) {
                if (++misses > 4) {
                    throw new Error('页面截图失败：帖子切片不可见');
                }

                continue;
            }

            const sourceLeft = Math.min(
                Math.max(0, Math.round((geometry.left - window.scrollX) * scaleX)),
                Math.max(0, shot.naturalWidth - widthPx)
            );
            const sliceWidthPx = Math.min(widthPx, shot.naturalWidth - sourceLeft);

            // 目标位置直接用 drawnPx，切片之间严格首尾相接：既不会漏行也不会重叠
            context.drawImage(
                shot,
                sourceLeft,
                sourceTop,
                sliceWidthPx,
                sliceHeightPx,
                0,
                drawnPx,
                sliceWidthPx,
                sliceHeightPx
            );

            drawnPx += sliceHeightPx;
        }

        return canvas.toDataURL('image/png');
    }

    async function captureViewport() {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const response = await DeepL.client.request({ action: 'captureVisibleTab' });
                return await loadImage(response.dataUrl);
            } catch (error) {
                if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(error.message) || attempt === 3) throw error;
                await delay(600);
            }
        }
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

    async function waitForViewportImages() {
        await settleLayout();

        const pending = Array.from(document.images).filter((image) => {
            if (image.complete) {
                return false;
            }

            const rect = image.getBoundingClientRect();
            if (rect.width <= 0 && rect.height <= 0) {
                return false;
            }

            // 只等视口附近的图片，整页等会被时间线里的远处图片拖死
            return rect.bottom > -window.innerHeight && rect.top < window.innerHeight * 2;
        });

        if (pending.length) {
            await Promise.all(pending.map(waitForImage));
            await settleLayout();
        }
    }

    function waitForImage(image) {
        if (image.complete && image.naturalWidth > 0) {
            if (typeof image.decode === 'function') {
                return image.decode().catch(() => undefined);
            }

            return Promise.resolve();
        }

        return new Promise((resolve) => {
            const finish = () => {
                window.clearTimeout(timer);
                image.removeEventListener('load', finish);
                image.removeEventListener('error', finish);
                resolve();
            };
            // 超时兜底：X 上有些图片永远不会触发 load，不能无限等
            const timer = window.setTimeout(finish, CAPTURE_IMAGE_TIMEOUT);

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

    DeepL.tweetCapture = { capture };
})();
