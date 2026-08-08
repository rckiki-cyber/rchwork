# Bundled Office Runtime

This directory is the release-build staging area for LegalWork's built-in Word / Excel / PowerPoint Python environment.

Do **not** commit generated platform runtimes. `scripts/prepare-office-runtime.cjs` creates one of:

- `mac-arm64/`
- `mac-x64/`
- `win-x64/`
- `win-ia32/`
- `linux-x64/`

Each generated directory contains a relocatable CPython runtime under `python/`, a `runtime.json` manifest, and the preinstalled packages required by `skills/legal_document_formatting` (`python-docx`, `openpyxl`, `python-pptx`, `lxml`, `Pillow`).

Electron Builder's `after-pack.cjs` copies only the target platform/architecture runtime into `resources/office-runtime` and fails the release if required files are missing.

The installed application sets `LEGALWORK_OFFICE_PYTHON` for the LegalWork agent runtime. Packaged Office document tasks must never create a venv or run `pip install` on the user's machine.
