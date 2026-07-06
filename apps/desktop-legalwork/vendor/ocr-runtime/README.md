# OCR Runtime

This directory is packaged as `resources/ocr-runtime` by Electron Builder.

Place platform-specific Tesseract runtime files here when producing a desktop
release that must not depend on a system installation:

- `mac-arm64/bin/tesseract`
- `mac-x64/bin/tesseract`
- `win-x64/bin/tesseract.exe`
- `linux-x64/bin/tesseract`
- optional language data under `<platform>/share/tessdata/`

The desktop runtime also supports `LEGALWORK_TESSERACT_CMD`,
`LEGALWORK_OCR_ROOT`, and `TESSDATA_PREFIX` for externally managed OCR
installations.
