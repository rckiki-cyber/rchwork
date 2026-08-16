#!/usr/bin/env python3
from pathlib import Path
import json, subprocess, sys, zipfile, tempfile
from docx import Document
from lxml import etree
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'

def main():
    here=Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory() as td:
        td=Path(td)
        src=td/'no_footnotes.docx'; out=td/'with_footnotes.docx'; js=td/'notes.json'
        d=Document(); d.add_paragraph('这是一个原本没有脚注的论文段落。[[FN001]] 后续文字。'); d.save(src)
        js.write_text(json.dumps([{'marker':'[[FN001]]','text':'参见张三：《测试文献》，载《法学研究》2025年第1期，第10页。'}],ensure_ascii=False),encoding='utf-8')
        subprocess.check_call([sys.executable,str(here/'insert_true_legal_footnotes.py'),str(src),str(js),str(out)])
        subprocess.check_call([sys.executable,str(here/'assert_true_footnotes.py'),str(out)])
        with zipfile.ZipFile(out) as z:
            assert 'word/footnotes.xml' in z.namelist()
            doc=etree.fromstring(z.read('word/document.xml'))
            assert len(doc.xpath('.//*[local-name()="footnoteReference"]'))==1
            assert len(doc.xpath('.//*[local-name()="endnoteReference"]'))==0
        print('SELF-TEST PASS')
if __name__=='__main__': main()
