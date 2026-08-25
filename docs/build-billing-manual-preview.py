"""Build HTML preview for 付款申請與請款操作手冊."""
import re, base64, pathlib, shutil

md_path = pathlib.Path(__file__).with_name('付款申請與請款操作手冊.md')
out_html = pathlib.Path(__file__).with_name('付款申請與請款操作手冊-預覽.html')
public_dir = pathlib.Path(__file__).resolve().parents[1] / 'manual' / 'billing'
public_html = public_dir / 'index.html'
shots_dst = public_dir / 'screenshots'
base = md_path.parent
text = md_path.read_text(encoding='utf-8')
EMBED_MODE = 'base64'
PAGE_TITLE = '付款申請與請款 · 操作手冊'
HINT_TEXT = '付款申請與請款操作手冊 · 黃數字＝步驟'

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
    data = base64.b64encode(src_path.read_bytes()).decode('ascii')
    mime = 'image/png' if src_path.suffix.lower() == '.png' else 'image/jpeg'
    return f'<img{cls} src="data:{mime};base64,{data}" alt="{esc(alt)}"/>'

def figure_class(src):
    _, w, h = img_meta(src)
    if h and h <= 180:
        return 'solo compact'
    return 'solo'

def inline(s):
    s = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', lambda m: img_tag(m.group(1), m.group(2)), s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    return s

def heading_html(tag, text):
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

def parse_desc_text(rows):
    """Single-column 說明 table → plain paragraph."""
    parts = []
    for ri, row in enumerate(rows):
        cells = [c.strip() for c in row.strip('|').split('|')]
        if ri == 0:
            continue
        if ri == 1 and all(re.match(r'^:?-+:?$', c or '') for c in cells):
            continue
        for c in cells:
            if c:
                parts.append(inline(c))
    return ''.join(parts)

def step_block(desc_html, img_htmls):
    if isinstance(img_htmls, str):
        img_htmls = [img_htmls]
    imgs = ''.join(f'<div class="step-img">{h}</div>' for h in img_htmls)
    return (
        f'<section class="step-block">'
        f'<div class="step-desc">{desc_html}</div>'
        f'{imgs}'
        f'</section>'
    )

def collect_imgs(start):
    """Collect consecutive markdown images starting at start index."""
    imgs = []
    j = start
    while j < len(lines):
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j >= len(lines):
            break
        m = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)\s*$', lines[j])
        if not m:
            break
        imgs.append(img_tag(m.group(1), m.group(2)))
        j += 1
    return imgs, j

lines = text.splitlines()

GATE_STYLE = '''
#manual-gate{position:fixed;inset:0;z-index:999;display:flex;align-items:center;justify-content:center;background:#f4f1ec}
#manual-gate .gate-box{max-width:340px;text-align:center;padding:28px 26px;background:#fff;border:1px solid #e4dfd7;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
#manual-gate h2{all:unset;display:block;font-size:17px;font-weight:700;color:#1c1b19;margin-bottom:8px}
#manual-gate p{font-size:13px;color:#6a655c;line-height:1.6;margin:0 0 18px}
#manual-gate a.gate-btn{display:inline-block;padding:11px 22px;border-radius:8px;background:#2d6a4f;color:#fff;text-decoration:none;font-size:14px;font-weight:600}
body.gated main,body.gated .hint{display:none}
'''

GATE_SCRIPT = '''
<div id="manual-gate"><div class="gate-box"><h2>請先登入系統</h2>
<p>操作手冊僅供內部人員檢視。請先用<strong>同一個瀏覽器</strong>登入璽墨系統（Lark 帳號），登入成功後會自動回到本頁。</p>
<a class="gate-btn" href="/" id="manual-gate-login">前往 Lark 登入</a></div></div>
<script>(function(){var KEY='ximo-login-user',MAX=10*60*60*1000,REDIRECT_KEY='ximo-post-login-redirect';
function ok(){try{var raw=localStorage.getItem(KEY)||sessionStorage.getItem(KEY);if(!raw)return false;var u=JSON.parse(raw);
if(!u||!(u.name||u.enName))return false;var started=Number(u.sessionStartedAt||0);if(started&&Date.now()-started>MAX)return false;
var exp=Number(u.tokenExpiresAt||0);if(exp&&Date.now()>exp)return false;return true;}catch(e){return false;}}
var gate=document.getElementById('manual-gate');var loginBtn=document.getElementById('manual-gate-login');
if(loginBtn){loginBtn.addEventListener('click',function(){try{sessionStorage.setItem(REDIRECT_KEY,location.pathname+location.search);}catch(e){}});}
if(ok()){if(gate)gate.remove();document.body.classList.remove('gated');}else{document.body.classList.add('gated');}})();</script>
'''

