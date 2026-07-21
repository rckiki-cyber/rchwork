"""
测试语义化 token 脱敏与还原。

验证 internal_legal_analysis 策略下：
1. 公司名 token 保留地域/行业/组织形式线索，核心名首字替换为"某"
2. 同一 cluster 的 party_alias 使用与公司名一致的 token
3. RedactionRestorer 可以基于 mapping 还原语义化 token
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from redaction.pipeline import RedactionPipeline
from redaction.renderer import RedactionRenderer
from redaction.restorer import RedactionRestorer


def test_semantic_company_token():
    pipeline = RedactionPipeline()
    result = pipeline.process_text(
        text="北京小米科技有限公司与深圳市腾讯计算机系统有限公司存在合同纠纷。北京小米科技有限公司要求赔偿。",
        policy_name="internal_legal_analysis",
    )
    redacted = result["redacted_text"]

    # 公司名应保留地域和行业/组织形式线索
    assert "北京某米科技有限公司" in redacted, f"unexpected redacted: {redacted}"
    assert "深圳某腾讯计算机系统有限公司" in redacted, f"unexpected redacted: {redacted}"

    # 同一主体多次出现应使用一致 token
    assert redacted.count("北京某米科技有限公司") >= 2, f"token not unified: {redacted}"

    # 不应再出现纯编号 COMPANY_001
    assert "COMPANY_" not in redacted, f"legacy numeric token leaked: {redacted}"


def test_restore_semantic_token():
    pipeline = RedactionPipeline()
    result = pipeline.process_text(
        text="北京小米科技有限公司起诉深圳市腾讯计算机系统有限公司。",
        policy_name="internal_legal_analysis",
    )

    renderer = RedactionRenderer()
    mapping_path = "/tmp/test_semantic.mapping.enc"
    renderer.generate_mapping_file(
        result["mappings"],
        mapping_path,
        encrypt=False,
        cluster_table=result.get("cluster_table", []),
    )

    restorer = RedactionRestorer(mapping_path)
    restored = restorer.restore_text(result["redacted_text"])

    assert restored["success"], restored
    assert "北京小米科技有限公司" in restored["restored_text"]
    assert "深圳市腾讯计算机系统有限公司" in restored["restored_text"]

    # 确认替换记录中包含语义化 token
    redacted_tokens = {r["redacted"] for r in restored["replacements"]}
    assert "北京某米科技有限公司" in redacted_tokens
    assert "深圳某腾讯计算机系统有限公司" in redacted_tokens


def test_public_legal_norms_are_not_redacted():
    pipeline = RedactionPipeline()
    result = pipeline.process_text(
        text="根据《中华人民共和国公司法》第五条，北京小米科技有限公司应当履行合同义务。",
        policy_name="external_client",
        entity_types=["company_name"],
    )

    redacted = result["redacted_text"]
    assert "《中华人民共和国公司法》" in redacted
    assert "A公司法" not in redacted
    assert "北京小米科技有限公司" not in redacted
    assert any(mapping.original == "北京小米科技有限公司" for mapping in result["mappings"])
    assert all(mapping.original != "中华人民共和国公司" for mapping in result["mappings"])


if __name__ == "__main__":
    test_semantic_company_token()
    test_restore_semantic_token()
    test_public_legal_norms_are_not_redacted()
    print("semantic token tests passed")
