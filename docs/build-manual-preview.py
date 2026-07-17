import re, base64, pathlib, shutil

md_path = pathlib.Path(__file__).with_name('教育訓練操作手冊.md')
out_html = pathlib.Path(__file__).with_name('教育訓練操作手冊-預覽.html')
public_dir = pathlib.Path(__file__).resolve().parents[1] / 'manual'
public_html = public_dir / 'index.html'
shots_src = pathlib.Path(__file__).with_name('training-screenshots')
shots_dst = public_dir / 'screenshots'
base = md_path.parent
text = md_path.read_text(encoding='utf-8')

# relative = public site; base64 = local offline preview
EMBED_MODE = 'base64'

def esc(s):
    return s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

def img_meta(src):
    src_path = (base / src.lstrip('./')).resolve()
    w = h = None
    if src_path.exists() and src_path.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'):
        try:
            from PIL import Image
            with Image.open(src_path) as im:
                w, h = im.size
        except Exception:
            pass
    return src_path, w, h

def img_tag(alt, src, css_class=''):
    src_path, w, h = img_meta(src)
    if not src_path.exists():
        return f'<p class="missing">[找不到圖片: {esc(src)}]</p>'
    cls = f' class="{css_class}"' if css_class else ''
    if EMBED_MODE == 'relative':
        return f'<img{cls} src="screenshots/{src_path.name}" alt="{esc(alt)}"/>'
    if src_path.suffix.lower() == '.svg':
        svg = re.sub(r'<\?xml[^?]*\?>', '', src_path.read_text(encoding='utf-8')).strip()
        return f'<div class="svg-wrap" role="img" aria-label="{esc(alt)}">{svg}</div>'
    data = base64.b64encode(src_path.read_bytes()).decode('ascii')
    return f'<img{cls} src="data:image/png;base64,{data}" alt="{esc(alt)}"/>'

def figure_class(src):
    if 'flowchart' in src:
        return 'flowchart'
    _, w, h = img_meta(src)
    # short UI crops (button bars) → keep display ~same size as 開案按鈕
    if h and h <= 180:
        return 'solo compact'
    return 'solo'

def inline(s):
    s = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', lambda m: img_tag(m.group(1), m.group(2)), s)
    s = re.sub(r'\[([^\]]+)\]\((#[^)]+)\)', lambda m: f'<a class="jump" href="{esc(m.group(2))}">{inline(m.group(1))}</a>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    return s

def heading_html(tag, text):
    m = re.match(r'^(.*?)\s*\{#([a-zA-Z0-9_-]+)\}\s*$', text)
    if m:
        return f'<{tag} id="{esc(m.group(2))}">{inline(m.group(1))}</{tag}>'
    return f'<{tag}>{inline(text)}</{tag}>'

def parse_table(rows):
    headers = [c.strip() for c in rows[0].strip('|').split('|')]
    is_step = headers and headers[0] in ('#', '標號', '順序')
    cls = 'step-table' if is_step else ''
    html = [f'<table class="{cls}">' if cls else '<table>']
    for ri, row in enumerate(rows):
        cells = [c.strip() for c in row.strip('|').split('|')]
        if ri == 1 and all(re.match(r'^:?-+:?$', c or '') for c in cells):
            continue
        tag = 'th' if ri == 0 else 'td'
        tds = []
        for ci, c in enumerate(cells):
            if is_step and ci == 0 and ri > 0 and re.match(r'^\d+$', c):
                tds.append(f'<{tag} class="num"><span class="badge">{esc(c)}</span></{tag}>')
            else:
                tds.append(f'<{tag}>{inline(c)}</{tag}>')
        html.append('<tr>' + ''.join(tds) + '</tr>')
    html.append('</table>')
    return ''.join(html)

def parse_flow_cards(body_lines):
    cards = []
    for line in body_lines:
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split('｜')]
        if len(parts) < 4:
            continue
        num, title, action, result = parts[0], parts[1], parts[2], parts[3]
        is_note = len(parts) >= 5 and parts[4] == 'note'
        second_cls = 'flow-note' if is_note else 'flow-result'
        second_label = '要請款時' if is_note else ''
        second_html = inline(result)
        if is_note:
            second_html = f'<span class="flow-note-label">{second_label}</span>{second_html}'
        else:
            second_html = f'<span class="flow-arrow">→</span> {second_html}'
        cards.append(
            f'<article class="flow-card">'
            f'<div class="flow-head"><span class="flow-num">{esc(num)}</span><span class="flow-title">{esc(title)}</span></div>'
            f'<div class="flow-action">{inline(action)}</div>'
            f'<div class="{second_cls}">{second_html}</div>'
            f'</article>'
        )
    return f'<div class="flow-cards">{"".join(cards)}</div>'

lines = text.splitlines()

