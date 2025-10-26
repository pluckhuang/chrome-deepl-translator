#!/usr/bin/env python3
"""
使用 PIL/Pillow 生成 Chrome 插件图标
运行: python3 generate_icons.py
需要安装: pip install pillow
"""

from PIL import Image, ImageDraw, ImageFont
import os

def create_icon(size, output_path):
    """创建指定尺寸的图标"""
    # 创建图像
    img = Image.new('RGB', (size, size), color='#0066cc')
    draw = ImageDraw.Draw(img)

    # 计算尺寸
    center = size // 2
    radius = size // 3
    line_width = max(2, size // 16)

    # 绘制圆形地球
    draw.ellipse(
        [center - radius, center - radius, center + radius, center + radius],
        outline='white',
        width=line_width
    )

    # 绘制横线
    draw.line(
        [(size * 0.2, center), (size * 0.8, center)],
        fill='white',
        width=line_width
    )

    # 绘制竖线（椭圆）
    v_radius_x = size // 8
    v_radius_y = size // 3
    draw.ellipse(
        [center - v_radius_x, center - v_radius_y,
         center + v_radius_x, center + v_radius_y],
        outline='white',
        width=line_width
    )

    # 添加文字（仅在大图标上）
    if size >= 48:
        try:
            # 尝试使用系统字体
            font_size = size // 5
            try:
                # macOS 字体
                font = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", font_size)
            except:
                try:
                    # 备用字体
                    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
                except:
                    # 使用默认字体
                    font = ImageFont.load_default()

            text = "译"
            # 获取文本边界框
            bbox = draw.textbbox((0, 0), text, font=font)
            text_width = bbox[2] - bbox[0]
            text_height = bbox[3] - bbox[1]

            # 在底部居中绘制文字
            text_x = center - text_width // 2
            text_y = size * 0.65
            draw.text((text_x, text_y), text, fill='white', font=font)
        except Exception as e:
            print(f"警告: 无法添加文字到 {size}x{size} 图标: {e}")

    # 保存图标
    img.save(output_path, 'PNG')
    print(f"✅ 生成图标: {output_path}")

def main():
    # 创建 icons 目录
    icons_dir = os.path.join(os.path.dirname(__file__), 'icons')
    os.makedirs(icons_dir, exist_ok=True)

    # 生成不同尺寸的图标
    sizes = [16, 48, 128]

    for size in sizes:
        output_path = os.path.join(icons_dir, f'icon{size}.png')
        create_icon(size, output_path)

    print('\n🎉 所有图标生成完成！')
    print(f'图标位置: {icons_dir}')

if __name__ == '__main__':
    main()
