"""Render three static design studies locally. No API, browser, or app changes.

Run: uv run --with pillow python design/leaderboards/render_mockups.py
Output: .context/leaderboards/ (illustrative figures, not live performance).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.context' / 'leaderboards'
OUT.mkdir(parents=True, exist_ok=True)
SCALE = 2
BG, INK, MUTED = '#f8f6f2', '#242322', '#77716b'
LINE, CORAL, GREEN = '#e4e0d9', '#e84640', '#23634e'
FONT = ROOT / 'public' / 'assets'
PEOPLE = [
    ('Alice', 'alice.jpg', '+24.8%', '+$1,240.00', True),
    ('Priya', 'priya.jpg', '+18.6%', '+$860.50', False),
    ('Dan', 'dan.jpg', '+12.4%', '+$2,680.00', True),
    ('Sam', None, '+9.2%', '+$420.00', False),
    ('Charlie', None, '−2.1%', '−$105.00', False),
]


def font(size, bold=False, heading=False):
    file = 'font-6.ttf' if heading else ('font-2.ttf' if bold else 'font-0.ttf')
    return ImageFont.truetype(str(FONT / file), round(size * SCALE))


def text(x, y, value, size=16, color=INK, bold=False, heading=False, align='left'):
    f = font(size, bold, heading)
    if align == 'right':
        x -= draw.textlength(value, font=f) / SCALE
    draw.text((round(x * SCALE), round(y * SCALE)), value, font=f, fill=color)


def line(x1, y1, x2, y2, color=LINE, width=1):
    draw.line(tuple(round(v * SCALE) for v in (x1, y1, x2, y2)), fill=color, width=width * SCALE)


def box(x, y, w, h, fill, radius=10, outline=None):
    draw.rounded_rectangle(tuple(round(v * SCALE) for v in (x, y, x + w, y + h)),
                           radius=radius * SCALE, fill=fill, outline=outline, width=SCALE)


def circle(x, y, radius, fill, outline=None):
    draw.ellipse(tuple(round(v * SCALE) for v in (x - radius, y - radius, x + radius, y + radius)),
                 fill=fill, outline=outline, width=SCALE)


def avatar(x, y, who, size=44):
    name, photo = who[0], who[1]
    if photo:
        pic = Image.open(ROOT / 'design' / 'leaderboards' / 'assets' / photo).convert('RGB')
        pic = ImageOps.fit(pic, (size * SCALE, size * SCALE), centering=(.5, .36))
        mask = Image.new('L', pic.size, 0)
        ImageDraw.Draw(mask).ellipse((0, 0, pic.width - 1, pic.height - 1), fill=255)
        canvas.paste(pic, (round(x * SCALE), round(y * SCALE)), mask)
    else:
        circle(x + size / 2, y + size / 2, size / 2, '#e9e4ee' if name == 'Sam' else '#e9eadf')
        text(x + 14, y + 10, name[0], 17, '#71627e', True)


def follow(x, y, active=False, icon_only=False):
    if icon_only:
        circle(x + 17, y + 17, 17, BG, LINE)
        if active:
            line(x + 10, y + 17, x + 15, y + 22, MUTED)
            line(x + 15, y + 22, x + 24, y + 12, MUTED)
        else:
            line(x + 11, y + 17, x + 23, y + 17, MUTED)
            line(x + 17, y + 11, x + 17, y + 23, MUTED)
    else:
        text(x, y + 7, 'Following' if active else '+ Follow', 14, MUTED if active else CORAL, True)


def start():
    global canvas, draw
    canvas = Image.new('RGB', (1440 * SCALE, 1024 * SCALE), BG)
    draw = ImageDraw.Draw(canvas)
    box(0, 0, 1440, 30, '#efede7', 0)
    text(720 - 97, 6, 'Design study · sample figures', 12, MUTED)
    # Swipr's existing wordmark and four-point mark, reproduced at natural proportions.
    points = [(60, 77), (65, 91), (79, 96), (65, 101), (60, 115), (55, 101), (41, 96), (55, 91)]
    draw.polygon([(x * SCALE, y * SCALE) for x, y in points], fill=CORAL)
    text(90, 73, 'swipr', 34, INK, heading=True)
    text(181, 73, '.', 34, CORAL, heading=True)
    labels = ['Discover', 'Ghosts', 'Matches', 'Leaderboards', 'Bots', 'You']
    for i, label in enumerate(labels):
        y = 190 + i * 57
        if label == 'Leaderboards':
            box(35, y - 10, 204, 44, '#fbeae6')
        text(59, y, label, 16, CORAL if label == 'Leaderboards' else MUTED, label == 'Leaderboards')
    text(48, 890, 'Find your people.', 16, INK, True)
    text(48, 916, 'Keep your own keys.', 16, INK, True)


def chevron(x, y):
    line(x - 4, y - 2, x, y + 2, MUTED)
    line(x, y + 2, x + 4, y - 2, MUTED)


def help_at(x, y):
    circle(x, y, 14, BG, LINE)
    text(x - 4, y - 9, '?', 14, MUTED)


def header(title='Leaderboards'):
    text(340, 91, title, 36, heading=True)
    help_at(1230, 116)


def tabs(x, y, a, b, first=True, size=16):
    text(x, y, a, size, INK if first else MUTED, first)
    gap = draw.textlength(a, font=font(size, first)) / SCALE + 30
    text(x + gap, y, b, size, MUTED if first else INK, not first)
    chosen_x = x if first else x + gap
    chosen = a if first else b
    w = draw.textlength(chosen, font=font(size, True)) / SCALE
    line(chosen_x, y + 34, chosen_x + w, y + 34, CORAL, 2)


def save(name):
    path = OUT / name
    canvas.save(path)
    print(path.relative_to(ROOT))


# People first: a single surface and two aligned performance columns.
start()
header()
tabs(340, 166, 'Traders', 'Copiers')
tabs(340, 238, 'Everyone', 'Following', size=14)
text(1088, 239, 'Sort: Return %', 14, MUTED)
chevron(1221, 249)
text(340, 312, 'RANK', 11, MUTED, True)
text(403, 312, 'TRADER', 11, MUTED, True)
text(955, 312, 'RETURN %', 11, MUTED, True, align='right')
text(1111, 312, 'NET PROFIT', 11, MUTED, True, align='right')
line(340, 342, 1245, 342)
for i, person in enumerate(PEOPLE):
    y = 365 + i * 85
    color = CORAL if i == 4 else GREEN
    text(347, y + 12, str(i + 1), 16, MUTED)
    avatar(403, y, person)
    text(463, y + 8, person[0], 19, INK, True)
    text(955, y + 10, person[2], 20, color, True, align='right')
    text(1111, y + 13, person[3], 16, MUTED, align='right')
    follow(1152, y + 3, person[4])
    if i < 4:
        line(403, y + 66, 1245, y + 66)
text(403, 817, 'Net profit after fees · closed positions', 12, MUTED)
save('01-people-first.png')

# Numbers first: one paired profit block per person, rather than column scaffolding.
start()
header()
tabs(340, 166, 'Traders', 'Copiers')
tabs(340, 238, 'Everyone', 'Following', size=14)
text(1093, 239, 'Sort: Net profit', 14, MUTED)
chevron(1231, 249)
for i, person in enumerate(sorted(PEOPLE, key=lambda p: {'Dan': 0, 'Alice': 1, 'Priya': 2, 'Sam': 3, 'Charlie': 4}[p[0]])):
    y = 324 + i * 98
    text(349, y + 18, str(i + 1), 16, MUTED)
    avatar(400, y + 4, person, 48)
    text(468, y + 8, person[0], 20, INK, True)
    text(1142, y + 2, person[3], 25, CORAL if person[0] == 'Charlie' else GREEN, True, align='right')
    text(1142, y + 37, person[2] + ' return', 13, MUTED, align='right')
    follow(1200, y + 11, person[4], True)
    if i < 4:
        line(400, y + 78, 1240, y + 78)
text(400, 854, 'Net profit after fees · closed positions', 12, MUTED)
save('02-numbers-first.png')

# Your circle: social scope is the main tab, and account type is one quiet menu.
start()
header('Your circle')
tabs(340, 170, 'Following', 'Everyone')
text(1004, 171, 'Copiers', 14, MUTED)
chevron(1074, 181)
text(1119, 171, 'Return %', 14, MUTED)
chevron(1208, 181)
line(340, 219, 1245, 219)
text(914, 270, 'RETURN %', 11, MUTED, True, align='right')
text(1104, 270, 'NET PROFIT', 11, MUTED, True, align='right')
for i, person in enumerate(PEOPLE[:3]):
    y = 316 + i * 100
    text(348, y + 16, str(i + 1), 16, MUTED)
    avatar(400, y, person, 52)
    text(472, y + 14, person[0], 21, INK, True)
    text(914, y + 16, person[2], 21, GREEN, True, align='right')
    text(1104, y + 20, person[3], 16, MUTED, align='right')
    follow(1195, y + 10, True, True)
    if i < 2:
        line(400, y + 78, 1245, y + 78)
text(400, 656, '3 people you follow', 13, MUTED)
text(400, 685, 'Find more people →', 14, CORAL, True)
text(400, 821, 'Net profit after fees · closed positions', 12, MUTED)
save('03-your-circle.png')