def render_html():
    html_parts = []
    i = 0
    in_code = False
    code_buf = []
    while i < len(lines):
        line = lines[i]
        if line.startswith('```'):
            if not in_code:
                in_code = True; code_buf = []
            else:
                html_parts.append(f'<div class="flow-line"><code>{esc(chr(10).join(code_buf))}</code></div>')
                in_code = False
            i += 1; continue
        if in_code:
            code_buf.append(line); i += 1; continue
        img = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)\s*$', line)
        if img:
            alt, src = img.group(1), img.group(2)
            j = i + 1
            while j < len(lines) and not lines[j].strip(): j += 1
            if j < len(lines) and lines[j].startswith('|'):
                rows = []
                while j < len(lines) and lines[j].startswith('|'):
                    rows.append(lines[j]); j += 1
                if 'flowchart' in src:
                    html_parts.append(f'<figure class="flowchart">{img_tag(alt, src)}</figure>')
                    html_parts.append(f'<div class="table-wrap">{parse_table(rows)}</div>')
                else:
                    html_parts.append(f'<section class="card lr"><div class="lr-img">{img_tag(alt, src)}</div><div class="lr-txt">{parse_table(rows)}</div></section>')
                i = j; continue
            html_parts.append(f'<figure class="{figure_class(src)}">{img_tag(alt, src)}</figure>')
            i += 1; continue
        if line.strip() == ':::flow':
            body = []
            i += 1
            while i < len(lines) and lines[i].strip() != ':::':
                body.append(lines[i]); i += 1
            if i < len(lines) and lines[i].strip() == ':::':
                i += 1
            html_parts.append(parse_flow_cards(body))
            continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                rows.append(lines[i]); i += 1
            html_parts.append(f'<div class="table-wrap">{parse_table(rows)}</div>')
            continue
        if not line.strip():
            i += 1; continue
        if line.startswith('# '): html_parts.append(f'<header class="doc-head"><h1>{inline(line[2:])}</h1></header>')
        elif line.startswith('## '): html_parts.append(heading_html('h2', line[3:]))
        elif line.startswith('### '): html_parts.append(heading_html('h3', line[4:]))
        elif line.startswith('#### '): html_parts.append(heading_html('h4', line[5:]))
        elif line.startswith('> '): html_parts.append(f'<blockquote>{inline(line[2:])}</blockquote>')
        elif line.startswith('- '):
            items=[]
            while i < len(lines) and lines[i].startswith('- '):
                items.append(lines[i][2:]); i += 1
            html_parts.append('<ul>' + ''.join(f'<li>{inline(x)}</li>' for x in items) + '</ul>')
            continue
        elif re.match(r'^\d+\. ', line):
            html_parts.append('<div class="checklist">')
            while i < len(lines) and re.match(r'^\d+\. ', lines[i]):
                m = re.match(r'^(\d+)\. (.*)$', lines[i])
                html_parts.append(f'<div class="check-item"><span class="badge">{m.group(1)}</span><div>{inline(m.group(2))}</div></div>')
                i += 1
            html_parts.append('</div>')
            continue
        elif line.strip() == '---': html_parts.append('<hr/>')
        elif line.strip() == '待更新': html_parts.append('<p class="pending">待更新</p>')
        else: html_parts.append(f'<p>{inline(line)}</p>')
        i += 1
    return f'<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>璽墨專案管理系統 · 操作手冊</title><style>{style}</style></head><body><div class="hint">自學操作手冊 · 黃數字＝步驟</div><main>{"".join(html_parts)}</main></body></html>'

