import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from document.ocr.router import _assemble_ocr_text


def test_assemble_ocr_text_groups_words_by_line():
    blocks = [
        {"text": "Legal", "bbox": [10, 10, 50, 24]},
        {"text": "Representative", "bbox": [58, 10, 155, 24]},
        {"text": "John", "bbox": [162, 10, 198, 24]},
        {"text": "Smith", "bbox": [204, 10, 250, 24]},
        {"text": "电话：", "bbox": [10, 34, 50, 48]},
        {"text": "13812345678", "bbox": [50, 34, 150, 48]},
    ]

    assert _assemble_ocr_text(blocks) == "Legal Representative John Smith\n电话：13812345678"


def test_assemble_ocr_text_keeps_paragraph_gap():
    blocks = [
        {"text": "第一条", "bbox": [10, 10, 50, 24]},
        {"text": "合同目的", "bbox": [58, 10, 120, 24]},
        {"text": "第二条", "bbox": [10, 72, 50, 86]},
        {"text": "履行方式", "bbox": [58, 72, 120, 86]},
    ]

    assert _assemble_ocr_text(blocks) == "第一条合同目的\n\n第二条履行方式"
