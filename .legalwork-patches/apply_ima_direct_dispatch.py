from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


root = Path(__file__).resolve().parents[1]
loop_path = root / "apps/desktop-legalwork/legalwork/src/loop/agent-loop.ts"
test_path = root / "apps/desktop-legalwork/legalwork/tests/loop.test.ts"

loop = loop_path.read_text(encoding="utf-8")
old_route = """    const imaRouteAction = resolveImaRouteAction({
      prompt: turn?.prompt ?? '',
      tools: scopedToolSpecs,
      items: healed.items,
      turnId,
      enabled: !planTurnActive && !isKnowledgeQaThread
    })
    const requiredToolName = planRequiredToolName ?? imaRouteAction?.requiredToolName
"""
new_route = """    const imaRouteAction = resolveImaRouteAction({
      prompt: turn?.prompt ?? '',
      tools: scopedToolSpecs,
      items: healed.items,
      turnId,
      enabled: !planTurnActive && !isKnowledgeQaThread
    })

    // IMA auto-routing is already a deterministic runtime decision. Do not pay
    // for a full model round-trip merely to make the model emit the one tool
    // call that the runtime has already selected. Prefetch the IMA route here,
    // persist the normal tool-call/result history, then let the next loop step
    // make the single model request that synthesizes the retrieved evidence.
    // Progressive MCP routing naturally becomes: mcp_search -> mcp_call -> model.
    if (imaRouteAction) {
      const callId = this.opts.ids.next('call_ima_route')
      const provider = toolProviderMetadata.get(imaRouteAction.requiredToolName)
      const toolKind = toolKinds.get(imaRouteAction.requiredToolName)
      const call: ToolCallLike = {
        callId,
        toolName: imaRouteAction.requiredToolName,
        ...(provider?.providerId ? { providerId: provider.providerId } : {}),
        toolKind,
        arguments: imaRouteAction.requiredArguments
      }
      const itemId = `item_tool_${turnId}_${callId}`
      await this.opts.turns.applyItem(
        threadId,
        makeToolCallItem({
          id: itemId,
          turnId,
          threadId,
          callId,
          toolName: imaRouteAction.requiredToolName,
          toolKind,
          arguments: imaRouteAction.requiredArguments,
          summary: 'Runtime-prefetched IMA knowledge-base routing without a model round-trip.'
        })
      )
      await this.opts.events.record({
        kind: 'tool_call_ready',
        threadId,
        turnId,
        itemId,
        callId,
        toolName: imaRouteAction.requiredToolName,
        readyCount: 1
      })
      const dispatched = await this.dispatchToolCalls({
        calls: [call],
        threadId,
        turnId,
        workspace: thread?.workspace ?? '',
        threadMode: effectiveMode,
        activePlanContext,
        modelCapabilities,
        activeSkillIds: skillResolution.activeSkillIds,
        allowedToolNames,
        toolProviderKinds: new Map(tools.map((tool) => [tool.name, tool.providerKind])),
        approvalPolicy,
        signal
      })
      if (dispatched === 'aborted') return 'aborted'
      return 'continue'
    }

    const requiredToolName = planRequiredToolName
"""
loop = replace_once(loop, old_route, new_route, "agent-loop IMA runtime prefetch")

loop = replace_once(
    loop,
    "      ...(imaRouteAction ? [imaRouteAction.instruction] : []),\n",
    "",
    "remove obsolete IMA context instruction",
)

