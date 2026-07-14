import sys
from pathlib import Path

import fitz
from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = PROJECT_ROOT / "projects" / "compliance" / "data-compliance-web"
sys.path.insert(0, str(WEB_ROOT))

import desensitize_engine as de  # noqa: E402


def test_process_pdf_outputs_redacted_pdf_for_layout_text(tmp_path):
    source = tmp_path / "source.pdf"
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 90), "Automobile Finance Co., Ltd.", fontsize=14)
    page.insert_text((72, 120), "Legal Representative: John Smith", fontsize=12)
    page.insert_text((72, 150), "Tel: 13812345678", fontsize=12)
    doc.save(source)
    doc.close()

    engine = de.Desensitizer()
    output, findings, subjects = de.process_pdf(source, tmp_path, engine, [])

    assert output.suffix == ".pdf"
    assert any(item.entity_type == "PHONE_NUMBER" for item in findings)
    assert any(item.original == "Automobile Finance Co., Ltd." for item in subjects)
    assert any(item.original == "John Smith" for item in subjects)

    redacted_doc = fitz.open(output)
    redacted_text = "\n".join(page.get_text("text") for page in redacted_doc)
    redacted_doc.close()

    assert "Automobile Finance Co., Ltd." not in redacted_text
    assert "John Smith" not in redacted_text
    assert "13812345678" not in redacted_text


def test_redact_image_draws_legal_subject_without_privacy_finding(tmp_path, monkeypatch):
    source = tmp_path / "source.png"
    output = tmp_path / "out.png"
    Image.new("RGB", (360, 80), "white").save(source)

    monkeypatch.setattr(
        de,
        "ocr_image_to_data",
        lambda image: {
            "text": ["Legal", "Representative", "张三"],
            "left": [20, 75, 220],
            "top": [24, 24, 24],
            "width": [45, 125, 38],
            "height": [18, 18, 18],
            "block_num": [1, 1, 1],
            "par_num": [1, 1, 1],
            "line_num": [1, 1, 1],
            "word_num": [1, 2, 3],
            "conf": [99, 99, 99],
        },
    )

    engine = de.Desensitizer()
    result, findings, subjects = de.redact_image(source, output, engine, "图片")

    assert result == output
    assert findings == []
    assert any(item.original == "张三" for item in subjects)

    redacted = Image.open(output).convert("RGB")
    assert redacted.getpixel((230, 30)) == de.REDACTION_FILL
