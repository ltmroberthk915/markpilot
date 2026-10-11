"""MarkPilot CM6 图标生成（1024 画布绘制 → 多尺寸 ICO）。

设计（2026 主流取向，保留此前反馈的三条硬约束）：
  ① **全出血**：图形占画布 ~92%，不大留白——否则在任务栏/桌面比同类程序显小（沿用旧约束）；
  ② **高亮高饱和**：单一主色（靛蓝）＋极轻的顶部光，不再用"青→紫→品红"三段彩虹渐变；
  ③ 16px 仍可辨：粗笔画几何 M（笔画比约 0.12），不用细线/小字（沿用旧约束）；
  ④ **去掉右上星芒**：它属于 2018–2021 那批"渐变+字母+闪光"的通用套路，是显旧的主因；
     现代主流（Linear / Raycast / Notion 一类）是**纯字形极简** ⇒ 只留 M，不加装饰。
  另：主色取中间明度的靛蓝，浅色与深色任务栏都能站住（不会像纯深底图标那样在深色栏里消失）。
"""
from PIL import Image, ImageDraw, ImageFilter
import os

S = 1024          # 绘制画布
OUT_DIR = r"E:\MarkPilot\MarkPilot-CM6\build"
os.makedirs(OUT_DIR, exist_ok=True)

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def vgrad(size, top, bottom):
    """竖向明度过渡（很轻，只是让平面不死）"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        c = lerp(top, bottom, y / (size - 1))
        for x in range(size):
            px[x, y] = c
    return img

# ① 底：单一靛蓝，顶亮底暗各约 8%（不再多色渐变）
TOP, BOT = (99, 113, 255), (63, 76, 226)
base = vgrad(S, TOP, BOT).convert("RGBA")

# ② 顶部柔光：一块极轻的白色斜向洗（alpha 上限 ~40），让上沿"有光"而不是平涂
wash = Image.new("L", (S, S), 0)
ImageDraw.Draw(wash).polygon([(0, 0), (S, 0), (S * 0.55, S * 0.34), (0, S * 0.46)], fill=40)
wash = wash.filter(ImageFilter.GaussianBlur(S * 0.07))
base.alpha_composite(Image.merge("RGBA", (*Image.new("RGB", (S, S), (255, 255, 255)).split(), wash)))

# ③ 圆角遮罩（半径 22.5%，接近 Win11/macOS 的 squircle 观感）
R = int(S * 0.225)
big = S * 4
mask = Image.new("L", (big, big), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=R * 4, fill=255)
mask = mask.resize((S, S), Image.LANCZOS)

# ④ 白色几何 M：左右竖笔 + 两条斜笔汇到中腰（V 不落底），笔画加圆头
m = Image.new("RGBA", (S, S), (0, 0, 0, 0))
dm = ImageDraw.Draw(m)
WHITE = (255, 255, 255, 255)
L, Rt = S * 0.170, S * 0.830          # 左右外缘（去掉星芒后 ⇒ 可以对称铺满，更稳）
top, bot = S * 0.262, S * 0.738       # 上下外缘
w = S * 0.122                         # 笔画宽度
midx = (L + Rt) / 2
midy = top + (bot - top) * 0.60       # 中腰（V 的谷底，刻意不落底 ⇒ 更现代）

dm.rounded_rectangle([L, top, L + w, bot], radius=w * 0.34, fill=WHITE)
dm.rounded_rectangle([Rt - w, top, Rt, bot], radius=w * 0.34, fill=WHITE)

def stroke(a, b, width):
    """等宽斜笔画：A→B 的四边形（按法线偏移 width/2）＋两端圆头"""
    import math
    ax, ay = a; bx, by = b
    dx, dy = bx - ax, by - ay
    ln = math.hypot(dx, dy) or 1
    px, py = -dy / ln * width / 2, dx / ln * width / 2
    dm.polygon([(ax + px, ay + py), (bx + px, by + py), (bx - px, by - py), (ax - px, ay - py)], fill=WHITE)
    for (cx, cy) in (a, b):
        dm.ellipse([cx - width / 2, cy - width / 2, cx + width / 2, cy + width / 2], fill=WHITE)

stroke((L + w * 0.5, top + w * 0.42), (midx, midy), w)
stroke((Rt - w * 0.5, top + w * 0.42), (midx, midy), w)

icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.alpha_composite(base)
icon.alpha_composite(m)
icon.putalpha(Image.composite(icon.getchannel("A"), Image.new("L", (S, S), 0), mask))

icon.save(os.path.join(OUT_DIR, "icon-1024.png"))
sizes = [256, 128, 64, 48, 32, 24, 16]
frames = [icon.resize((s, s), Image.LANCZOS) for s in sizes]
frames[0].save(os.path.join(OUT_DIR, "icon.ico"), format="ICO",
               sizes=[(s, s) for s in sizes], append_images=frames[1:])

# 预览表：上排各尺寸（深底），下排同样尺寸（浅底）⇒ 两种任务栏都能一眼判断
pad, gap = 16, 14
W = pad * 2 + sum(sizes) + gap * (len(sizes) - 1)
H = 150 * 2 + 24
prev = Image.new("RGBA", (W, H), (24, 26, 32, 255))
strip = Image.new("RGBA", (W, 150), (242, 244, 248, 255))
prev.alpha_composite(strip, (0, 150))
for row, ycenter in ((0, 75), (1, 225)):
    x = pad
    for s in sizes:
        im = icon.resize((s, s), Image.LANCZOS)
        prev.alpha_composite(im, (x, ycenter - s // 2))
        x += s + gap
prev.save(os.path.join(OUT_DIR, "icon-preview.png"))
print("生成:", os.path.join(OUT_DIR, "icon.ico"), "尺寸:", sizes)
