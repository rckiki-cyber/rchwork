#!/usr/bin/env python3
from __future__ import annotations

"""
数据合规/脱敏 worker CLI。
不启动 HTTP 服务，只处理单个任务并退出。

用法：
  python compliance_worker.py review --payload input.json --output task_dir
  python compliance_worker.py desensitize --payload input.json --output task_dir

input.json 格式：
  {
    "task_id": "abc123",
    "document_name": "隐私政策",
    "input_path": "/path/to/file.pdf",
    "input_type": "file" | "text",
    "review_type": "document" | "code",
    "output_dir": "/optional/output/dir"
  }

输出：
  task_dir/task_state.json    任务状态与结果
  task_dir/...                审查/脱敏中间文件与报告
  task_dir/worker_error.json  失败时写入结构化错误
"""
import argparse
import json
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path


WEB_DIR = Path(__file__).resolve().parent
os.chdir(WEB_DIR)
os.environ.setdefault("COMPLIANCEAI_PYTHON", sys.executable)
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

import worker_core as core
from scripts.preprocess_input import normalize as normalize_extracted_text
from scripts.preprocess_input import read_text as read_input_text


def log(message: str) -> None:
    log_path = os.environ.get("COMPLIANCEAI_LOG_PATH", "").strip()
    if not log_path:
        return
    try:
        path = Path(log_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(message.rstrip() + "\n")
    except Exception:
        pass


def write_worker_error(output_dir: Path, message: str, detail: str) -> None:
    error_path = output_dir / 'worker_error.json'
    try:
        error_path.write_text(
            json.dumps({'error': message, 'error_detail': detail}, ensure_ascii=False, indent=2),
            encoding='utf-8'
        )
    except Exception:
        pass


def load_batch_files(payload: dict, input_path: Path) -> list[dict]:
    files = payload.get('input_files')
    if isinstance(files, list) and files:
        return [item for item in files if isinstance(item, dict)]
    manifest_path = Path(payload.get('input_manifest_path') or input_path)
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            manifest_files = manifest.get('files')
            if isinstance(manifest_files, list):
                return [item for item in manifest_files if isinstance(item, dict)]
        except Exception:
            return []
    return []


def build_batch_review_input(payload: dict, input_path: Path, output_dir: Path) -> Path:
    batch_files = load_batch_files(payload, input_path)
    if not batch_files:
        raise RuntimeError('批量任务缺少可处理的文件清单')

    combined_parts: list[str] = []
    failures: list[dict] = []
    for index, item in enumerate(batch_files, start=1):
        file_path = Path(str(item.get('path') or ''))
        display_name = str(item.get('name') or file_path.name or f'文件 {index}')
        try:
            raw = read_input_text(str(file_path), '')
            text = normalize_extracted_text(raw)
            if not text:
                raise RuntimeError('未提取到可审查文本')
            combined_parts.append(
                f'\n\n===== 批量材料 {index}: {display_name} =====\n'
                f'来源路径: {file_path}\n\n{text}'
            )
        except Exception as exc:
            failures.append({
                'name': display_name,
                'path': str(file_path),
                'error': str(exc)
            })

    if not combined_parts:
        detail = '; '.join(f"{item['name']}: {item['error']}" for item in failures)
        raise RuntimeError(f'批量 OCR/文本提取全部失败：{detail}')

    if failures:
        failure_path = output_dir / 'batch_extract_failures.json'
        failure_path.write_text(json.dumps(failures, ensure_ascii=False, indent=2), encoding='utf-8')
        combined_parts.append(
            '\n\n===== 批量材料提取失败清单 =====\n'
            + '\n'.join(f"- {item['name']}: {item['error']}" for item in failures)
        )

    combined_path = output_dir / 'batch_review_input.txt'
    combined_path.write_text('\n'.join(combined_parts).strip(), encoding='utf-8')
    return combined_path


def main() -> int:
    parser = argparse.ArgumentParser(description='数据合规/脱敏 worker')
    subparsers = parser.add_subparsers(dest='command', required=True)

    review_parser = subparsers.add_parser('review', help='合规审查')
    review_parser.add_argument('--payload', required=True, help='输入 JSON 文件路径')
    review_parser.add_argument('--output', required=True, help='任务输出目录')

    desensitize_parser = subparsers.add_parser('desensitize', help='材料脱敏')
    desensitize_parser.add_argument('--payload', required=True, help='输入 JSON 文件路径')
    desensitize_parser.add_argument('--output', required=True, help='任务输出目录')

    args = parser.parse_args()

    payload_path = Path(args.payload)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not payload_path.exists():
        message = f'payload 文件不存在: {payload_path}'
        write_worker_error(output_dir, message, '')
        log(message)
        return 2

    try:
        payload = json.loads(payload_path.read_text(encoding='utf-8'))
    except Exception as e:
        message = f'payload JSON 解析失败: {e}'
        write_worker_error(output_dir, message, traceback.format_exc())
        log(message)
        return 2

    task_id = str(payload.get('task_id') or '')
    if not task_id:
        message = 'payload 缺少 task_id'
        write_worker_error(output_dir, message, '')
        log(message)
        return 2

    document_name = payload.get('document_name') or '未命名任务'
    input_path_str = payload.get('input_path') or ''
    input_manifest_path = payload.get('input_manifest_path') or ''
    input_files = payload.get('input_files') if isinstance(payload.get('input_files'), list) else []
    input_type = payload.get('input_type') or 'file'
    review_type = payload.get('review_type') or 'document'
    output_dir_raw = payload.get('output_dir') or ''
    output_format = payload.get('output_format') or None

    # worker_core stores task_state.json under OUTPUT_FOLDER / task_id.
    # The CLI receives the per-task directory, so pass its parent as the root.
    core.set_worker_paths(
        base_dir=WEB_DIR,
        upload_folder=WEB_DIR / 'uploads',
        output_folder=output_dir.parent,
        scripts_dir=WEB_DIR / 'scripts',
        project_root=WEB_DIR.parent / 'projects' / 'data-compliance-ai-project-kit',
        local_regulation_db=WEB_DIR.parent / 'projects' / 'data-compliance-ai-project-kit' / 'knowledge-base' / 'local-regulations.sqlite3',
    )
    core.ensure_directories()
    core.ensure_task_loaded(task_id)

    core.ensure_task_loaded(task_id)
    existing_task = core.tasks.get(task_id, {})
    core.tasks[task_id] = {
        **existing_task,
        'id': task_id,
        'document_name': document_name,
        'product_type': 'desensitize' if args.command == 'desensitize' else 'review',
        'review_type': review_type if args.command == 'review' else None,
        'input_type': input_type,
        'input_path': input_path_str,
        'input_manifest_path': input_manifest_path or existing_task.get('input_manifest_path'),
        'input_files': input_files or existing_task.get('input_files'),
        'output_dir': output_dir_raw or existing_task.get('output_dir'),
        'output_format': output_format or existing_task.get('output_format'),
        'status': 'running',
        'created_at': existing_task.get('created_at') or datetime.now().isoformat(),
    }
    core.save_task_state(task_id)

    input_path = Path(input_path_str)
    is_text = input_type == 'text'
    is_batch = input_type == 'batch'

    try:
        if args.command == 'review':
            if is_batch:
                input_path = build_batch_review_input(payload, input_path, output_dir)
                is_text = True
            if review_type == 'code':
                core.run_code_review_pipeline(task_id, input_path, document_name, is_text)
            else:
                core.run_review_pipeline(task_id, input_path, document_name, is_text)
        elif args.command == 'desensitize':
            validated_output_dir = core.validate_output_dir(output_dir_raw)
            if is_batch:
                core.run_desensitize_pipeline(
                    task_id,
                    input_path,
                    document_name,
                    False,
                    validated_output_dir,
                    output_format=output_format,
                )
            else:
                core.run_desensitize_pipeline(
                    task_id,
                    input_path,
                    document_name,
                    is_text,
                    validated_output_dir,
                    output_format=output_format,
                )
        log(f'compliance_worker completed: task={task_id} command={args.command}')
        return 0
    except Exception as e:
        error_detail = traceback.format_exc()
        message = str(e)
        write_worker_error(output_dir, message, error_detail)
        log(f'compliance_worker failed: task={task_id} command={args.command}\n{error_detail}')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