style = r'''
:root{--bg:#f4f1ec;--card:#fff;--text:#1c1b19;--border:#e4dfd7;--accent:#2d6a4f;--accent-soft:#e8f2ec}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font-family:"PingFang TC","Noto Sans TC","Helvetica Neue",sans-serif;background:var(--bg);color:var(--text);line-height:1.7}
.hint{position:sticky;top:0;z-index:20;background:#1c1b19;color:#fff;padding:10px 18px;font-size:13px}
main{max-width:1320px;margin:0 auto;padding:28px 32px 96px}
.doc-head h1{font-size:28px;font-weight:700;margin:8px 0 20px}
h2.section-title{font-size:19px;font-weight:700;margin:48px 0 20px;padding:10px 14px;background:var(--accent-soft);border-left:4px solid var(--accent);border-radius:0 8px 8px 0;scroll-margin-top:56px}
h3.section-step{display:flex;align-items:center;gap:12px;margin:36px 0 14px;padding:0;background:transparent;border:none;scroll-margin-top:56px}
h3.section-step .step-num{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;font-size:17px;font-weight:700;flex-shrink:0}
h3.section-step .step-label{font-size:20px;font-weight:700;color:var(--text)}
.doc-purpose{font-size:16px;color:#3d3a35;margin:0 0 16px;padding:14px 16px;background:#fff;border:1px solid var(--border);border-radius:10px}
p{font-size:16px;margin:8px 0 12px;color:#2a2926}
ul{padding-left:1.2em;margin:8px 0 14px}li{font-size:16px;margin:4px 0}
hr{border:none;border-top:1px solid var(--border);margin:36px 0}
code{background:#efeae3;padding:1px 6px;border-radius:4px;font-size:.92em}
.step-block{margin:0 0 8px;padding:22px 26px 26px;background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.step-desc{font-size:16.5px;line-height:1.8;color:#2a2926;margin-bottom:20px}
.step-desc p{margin:0}
.step-note{margin:0 0 12px;font-size:15px}
.step-img{margin-top:16px}
.step-desc + .step-img{margin-top:4px}
.step-img img{display:block;width:100%;max-width:100%;height:auto;border-radius:10px;border:1px solid var(--border)}
.table-wrap{margin:12px 0 18px;background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:15px}
th,td{border-bottom:1px solid var(--border);padding:10px 12px;text-align:left;vertical-align:top;line-height:1.55}
tr:last-child th,tr:last-child td{border-bottom:none}
th{background:#f3efe9;font-weight:700;color:#3d3a35}
.solo{margin:12px 0 18px}.solo img{display:block;width:100%;max-width:100%;height:auto;border-radius:10px;border:1px solid var(--border)}
'''