style = r'''
:root{--bg:#f4f1ec;--card:#fff;--text:#1c1b19;--border:#e4dfd7;--accent:#2d6a4f;--accent-soft:#e8f2ec;--badge:#f5c400;--badge-text:#1c1b19}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:"PingFang TC","Noto Sans TC","Helvetica Neue",sans-serif;background:var(--bg);color:var(--text);line-height:1.7}
.hint{position:sticky;top:0;z-index:20;background:#1c1b19;color:#fff;padding:10px 18px;font-size:13px}
main{max-width:1080px;margin:0 auto;padding:28px 22px 96px}
.doc-head h1{font-size:26px;font-weight:700;margin:8px 0 6px;letter-spacing:.02em}
h2{font-size:19px;font-weight:700;margin:42px 0 14px;padding:10px 14px;background:var(--accent-soft);border-left:4px solid var(--accent);border-radius:0 8px 8px 0;scroll-margin-top:56px}
h3{font-size:16px;font-weight:700;margin:28px 0 10px;scroll-margin-top:56px}
h4{font-size:14px;font-weight:700;margin:18px 0 8px;color:#3a3834}
p{font-size:14.5px;margin:8px 0 12px;color:#2a2926}
ul{padding-left:1.2em;margin:8px 0 14px}
li{font-size:14.5px;margin:4px 0}
blockquote{margin:12px 0;padding:10px 14px;background:#fff8e8;border-left:3px solid #e0a24a;border-radius:0 8px 8px 0;font-size:13.5px;color:#5a4a2a}
hr{border:none;border-top:1px solid var(--border);margin:28px 0}
code{background:#efeae3;padding:1px 6px;border-radius:4px;font-size:.92em}
.flow-line{margin:10px 0 16px;padding:12px 14px;background:#1c1b19;color:#f3efe8;border-radius:8px;font-size:13px;overflow-x:auto}
.flow-line code{background:transparent;color:inherit;padding:0}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:999px;background:var(--badge);color:var(--badge-text);border:1px solid #e0a800;font-size:12px;font-weight:700;line-height:1}
.checklist{display:grid;gap:8px;margin:12px 0 18px}
.check-item{display:grid;grid-template-columns:28px 1fr;gap:10px;align-items:start;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:14.5px}
.table-wrap{margin:12px 0 18px;background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:13.5px;table-layout:fixed}
th,td{border-bottom:1px solid var(--border);padding:10px 12px;text-align:left;vertical-align:top;word-break:keep-all;overflow-wrap:anywhere;line-height:1.55}
tr:last-child th,tr:last-child td{border-bottom:none}
th{background:#f3efe9;font-weight:700;color:#3d3a35}
.step-table th:first-child,.step-table td.num{width:44px;min-width:44px;max-width:52px;text-align:center;white-space:nowrap;padding-left:8px;padding-right:8px}
.flow-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:12px 0 14px}
.flow-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 14px 16px;min-height:100%}
.flow-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.flow-num{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:999px;background:#1c1b19;color:#fff;font-size:12px;font-weight:700;line-height:1}
.flow-title{font-size:13px;font-weight:700;color:#3d3a35}
.flow-action{font-size:13.5px;font-weight:600;color:#1c1b19;line-height:1.55;margin-bottom:8px}
.flow-result{font-size:12.5px;color:#6a655c;line-height:1.5}
.flow-arrow{color:#9a948a;margin-right:2px}
.flow-note{font-size:12.5px;color:#6a5320;line-height:1.5;padding:8px 10px;background:#fff8e8;border-radius:8px}
.flow-note-label{display:inline-block;margin-right:6px;padding:1px 6px;border-radius:999px;background:#f0d9a0;color:#5a4320;font-size:11px;font-weight:700}
.jump{display:inline-flex;align-items:center;margin:4px 6px 4px 0;padding:6px 12px;border-radius:999px;border:1px solid var(--border);background:#fff;color:var(--accent);text-decoration:none;font-size:13px;font-weight:600}
.jump:hover{background:var(--accent-soft);border-color:#b7d2c4}
.card.lr{display:grid;grid-template-columns:minmax(320px,1fr) minmax(260px,.9fr);gap:16px;align-items:start;margin:14px 0 22px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;box-shadow:0 1px 0 rgba(0,0,0,.02)}
.lr-img{width:100%}
.lr-img img{display:block;max-width:100%;width:auto;height:auto;border-radius:8px;border:1px solid var(--border)}
.lr-txt table{margin:0;border:none}
.lr-txt .step-table th:first-child,.lr-txt .step-table td.num{width:40px}
.flowchart{margin:12px 0 20px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;text-align:center}
.flowchart .svg-wrap{display:inline-block;max-width:100%}
.flowchart svg{max-width:700px;width:100%;height:auto}
.solo{margin:12px 0 18px;background:transparent;border:none;border-radius:0;padding:0}
.solo img{display:block;max-width:100%;width:auto;height:auto;border-radius:8px;border:1px solid var(--border)}
.solo.compact img{max-width:320px}
.pending{margin:12px 0 18px;padding:18px 16px;background:#fff8e8;border:1px dashed #e0a24a;border-radius:10px;color:#6a5320;font-size:14.5px;font-weight:600}
@media(max-width:860px){.card.lr{grid-template-columns:1fr}.flow-cards{grid-template-columns:1fr 1fr}}
@media(max-width:560px){.flow-cards{grid-template-columns:1fr}}
'''

# local offline preview (base64 images)
EMBED_MODE = 'base64'
out_html.write_text(render_html(), encoding='utf-8')
print('built', out_html)

# public shareable site
EMBED_MODE = 'relative'
public_dir.mkdir(parents=True, exist_ok=True)
shots_dst.mkdir(parents=True, exist_ok=True)
for src in re.findall(r'!\[[^\]]*\]\(([^)]+)\)', text):
    src_path = (base / src.lstrip('./')).resolve()
    if src_path.exists():
        shutil.copy2(src_path, shots_dst / src_path.name)
public_html.write_text(render_html(), encoding='utf-8')
print('built', public_html)
