// Node.js 脚本，用于生成图标
// 需要安装: npm install canvas
// 运行: node generate-icons.js

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function drawIcon(canvas, size) {
    const ctx = canvas.getContext('2d');

    // 背景
    ctx.fillStyle = '#0066cc';
    ctx.fillRect(0, 0, size, size);

    // 绘制地球图标
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, size / 16);

    // 圆形
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 3, 0, Math.PI * 2);
    ctx.stroke();

    // 横线
    ctx.beginPath();
    ctx.moveTo(size * 0.2, size / 2);
    ctx.lineTo(size * 0.8, size / 2);
    ctx.stroke();

    // 竖线（椭圆）
    ctx.beginPath();
    ctx.ellipse(size / 2, size / 2, size / 8, size / 3, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 添加翻译符号 "A→中"
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${size / 4}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (size >= 48) {
        ctx.fillText('A→中', size / 2, size * 0.75);
    }
}

// 创建图标目录
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir);
}

// 生成不同尺寸的图标
const sizes = [16, 48, 128];

sizes.forEach(size => {
    const canvas = createCanvas(size, size);
    drawIcon(canvas, size);

    const buffer = canvas.toBuffer('image/png');
    const filePath = path.join(iconsDir, `icon${size}.png`);

    fs.writeFileSync(filePath, buffer);
    console.log(`✅ 生成图标: ${filePath}`);
});

console.log('\n🎉 所有图标生成完成！');
