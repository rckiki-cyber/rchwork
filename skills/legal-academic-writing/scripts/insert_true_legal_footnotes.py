#!/usr/bin/env python3
"""Insert TRUE Word footnotes at explicit markers, including into a DOCX with no prior footnotes.

Input JSON:
[
  {"marker":"[[FN001]]", "text":"参见……第45页。"},
  {"marker":"[[FN002]]", "text":"参见……第80页。"}
]

This script NEVER creates endnotes.xml and NEVER inserts w:endnoteReference.
"""
from __future__ import annotations
import sys, json, zipfile, re
from copy import deepcopy
from lxml import etree

W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
PR='http://schemas.openxmlformats.org/package/2006/relationships'
CT='http://schemas.openxmlformats.org/package/2006/content-types'
NS={'w':W}
Q=lambda x:f'{{{W}}}{x}'
REL_F='http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes'
CT_F='application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml'


def xbytes(root):
    return etree.tostring(root,xml_declaration=True,encoding='UTF-8',standalone='yes')

def empty_footnotes():
    root=etree.Element(Q('footnotes'),nsmap={'w':W})
    a=etree.SubElement(root,Q('footnote')); a.set(Q('type'),'separator'); a.set(Q('id'),'-1')
    p=etree.SubElement(a,Q('p')); r=etree.SubElement(p,Q('r')); etree.SubElement(r,Q('separator'))
    b=etree.SubElement(root,Q('footnote')); b.set(Q('type'),'continuationSeparator'); b.set(Q('id'),'0')
    p=etree.SubElement(b,Q('p')); r=etree.SubElement(p,Q('r')); etree.SubElement(r,Q('continuationSeparator'))
    return root

def next_rid(rels):
    nums=[]
    for x in rels.findall(f'{{{PR}}}Relationship'):
        m=re.fullmatch(r'rId(\d+)',x.get('Id') or '')
        if m: nums.append(int(m.group(1)))
    return f'rId{max(nums,default=0)+1}'

def ensure_rel(rels):
    for x in rels.findall(f'{{{PR}}}Relationship'):
        if x.get('Type')==REL_F: return
    x=etree.SubElement(rels,f'{{{PR}}}Relationship')
    x.set('Id',next_rid(rels)); x.set('Type',REL_F); x.set('Target','footnotes.xml')

def ensure_ct(ct):
    for x in ct.findall(f'{{{CT}}}Override'):
        if x.get('PartName')=='/word/footnotes.xml':
            x.set('ContentType',CT_F); return
    x=etree.SubElement(ct,f'{{{CT}}}Override')
    x.set('PartName','/word/footnotes.xml'); x.set('ContentType',CT_F)

def existing_template(fnroot):
    for fn in fnroot.xpath('./w:footnote',namespaces=NS):
        try: i=int(fn.get(Q('id')))
        except: continue
        if i>0: return deepcopy(fn)
    return None

def max_positive_id(fnroot):
    ids=[]
    for fn in fnroot.xpath('./w:footnote',namespaces=NS):
        try: i=int(fn.get(Q('id')))
        except: continue
        if i>0: ids.append(i)
    return max(ids,default=0)

def create_fn(note_id,text,template=None):
    if template is not None:
        fn=deepcopy(template); fn.set(Q('id'),str(note_id))
        # remove all content except rebuild first paragraph to avoid carrying hyperlinks/fields from template
        for ch in list(fn): fn.remove(ch)
    else:
        fn=etree.Element(Q('footnote')); fn.set(Q('id'),str(note_id))
    p=etree.SubElement(fn,Q('p'))
    ppr=etree.SubElement(p,Q('pPr')); ps=etree.SubElement(ppr,Q('pStyle')); ps.set(Q('val'),'FootnoteText')
    r1=etree.SubElement(p,Q('r')); rp=etree.SubElement(r1,Q('rPr')); rs=etree.SubElement(rp,Q('rStyle')); rs.set(Q('val'),'FootnoteReference'); etree.SubElement(r1,Q('footnoteRef'))
    r2=etree.SubElement(p,Q('r')); t2=etree.SubElement(r2,Q('t')); t2.set('{http://www.w3.org/XML/1998/namespace}space','preserve'); t2.text=' '
    r3=etree.SubElement(p,Q('r')); t3=etree.SubElement(r3,Q('t')); t3.text=text
    return fn

