from pathlib import Path

p=Path('schedule.html')
s=p.read_text(encoding='utf-8')

old='''<div class="committee-in-contact">\n<div class="committee-in-contact-label">준비위원</div>\n<div class="committee-in-contact-list">\n<span>박혜림 7기</span>\n<span>안지현 9기</span>\n<span>이민주 10기</span>\n<span>이예린 18기</span>\n<span>주보근 20기</span>\n</div>\n<div class="committee-in-contact-label" style="margin-top:14px;">운영위원</div>\n<div class="committee-in-contact-list">\n<span>김미주 7기</span>\n<span>정지원 9기</span>\n<span>김동욱 10기</span>\n<span>이해리 11기</span>\n<span>조재영 22기</span>\n<span>윤여창 23기</span>\n<span>권능 23기</span>\n<span>송유진 25기</span>\n</div>\n</div>\n'''
if old in s:
    s=s.replace(old,'',1)

insert_after='''</div>\n</div>\n\n<div class="resource-card">'''
block='''</div>\n</div>\n\n<div class="committee-card">\n  <div class="committee-card-title">함께 준비하는 동문</div>\n  <div class="committee-row">\n    <div class="committee-row-label">준비위원</div>\n    <div class="committee-row-list">박혜림 7기 · 안지현 9기 · 이민주 10기 · 이예린 18기 · 주보근 20기</div>\n  </div>\n  <div class="committee-row">\n    <div class="committee-row-label">운영위원</div>\n    <div class="committee-row-list">김미주 7기 · 정지원 9기 · 김동욱 10기 · 이해리 11기 · 조재영 22기 · 윤여창 23기 · 권능 23기 · 송유진 25기</div>\n  </div>\n</div>\n\n<div class="resource-card">'''
if 'class="committee-card"' not in s and insert_after in s:
    s=s.replace(insert_after,block,1)

css_anchor='.committee-in-contact-list{display:flex;flex-wrap:wrap;gap:7px 15px;font-size:14px;font-weight:600}\n'
css='''.committee-in-contact-list{display:flex;flex-wrap:wrap;gap:7px 15px;font-size:14px;font-weight:600}\n.committee-card{margin:0 0 18px;padding:15px 18px;background:#fff;border:1px solid var(--line);border-radius:var(--radius)}\n.committee-card-title{margin-bottom:10px;font-size:14px;font-weight:900;color:var(--purple-dark)}\n.committee-row{display:grid;grid-template-columns:70px 1fr;gap:10px;padding:7px 0;border-top:1px solid var(--line)}\n.committee-row:first-of-type{border-top:none;padding-top:0}\n.committee-row-label{font-size:11.5px;font-weight:800;color:var(--sub)}\n.committee-row-list{font-size:12px;line-height:1.75;color:var(--ink);word-break:keep-all}\n'''
if css_anchor in s and '.committee-card{' not in s:
    s=s.replace(css_anchor,css,1)

p.write_text(s,encoding='utf-8')
