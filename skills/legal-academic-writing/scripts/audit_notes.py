#!/usr/bin/env python3
from __future__ import annotations
import sys, zipfile, re
from lxml import etree

W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PR='http://schemas.openxmlformats.org/package/2006/relationships'
CT='http://schemas.openxmlformats.org/package/2006/content-types'
NS={'w':W,'rel':PR,'ct':CT}

if len(sys.argv)!=2:
    raise SystemExit('usage: audit_notes.py file.docx')
path=sys.argv[1]
with zipfile.ZipFile(path) as z:
    names=set(z.namelist())
    doc=etree.fromstring(z.read('word/document.xml'))
    fnrefs=[int(x.get(f'{{{W}}}id')) for x in doc.xpath('.//w:footnoteReference',namespaces=NS)]
    enrefs=[int(x.get(f'{{{W}}}id')) for x in doc.xpath('.//w:endnoteReference',namespaces=NS)]
    fndef=[]; endef=[]
    if 'word/footnotes.xml' in names:
        root=etree.fromstring(z.read('word/footnotes.xml'))
        fndef=[int(x.get(f'{{{W}}}id')) for x in root.xpath('./w:footnote',namespaces=NS)]
    if 'word/endnotes.xml' in names:
        root=etree.fromstring(z.read('word/endnotes.xml'))
        endef=[int(x.get(f'{{{W}}}id')) for x in root.xpath('./w:endnote',namespaces=NS)]
    rel_ok=False
    if 'word/_rels/document.xml.rels' in names:
        rr=etree.fromstring(z.read('word/_rels/document.xml.rels'))
        rel_ok=any((x.get('Type') or '').endswith('/footnotes') for x in rr.findall(f'{{{PR}}}Relationship'))
    ct_ok=False
    ct=etree.fromstring(z.read('[Content_Types].xml'))
    for x in ct.findall(f'{{{CT}}}Override'):
        if x.get('PartName')=='/word/footnotes.xml' and (x.get('ContentType') or '').endswith('wordprocessingml.footnotes+xml'):
            ct_ok=True
    # crude manual superscript suspicion
    supers=[]
    for r in doc.xpath('.//w:r',namespaces=NS):
        va=r.find('.//w:vertAlign',namespaces=NS)
        if va is not None and va.get(f'{{{W}}}val')=='superscript':
            txt=''.join(r.xpath('.//w:t/text()',namespaces=NS))
            if re.fullmatch(r'[\d①②③④⑤⑥⑦⑧⑨⑩]+',txt or ''):
                supers.append(txt)

print(f'TRUE FOOTNOTE REFERENCES: {len(fnrefs)} ids={fnrefs[:20]}')
print(f'ENDNOTE REFERENCES: {len(enrefs)} ids={enrefs[:20]}')
print(f'FOOTNOTE PART: {"exists" if "word/footnotes.xml" in names else "missing"}')
print(f'ENDNOTE PART: {"exists" if "word/endnotes.xml" in names else "missing"}')
print(f'FOOTNOTE DEFINITIONS: {len([i for i in fndef if i>0])} positive_ids={[i for i in fndef if i>0][:20]}')
print(f'ENDNOTE DEFINITIONS: {len([i for i in endef if i>0])} positive_ids={[i for i in endef if i>0][:20]}')
print(f'FOOTNOTE RELATIONSHIP: {"ok" if rel_ok else "missing"}')
print(f'FOOTNOTE CONTENT TYPE: {"ok" if ct_ok else "missing"}')
print(f'MANUAL SUPERSCRIPT NOTE NUMBERS SUSPECTED: {len(supers)} {supers[:20]}')
print(f'REF->DEF MISSING: {sorted(set(i for i in fnrefs if i>0)-set(i for i in fndef if i>0))}')
print(f'DEF WITHOUT REF: {sorted(set(i for i in fndef if i>0)-set(i for i in fnrefs if i>0))}')