def insert_marker_ref(doc,marker,note_id):
    # marker must be contained within one w:t; users/scripts should place marker as standalone text when possible.
    for t in doc.xpath('.//w:t',namespaces=NS):
        if t.text and marker in t.text:
            before,after=t.text.split(marker,1)
            t.text=before
            r=t.getparent()
            while r is not None and r.tag!=Q('r'): r=r.getparent()
            if r is None: continue
            parent=r.getparent(); idx=parent.index(r)
            nr=etree.Element(Q('r'))
            rpr=etree.SubElement(nr,Q('rPr')); rs=etree.SubElement(rpr,Q('rStyle')); rs.set(Q('val'),'FootnoteReference')
            ref=etree.SubElement(nr,Q('footnoteReference')); ref.set(Q('id'),str(note_id))
            parent.insert(idx+1,nr)
            if after:
                ar=deepcopy(r)
                for tt in ar.xpath('.//w:t',namespaces=NS): tt.text=''
                ats=ar.xpath('.//w:t',namespaces=NS)
                if ats: ats[0].text=after
                else:
                    at=etree.SubElement(ar,Q('t')); at.text=after
                parent.insert(idx+2,ar)
            return True
    return False

def ensure_styles(files):
    if 'word/styles.xml' not in files: return
    root=etree.fromstring(files['word/styles.xml'])
    ids={x.get(Q('styleId')) for x in root.xpath('./w:style',namespaces=NS)}
    if 'FootnoteText' not in ids:
        st=etree.SubElement(root,Q('style')); st.set(Q('type'),'paragraph'); st.set(Q('styleId'),'FootnoteText')
        name=etree.SubElement(st,Q('name')); name.set(Q('val'),'footnote text')
        based=etree.SubElement(st,Q('basedOn')); based.set(Q('val'),'Normal')
        ui=etree.SubElement(st,Q('uiPriority')); ui.set(Q('val'),'99')
        semi=etree.SubElement(st,Q('semiHidden'))
        unhide=etree.SubElement(st,Q('unhideWhenUsed'))
    if 'FootnoteReference' not in ids:
        st=etree.SubElement(root,Q('style')); st.set(Q('type'),'character'); st.set(Q('styleId'),'FootnoteReference')
        name=etree.SubElement(st,Q('name')); name.set(Q('val'),'footnote reference')
        ui=etree.SubElement(st,Q('uiPriority')); ui.set(Q('val'),'99')
        semi=etree.SubElement(st,Q('semiHidden')); unhide=etree.SubElement(st,Q('unhideWhenUsed'))
        rp=etree.SubElement(st,Q('rPr')); va=etree.SubElement(rp,Q('vertAlign')); va.set(Q('val'),'superscript')
    files['word/styles.xml']=xbytes(root)

def main():
    if len(sys.argv)!=4:
        raise SystemExit('usage: insert_true_legal_footnotes.py input.docx notes.json output.docx')
    src,jpath,out=sys.argv[1:]
    specs=json.load(open(jpath,'r',encoding='utf-8'))
    if not isinstance(specs,list) or not specs: raise SystemExit('notes.json must be a non-empty list')
    markers=[x['marker'] for x in specs]
    if len(markers)!=len(set(markers)): raise SystemExit('duplicate markers in notes.json')
    with zipfile.ZipFile(src) as zin:
        infos=zin.infolist(); files={i.filename:zin.read(i.filename) for i in infos}
    doc=etree.fromstring(files['word/document.xml'])
    fnroot=etree.fromstring(files['word/footnotes.xml']) if 'word/footnotes.xml' in files else empty_footnotes()
    template=existing_template(fnroot)
    nid=max_positive_id(fnroot)
    for spec in specs:
        marker=spec['marker']; text=spec['text']
        nid+=1
        if not insert_marker_ref(doc,marker,nid):
            raise SystemExit(f'marker not found in a single text run: {marker}')
        fnroot.append(create_fn(nid,text,template))
    rels=etree.fromstring(files['word/_rels/document.xml.rels']); ensure_rel(rels)
    ct=etree.fromstring(files['[Content_Types].xml']); ensure_ct(ct)
    files['word/document.xml']=xbytes(doc); files['word/footnotes.xml']=xbytes(fnroot)
    files['word/_rels/document.xml.rels']=xbytes(rels); files['[Content_Types].xml']=xbytes(ct)
    ensure_styles(files)
    # explicit safety: do not create or alter endnotes.xml
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as zout:
        written=set()
        for info in infos:
            name=info.filename
            zout.writestr(info,files[name]); written.add(name)
        for name,data in files.items():
            if name not in written: zout.writestr(name,data)
    print(f'OK: inserted {len(specs)} TRUE footnotes -> {out}')

if __name__=='__main__': main()