old_fallback = """        if (
          imaRouteAction &&
          request.requiredToolName === imaRouteAction.requiredToolName
        ) {
          const callId = this.opts.ids.next('call_ima_route')
          const provider = toolProviderMetadata.get(imaRouteAction.requiredToolName)
          const toolKind = toolKinds.get(imaRouteAction.requiredToolName)
          const call: ToolCallLike = {
            callId,
            toolName: imaRouteAction.requiredToolName,
            ...(provider?.providerId ? { providerId: provider.providerId } : {}),
            toolKind,
            arguments: imaRouteAction.requiredArguments
          }
          const itemId = `item_tool_${turnId}_${callId}`
          await this.opts.turns.applyItem(
            threadId,
            makeToolCallItem({
              id: itemId,
              turnId,
              threadId,
              callId,
              toolName: imaRouteAction.requiredToolName,
              toolKind,
              arguments: imaRouteAction.requiredArguments,
              summary: 'Runtime-enforced IMA knowledge-base routing.'
            })
          )
          await this.opts.events.record({
            kind: 'tool_call_ready',
            threadId,
            turnId,
            itemId,
            callId,
            toolName: imaRouteAction.requiredToolName,
            readyCount: 1
          })
          const dispatched = await this.dispatchToolCalls({
            calls: [call],
            threadId,
            turnId,
            workspace: thread?.workspace ?? '',
            threadMode: effectiveMode,
            activePlanContext,
            modelCapabilities,
            activeSkillIds: skillResolution.activeSkillIds,
            allowedToolNames,
            toolProviderKinds: new Map(tools.map((tool) => [tool.name, tool.providerKind])),
            approvalPolicy,
            signal
          })
          if (dispatched === 'aborted') return 'aborted'
          return 'continue'
        }
"""
loop = replace_once(loop, old_fallback, "", "remove obsolete IMA required-tool fallback")
loop_path.write_text(loop, encoding="utf-8")

tests = test_path.read_text(encoding="utf-8")
old_direct_stream = """        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          if (requests.length > 1) {
            yield { kind: 'assistant_text_delta', text: '已结合 IMA 回答。' }
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
"""
new_direct_stream = """        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          yield { kind: 'assistant_text_delta', text: '已结合 IMA 回答。' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
"""
tests = replace_once(tests, old_direct_stream, new_direct_stream, "direct IMA stream expectation")

old_direct_expect = """    expect(status).toBe('completed')
    expect(executions).toBe(1)
    expect(requests[0]?.requiredToolName).toBe('mcp_ima_knowledge_base_research_ima')
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      'mcp_ima_knowledge_base_research_ima'
    ])
    expect(requests[0]?.contextInstructions?.join('\\n')).toContain('IMA 云知识库')
    expect(items.some((item) =>
"""
new_direct_expect = """    expect(status).toBe('completed')
    expect(executions).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.requiredToolName).toBeUndefined()
    expect(requests[0]?.contextInstructions?.join('\\n') ?? '').not.toContain('<ima_auto_route>')
    expect(requests[0]?.history.some((item) =>
      item.kind === 'tool_result' && item.toolName === 'mcp_ima_knowledge_base_research_ima'
    )).toBe(true)
    expect(items.some((item) =>
"""
tests = replace_once(tests, old_direct_expect, new_direct_expect, "direct IMA request-count expectations")

old_progressive_stream = """        async *stream(): AsyncIterable<ModelStreamChunk> {
          requests += 1
          if (requests > 2) {
            yield { kind: 'assistant_text_delta', text: '已使用渐进发现的 IMA 工具。' }
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
"""
new_progressive_stream = """        async *stream(): AsyncIterable<ModelStreamChunk> {
          requests += 1
          yield { kind: 'assistant_text_delta', text: '已使用渐进发现的 IMA 工具。' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
"""
tests = replace_once(tests, old_progressive_stream, new_progressive_stream, "progressive IMA stream expectation")

old_progressive_expect = """    expect(status).toBe('completed')
    expect(executed.map((entry) => entry.name)).toEqual(['mcp_search', 'mcp_call'])
"""
new_progressive_expect = """    expect(status).toBe('completed')
    expect(requests).toBe(1)
    expect(executed.map((entry) => entry.name)).toEqual(['mcp_search', 'mcp_call'])
"""
tests = replace_once(tests, old_progressive_expect, new_progressive_expect, "progressive IMA request-count expectation")
test_path.write_text(tests, encoding="utf-8")

print("Applied IMA direct-dispatch patch and updated loop tests.")
