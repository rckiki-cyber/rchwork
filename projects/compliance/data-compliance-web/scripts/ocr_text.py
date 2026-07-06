from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except Exception:  # pragma: no cover - optional dependency
    fitz = None

try:
    from PIL import Image
except Exception:  # pragma: no cover - optional dependency
    Image = None

try:
    import pytesseract
except Exception:  # pragma: no cover - optional dependency
    pytesseract = None


OCR_LANG = 'chi_sim+eng'
OCR_FALLBACK_LANG = 'eng'
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'}
TESSERACT_ENV_KEYS = ('LEGALWORK_TESSERACT_CMD', 'TESSERACT_CMD')
OCR_ROOT_ENV_KEYS = ('LEGALWORK_OCR_ROOT', 'TESSERACT_ROOT')


class OcrUnavailable(RuntimeError):
    pass


def _binary_names() -> list[str]:
    return ['tesseract.exe', 'tesseract'] if sys.platform == 'win32' else ['tesseract']


def _platform_tags() -> list[str]:
    machine = platform.machine().lower()
    aliases = {
        'aarch64': 'arm64',
        'x86_64': 'x64',
        'amd64': 'x64',
    }
    normalized_machine = aliases.get(machine, machine)
    system = {
        'darwin': 'mac',
        'win32': 'win',
        'linux': 'linux',
    }.get(sys.platform, sys.platform)
    return [
        f'{sys.platform}-{machine}',
        f'{sys.platform}-{normalized_machine}',
        f'{system}-{normalized_machine}',
        system,
    ]


def _candidate_ocr_roots() -> list[Path]:
    roots: list[Path] = []
    for key in OCR_ROOT_ENV_KEYS:
        raw = os.environ.get(key)
        if raw:
            roots.append(Path(raw).expanduser())

    script_dir = Path(__file__).resolve().parent
    for parent in [script_dir, *script_dir.parents]:
        roots.extend([
            parent / 'ocr-runtime',
            parent / 'vendor' / 'ocr-runtime',
            parent / 'runtime' / 'ocr',
        ])

    return roots


def _candidate_tesseract_paths() -> list[Path]:
    candidates: list[Path] = []
    for root in _candidate_ocr_roots():
        for tag in _platform_tags():
            for name in _binary_names():
                candidates.extend([
                    root / tag / 'bin' / name,
                    root / 'bin' / tag / name,
                ])
        for name in _binary_names():
            candidates.extend([
                root / 'bin' / name,
                root / name,
            ])
    return candidates


def _is_executable(path: Path) -> bool:
    return path.is_file() and (sys.platform == 'win32' or os.access(path, os.X_OK))


def _find_tesseract_cmd() -> str | None:
    for key in TESSERACT_ENV_KEYS:
        raw = os.environ.get(key)
        if raw and _is_executable(Path(raw).expanduser()):
            return str(Path(raw).expanduser())

    found = shutil.which('tesseract')
    if found:
        return found

    for candidate in _candidate_tesseract_paths():
        if _is_executable(candidate):
            return str(candidate)
    return None


def _find_homebrew_cmd() -> str | None:
    for candidate in ('/opt/homebrew/bin/brew', '/usr/local/bin/brew'):
        if _is_executable(Path(candidate)):
            return candidate
    return shutil.which('brew')


def _try_install_tesseract() -> bool:
    if sys.platform != 'darwin':
        return False
    if os.environ.get('LEGALWORK_DISABLE_OCR_AUTO_INSTALL') == '1':
        return False
    brew = _find_homebrew_cmd()
    if not brew:
        return False
    try:
        subprocess.run(
            [brew, 'install', 'tesseract', 'tesseract-lang'],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return False
    return _find_tesseract_cmd() is not None


def _candidate_tessdata_dirs(tesseract_cmd: str) -> list[Path]:
    command = Path(tesseract_cmd).resolve()
    roots = [command.parent.parent, *_candidate_ocr_roots()]
    dirs: list[Path] = []
    for root in roots:
        for tag in _platform_tags():
            dirs.extend([
                root / tag / 'share' / 'tessdata',
                root / tag / 'tessdata',
            ])
        dirs.extend([
            root / 'share' / 'tessdata',
            root / 'tessdata',
        ])
    return dirs


def _configure_tesseract() -> str | None:
    cmd = _find_tesseract_cmd()
    if not cmd:
        return None

    if pytesseract is not None:
        pytesseract.pytesseract.tesseract_cmd = cmd

    if not os.environ.get('TESSDATA_PREFIX'):
        for tessdata_dir in _candidate_tessdata_dirs(cmd):
            if tessdata_dir.is_dir():
                os.environ['TESSDATA_PREFIX'] = str(tessdata_dir)
                break

    return cmd


def _missing_dependencies(require_pdf: bool = False) -> list[str]:
    missing: list[str] = []
    if require_pdf and fitz is None:
        missing.append('PDF 页面读取组件')
    if Image is None:
        missing.append('图片处理组件')
    if pytesseract is None:
        missing.append('图片文字识别组件')
    if not _configure_tesseract() and not (_try_install_tesseract() and _configure_tesseract()):
        missing.append('OCR 识别引擎')
    return missing


def ensure_ocr_available(*, require_pdf: bool = False) -> None:
    missing = _missing_dependencies(require_pdf=require_pdf)
    if missing:
        raise OcrUnavailable(
            '材料脱敏需要 OCR 组件，但当前环境缺少：'
            + '、'.join(missing)
            + '。请在软件内修复 OCR 组件后重试；如仍失败，请联系技术支持。'
        )


def _image_to_string(image) -> str:
    assert pytesseract is not None
    try:
        return pytesseract.image_to_string(image, lang=OCR_LANG)
    except Exception:
        return pytesseract.image_to_string(image, lang=OCR_FALLBACK_LANG)


def ocr_image_to_data(image) -> dict:
    ensure_ocr_available()
    assert pytesseract is not None
    try:
        return pytesseract.image_to_data(image, lang=OCR_LANG, output_type=pytesseract.Output.DICT)
    except Exception:
        return pytesseract.image_to_data(image, lang=OCR_FALLBACK_LANG, output_type=pytesseract.Output.DICT)


def extract_image_text(path: Path) -> str:
    ensure_ocr_available()
    assert Image is not None
    with Image.open(path) as image:
        return _image_to_string(image.convert('RGB')).strip()


def extract_pdf_ocr_text(path: Path, *, scale: int = 2) -> str:
    ensure_ocr_available(require_pdf=True)
    assert fitz is not None
    assert Image is not None
    pages: list[str] = []
    pdf = fitz.open(str(path))
    try:
        for page_index, page in enumerate(pdf, start=1):
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            image = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
            page_text = _image_to_string(image).strip()
            if page_text:
                pages.append(f'--- OCR 第 {page_index} 页 ---\n{page_text}')
            else:
                pages.append(f'--- OCR 第 {page_index} 页 ---')
    finally:
        pdf.close()

    text = '\f'.join(pages).strip()
    body_text = '\n'.join(
        line
        for part in pages
        for line in part.splitlines()
        if not line.strip().startswith('--- OCR 第')
    ).strip()
    if not text or not body_text:
        raise RuntimeError('OCR 未识别到可审查文本')
    return text
