# -*- coding: utf-8 -*-
"""
证据材料 PDF 合集生成器
用法:
    python merge_evidence.py <输出路径> <JSON文件列表>
示例:
    python merge_evidence.py "D:\\输出\\证据材料合集.pdf" '["D:/证据/收条1.jpg","D:/证据/判决书.pdf"]'

依赖:
    pip install PyMuPDF reportlab Pillow
"""
import sys, json, os, io
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image

try:
    import fitz  # PyMuPDF
    HAS_FITZ = True
except ImportError:
    HAS_FITZ = False

PAGE_W, PAGE_H = A4  # 595.27 x 841.89 pts
MARGIN = 5 * mm  # 5mm narrow border

def pil_to_imgdata(pil_img):
    """Convert PIL Image to reportlab-compatible ImageReader"""
    buf = io.BytesIO()
    pil_img.save(buf, format='PNG')
    buf.seek(0)
    return ImageReader(buf)

def jpg_to_pdf_a4_pages(jpg_path, rotation=0):
    """Convert JPG to list of A4 PDF pages (fills page, no crop)."""
    img = Image.open(jpg_path)
    w0, h0 = img.size
    if rotation:
        img = img.rotate(rotation, expand=True)
        w0, h0 = img.size
    pages = []
    content_w = PAGE_W - 2 * MARGIN
    content_h = PAGE_H - 2 * MARGIN
    scale = min(content_w / w0, content_h / h0)
    rendered_w = w0 * scale
    rendered_h = h0 * scale
    x = (PAGE_W - rendered_w) / 2
    y = (PAGE_H - rendered_h) / 2
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    pages.append({
        'type': 'img',
        'data': buf,
        'w': rendered_w,
        'h': rendered_h,
        'x': x,
        'y': y,
        'raw_size': (w0, h0)
    })
    return pages

def pdf_pages_to_a4_scaled(pdf_path, page_indices=None):
    """Render PDF pages as A4 images (fitz required). Returns list of page dicts."""
    if not HAS_FITZ:
        raise RuntimeError('PyMuPDF (fitz) not installed. Run: pip install PyMuPDF')
    doc = fitz.open(pdf_path)
    total = len(doc)
    indices = page_indices if page_indices else range(total)
    pages = []
    for pi in indices:
        page = doc[pi]
        # Detect rotation
        rot = page.rotation
        # Render at high DPI for quality
        mat = fitz.Matrix(2.0, 2.0)
        pix = page.get_pixmap(matrix=mat)
        img_data = pix.tobytes('png')
        pil_img = Image.open(io.BytesIO(img_data))
        # Auto-rotate landscape pages
        w0, h0 = pil_img.size
        if rot == 90:
            pil_img = pil_img.rotate(90, expand=True)
        elif rot == 180:
            pil_img = pil_img.rotate(180, expand=True)
        elif rot == 270:
            pil_img = pil_img.rotate(270, expand=True)
        # Scale to fit A4
        content_w = PAGE_W - 2 * MARGIN
        content_h = PAGE_H - 2 * MARGIN
        w, h = pil_img.size
        scale = min(content_w / w, content_h / h)
        rw, rh = w * scale, h * scale
        x = (PAGE_W - rw) / 2
        y = (PAGE_H - rh) / 2
        buf = io.BytesIO()
        pil_img.save(buf, format='PNG')
        buf.seek(0)
        pages.append({
            'type': 'img',
            'data': buf,
            'w': rw,
            'h': rh,
            'x': x,
            'y': y,
            'raw_size': (w, h)
        })
    doc.close()
    return pages

def add_page_number(c, page_num, total_pages):
    """Add centered page number at bottom of canvas."""
    c.saveState()
    c.setFont('Helvetica', 12)
    text = str(page_num)
    text_w = c.stringWidth(text, 'Helvetica', 12)
    c.drawString((PAGE_W - text_w) / 2, 15 * mm, text)
    c.restoreState()

def build_pdf(output_path, file_list):
    """
    Build merged A4 PDF from file_list.
    file_list: list of dicts: {'path': str, 'type': 'jpg'|'pdf', 'rotation': int (for jpg)}
    """
    c = canvas.Canvas(output_path, pagesize=A4)
    page_num = 0

    for item in file_list:
        fpath = item['path']
        ftype = item.get('type', 'pdf')
        rotation = item.get('rotation', 0)

        print(f'Processing: {os.path.basename(fpath)}')

        if ftype == 'jpg':
            pages = jpg_to_pdf_a4_pages(fpath, rotation)
        elif ftype == 'pdf':
            pages = pdf_pages_to_a4_scaled(fpath)
        else:
            continue

        for page in pages:
            c.setPageSize(A4)
            if page['type'] == 'img':
                page['data'].seek(0)
                img_reader = ImageReader(page['data'])
                c.drawImage(img_reader, page['x'], page['y'], width=page['w'], height=page['h'])
            page_num += 1
            add_page_number(c, page_num, -1)  # total unknown at this point
            c.showPage()

    c.save()
    print(f'Output: {output_path}')
    print(f'Total pages: {page_num}')

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    output = sys.argv[1]
    raw = json.loads(sys.argv[2])
    file_list = []
    for item in raw:
        if isinstance(item, str):
            ftype = 'jpg' if os.path.splitext(item)[1].lower() in ('.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff') else 'pdf'
            file_list.append({'path': item, 'type': ftype, 'rotation': 0})
        else:
            file_list.append(item)
    build_pdf(output, file_list)
