from pathlib import Path

p=Path('schedule.html')
s=p.read_text(encoding='utf-8')

# Remove the separate committee card that was added later.
start=s.find('<div class="committee-card">')
if start!=-1:
    end=s.find('\n<div class="resource-card">', start)
    if end!=-1:
        s=s[:start]+s[end+1:]

# Restore the original public display: preparation committee only, inside the contact card.
contact_anchor='''<div class="info-actions">\n<a class="link-btn primary" id="contactTelBtn">문자하기</a>\n<a class="link-btn" id="contactMailBtn">이메일 보내기</a>\n</div>\n'''
committee='''<div class="info-actions">\n<a class="link-btn primary" id="contactTelBtn">문자하기</a>\n<a class="link-btn" id="contactMailBtn">이메일 보내기</a>\n</div>\n\n<div class="committee-in-contact">\n<div class="committee-in-contact-label">준비위원</div>\n<div class="committee-in-contact-list">\n<span>박혜림 7기</span>\n<span>안지현 9기</span>\n<span>이민주 10기</span>\n<span>이예린 18기</span>\n<span>주보근 20기</span>\n</div>\n</div>\n'''
if '<div class="committee-in-contact">' not in s and contact_anchor in s:
    s=s.replace(contact_anchor, committee, 1)

p.write_text(s,encoding='utf-8')
