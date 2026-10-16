// 整页截图：页面侧逐屏滚动并处理浮层，后台捕获可见区域，按页面坐标拼接成一张 PNG。
(() => {
    const app = globalThis.DeepL;
    const RATE_LIMIT = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    async function decodeDataUrl(dataUrl) {
        return createImageBitmap(await (await fetch(dataUrl)).blob());
    }

    async function encodeCanvas(canvas) {
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('截图编码失败'));
            reader.readAsDataURL(blob);
        });
    }

    function buildFilename({ title, url }) {
        let host = '';
        try { host = new URL(url).hostname; } catch { /* 地址异常时退回默认名 */ }
        const base = String(title || host || '')
            .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ')
            .replace(/\s+/g, ' ').trim().slice(0, 80)
            .replace(/^[\s.]+|[\s.]+$/g, '') || 'webpage';
        const now = new Date();
        const pad = value => String(value).padStart(2, '0');
        const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        return `${base}-${time}.png`;
    }

    app.createPageCapture = ({
        sendToTab, captureTab, saveImage, setProgress = () => {},
        createCanvas = (width, height) => new OffscreenCanvas(width, height),
        decodeImage = decodeDataUrl, encodeImage = encodeCanvas,
        minInterval = 550,             // captureVisibleTab 每秒最多两次
        maxSide = 32000,               // 画布单边上限为 32767px
        maxPixels = 64 * 1024 * 1024,  // 约 256MB 像素内存，超出先降分辨率，仍不够再截断
        maxSlices = 200
    }) => {
        const active = new Set();
        let lastCapture = 0;

        async function captureShot(tab) {
            for (let attempt = 0; ; attempt++) {
                await delay(Math.max(0, lastCapture + minInterval - Date.now()));
                lastCapture = Date.now();
                try {
                    return await decodeImage(await captureTab(tab));
                } catch (error) {
                    if (attempt >= 3 || !RATE_LIMIT.test(error.message)) throw error;
                }
            }
        }

        async function stitch(tab, plan, page) {
            const { rect, height } = plan;
            let canvas = null;
            let context = null;
            let ratio = 1;
            let scale = 1;
            let limit = height;   // 实际截取的高度（CSS px）
            let covered = 0;      // 已拼好的高度（CSS px）
            let truncated = false;
            for (let count = 1; covered < limit; count++) {
                if (count > maxSlices) throw new Error('页面过长，截图未能完成');
                const y = Math.min(covered, Math.max(0, height - rect.height));
                const view = await page({ step: 'scroll', y, first: count === 1, last: y + rect.height >= height });
                const shot = await captureShot(tab);
                if (!canvas) {
                    ratio = shot.width / plan.viewportWidth;
                    const minScale = Math.min(1, ratio);
                    scale = Math.min(ratio, maxSide / height, Math.sqrt(maxPixels / (rect.width * height)));
                    if (scale < minScale) {
                        scale = minScale;
                        truncated = true;
                        limit = Math.floor(Math.min(maxSide / scale, maxPixels / (rect.width * scale * scale)));
                    }
                    canvas = createCanvas(Math.round(rect.width * scale), Math.round(limit * scale));
                    context = canvas.getContext('2d');
                    context.imageSmoothingQuality = 'high';
                    context.fillStyle = '#ffffff';
                    context.fillStyle = plan.background || '#ffffff';
                    context.fillRect(0, 0, canvas.width, canvas.height);
                }
                // 每屏只画还没覆盖的部分；最后一屏与上一屏重叠时不会重复绘制。
                const top = Math.max(covered, view.y);
                const bottom = Math.min(view.y + view.rect.height, limit);
                if (bottom <= top) {
                    shot.close?.();
                    limit = covered;  // 页面无法继续滚动（例如截图途中变短）
                    break;
                }
                const destTop = Math.round(top * scale);
                context.drawImage(shot,
                    view.rect.left * ratio, (view.rect.top + top - view.y) * ratio, view.rect.width * ratio, (bottom - top) * ratio,
                    0, destTop, canvas.width, Math.round(bottom * scale) - destTop);
                shot.close?.();
                covered = bottom;
                setProgress(tab.id, `${Math.floor(covered / limit * 100)}%`);
            }
            if (!canvas || covered <= 0) throw new Error('没有识别到可截图的页面内容');
            const outputHeight = Math.round(covered * scale);
            if (outputHeight < canvas.height) {
                const cropped = createCanvas(canvas.width, outputHeight);
                cropped.getContext('2d').drawImage(canvas, 0, 0);
                canvas = cropped;
            }
            return { canvas, truncated, capturedHeight: Math.round(covered) };
        }

        async function capture(tab) {
            if (tab?.id == null) throw new Error('没有找到要截图的标签页');
            if (active.has(tab.id)) throw new Error('正在截图，请等待当前截图完成');
            active.add(tab.id);
            const page = message => sendToTab(tab.id, { action: 'pageCapture', ...message });
            const notify = (message, tone) => page({ step: 'notify', message, tone }).catch(() => {});
            try {
                const plan = await page({ step: 'prepare' });
                let result;
                try {
                    result = await stitch(tab, plan, page);
                } finally {
                    await page({ step: 'restore' }).catch(() => {});
                }
                setProgress(tab.id, '…');
                const dataUrl = await encodeImage(result.canvas);
                const filename = buildFilename(plan);
                await notify(result.truncated
                    ? `页面过长，已截取前 ${result.capturedHeight}px，请在弹出的窗口中选择保存位置`
                    : '整页截图已生成，请在弹出的窗口中选择保存位置', result.truncated ? 'warning' : 'success');
                await saveImage({ dataUrl, filename });
                return { filename, truncated: result.truncated, capturedHeight: result.capturedHeight };
            } catch (error) {
                await notify(`整页截图失败：${error.message}`, 'error');
                throw error;
            } finally {
                active.delete(tab.id);
                setProgress(tab.id, '');
            }
        }

        return { capture };
    };
})();
