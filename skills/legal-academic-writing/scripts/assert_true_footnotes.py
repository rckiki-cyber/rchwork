#!/usr/bin/env python3
from __future__ import annotations
import sys, zipfile
from lxml import etree
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
PR='http://schemas.openxmlformats.org/package/2006/relationships'
CT='http://schemas.openxmlformats.org/package/2006/content-types'
NS={'w':W}
if len(sys.argv)<2:
    raise SystemExit('usage: assert_true_footnotes.py file.docx [--allow-existing-endnotes]')
path=sys.argv[1]; allow='--allow-existing-endnotes' in sys.argv[2:]
with zipfile.ZipFile(path) as z:
    names=set(z.namelist())
    errs=[]
    if 'word/footnotes.xml' not in names: errs.append('missing word/footnotes.xml')
    doc=etree.fromstring(z.read('word/document.xml'))
    fnrefs=[int(x.get(f'{{{W}}}id')) for x in doc.xpath('.//w:footnoteReference',namespaces=NS)]
    enrefs=[int(x.get(f'{{{W}}}id')) for x in doc.xpath('.//w:endnoteReference',namespaces=NS)]
    if not fnrefs: errs.append('no w:footnoteReference in document.xml')
    if enrefs and not allow: errs.append(f'endnote references present: {enrefs[:20]}')
    if 'word/footnotes.xml' in names:
        fr=etree.fromstring(z.read('word/footnotes.xml'))
        defs=[int(x.get(f'{{{W}}}id')) for x in fr.xpath('./w:footnote',namespaces=NS)]
        miss=sorted(set(i for i in fnrefs if i>0)-set(i for i in defs if i>0))
        if miss: errs.append(f'footnote refs missing definitions: {miss}')
        specials={(int(x.get(f'{{{W}}}id')),x.get(f'{{{W}}}type')) for x in fr.xpath('./w:footnote',namespaces=NS) if int(x.get(f'{{{W}}}id'))<=0}
        if not any(i==-1 for i,t in specials): errs.append('separator id=-1 missing')
        if not any(i==0 for i,t in specials): errs.append('continuationSeparator id=0 missing')
    # rel
    rr=etree.fromstring(z.read('word/_rels/document.xml.rels'))
    if not any((x.get('Type') or '').endswith('/footnotes') for x in rr.findall(f'{{{PR}}}Relationship')):
        errs.append('footnotes relationship missing')
    ct=etree.fromstring(z.read('[Content_Types].xml'))
    if not any(x.get('PartName')=='/word/footnotes.xml' for x in ct.findall(f'{{{CT}}}Override')):
        errs.append('footnotes content type override missing')
if errs:
    print('FAIL')
    for e in errs: print('-',e)
    raise SystemExit(2)
print('PASS: true Word footnotes structurally valid')