def render_html(gated=False):
    html_parts = []
    i = 0
    section_slug = 'doc'
    is_doc_title = True
    while i < len(lines):
        line = lines[i]
        img = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)\s*$', line)
        if img:
            alt, src = img.group(1), img.group(2)
            j = i + 1
            while j < len(lines) and not lines[j].strip(): j += 1
            if j < len(lines) and lines[j].startswith('|'):
                rows = []
                while j < len(lines) and lines[j].startswith('|'):
                    rows.append(lines[j]); j += 1
                html_parts.append(step_block(parse_desc_text(rows), img_tag(alt, src)))
                i = j; continue
            html_parts.append(f'<figure class="{figure_class(src)}">{img_tag(alt, src)}</figure>')
            i += 1; continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                rows.append(lines[i]); i += 1
            imgs, j = collect_imgs(i)
            if imgs:
                html_parts.append(step_block(parse_desc_text(rows), imgs))
                i = j; continue
            html_parts.append(f'<div class="table-wrap">{parse_table(rows)}</div>')
            continue
        if not line.strip():
            i += 1; continue
        if line.startswith('# '):
            title = line[2:]
            if is_doc_title:
                html_parts.append(f'<header class="doc-head"><h1>{inline(title)}</h1></header>')
                is_doc_title = False
            else:
                if '基礎' in title or '同步說明' in title:
                    section_slug = 'base'
                elif '付款' in title:
                    section_slug = 'pay'
                elif '請款' in title:
                    section_slug = 'bill'
                html_parts.append(f'<h2 class="section-title">{inline(title)}</h2>')
        elif line.startswith('## '):
            title = line[3:]
            m = re.match(r'^(步驟|說明)\s*(\d+)\s*$', title)
            if m:
                kind, num = m.group(1), m.group(2)
                html_parts.append(
                    f'<h3 class="section-step" id="step-{section_slug}-{num}">'
                    f'<span class="step-num">{esc(num)}</span>'
                    f'<span class="step-label">{esc(kind)} {esc(num)}</span></h3>'
                )
            else:
                html_parts.append(heading_html('h2', title))
        elif line.startswith('### '): html_parts.append(heading_html('h3', line[4:]))
        elif line.strip() == '---': html_parts.append('<hr/>')
        elif line.startswith('<span'):
            html_parts.append(f'<p class="step-note">{inline(line)}</p>')
        elif line.startswith('**專案目的：**'):
            html_parts.append(f'<p class="doc-purpose">{inline(line)}</p>')
        else: html_parts.append(f'<p>{inline(line)}</p>')
        i += 1
    gate_css = GATE_STYLE if gated else ''
    gate_body = GATE_SCRIPT if gated else ''
    body_cls = ' class="gated"' if gated else ''
    return f'''<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(PAGE_TITLE)}</title>
<style>
{style}
{gate_css}
</style>
</head>
<body{body_cls}>
<div class="hint">{esc(HINT_TEXT)}</div>
<main>
{chr(10).join(html_parts)}
</main>
{gate_body}
</body>
</html>'''

if __name__ == '__main__':
    EMBED_MODE = 'base64'
    out_html.write_text(render_html(gated=False), encoding='utf-8')
    print('built', out_html)

    EMBED_MODE = 'relative'
    public_dir.mkdir(parents=True, exist_ok=True)
    shots_dst.mkdir(parents=True, exist_ok=True)
    for src in re.findall(r'!\[[^\]]*\]\(([^)]+)\)', text):
        src_path = (base / src.lstrip('./')).resolve()
        if src_path.exists():
            shutil.copy2(src_path, shots_dst / src_path.name)
    public_html.write_text(render_html(gated=True), encoding='utf-8')
    print('built', public_html)

    # Windows-friendly offline package: HTML + screenshots (no base64, no login gate)
    portable_dir = pathlib.Path(__file__).with_name('付款申請與請款操作手冊-離線包')
    if portable_dir.exists():
        shutil.rmtree(portable_dir)
    portable_shots = portable_dir / 'screenshots'
    portable_shots.mkdir(parents=True)
    for src in re.findall(r'!\[[^\]]*\]\(([^)]+)\)', text):
        src_path = (base / src.lstrip('./')).resolve()
        if src_path.exists():
            shutil.copy2(src_path, portable_shots / src_path.name)
    EMBED_MODE = 'relative'
    # UTF-8 BOM helps some Windows browsers detect encoding
    (portable_dir / 'index.html').write_text(
        '\ufeff' + render_html(gated=False), encoding='utf-8'
    )
    zip_path = pathlib.Path(__file__).with_name('付款申請與請款操作手冊-離線包.zip')
    if zip_path.exists():
        zip_path.unlink()
    shutil.make_archive(str(zip_path.with_suffix('')), 'zip', portable_dir)
    print('built', zip_path)
