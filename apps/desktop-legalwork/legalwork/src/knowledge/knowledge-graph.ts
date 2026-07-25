/**
 * Knowledge Graph — 文档关联图谱
 *
 * Manages directed edges between knowledge documents to support
 * cross-layer navigation, traceability (up/down stream), and
 * freshness auditing.
 *
 * All graph operations are pure data transformations on the
 * edge index — no I/O.
 */

import type { KnowledgeDocument, KnowledgeEdge, KnowledgeEdgeRelation, KnowledgeLayer } from '../contracts/knowledge.js'

export type { KnowledgeEdge, KnowledgeEdgeRelation }

/**
 * Edge direction relative to a document's layer.
 */
export type EdgeDirection = 'upstream' | 'downstream' | 'peer'

/**
 * Get the implied direction of an edge relative to the source document's layer.
 * Based on the Pyramid layer ordering: L1 > L2 > L3 > L4 > L5.
 */
export function edgeDirection(
  edge: KnowledgeEdge,
  sourceLayer?: KnowledgeLayer,
  targetLayer?: KnowledgeLayer
): EdgeDirection {
  if (!sourceLayer || !targetLayer) return 'peer'

  const layers: KnowledgeLayer[] = ['principle', 'architecture', 'standard', 'implementation', 'experience']
  const sourceIdx = layers.indexOf(sourceLayer)
  const targetIdx = layers.indexOf(targetLayer)

  if (targetIdx < sourceIdx) return 'upstream'
  if (targetIdx > sourceIdx) return 'downstream'
  return 'peer'
}

/**
 * Label for display purposes.
 */
export const EDGE_LABEL: Record<KnowledgeEdgeRelation, string> = {
  governs: '约束',
  defines: '定义',
  constrains: '限制',
  implements: '实现',
  validates: '验证',
  feedback: '反馈',
  cross_ref: '引用',
}

/**
 * BFS traversal to find related documents starting from a document ID.
 * Returns edges and their connected document IDs, sorted by distance.
 */
export function getRelatedDocuments(
  sourceDocumentId: string,
  edges: KnowledgeEdge[],
  documents: Map<string, KnowledgeDocument>,
  maxDepth = 2
): Array<{
  edge: KnowledgeEdge
  relatedDocumentId: string
  direction: EdgeDirection
  distance: number
}> {
  const visited = new Set<string>()
  const results: Array<{
    edge: KnowledgeEdge
    relatedDocumentId: string
    direction: EdgeDirection
    distance: number
  }> = []

  // BFS
  interface QueueItem {
    docId: string
    distance: number
  }
  const queue: QueueItem[] = [{ docId: sourceDocumentId, distance: 0 }]
  visited.add(sourceDocumentId)

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.distance >= maxDepth) continue

    // Find all edges connected to the current document
    for (const edge of edges) {
      let neighborId: string | null = null

      if (edge.sourceId === current.docId && edge.targetId !== current.docId) {
        neighborId = edge.targetId
      } else if (edge.targetId === current.docId && edge.sourceId !== current.docId) {
        neighborId = edge.sourceId
      }

      if (neighborId && !visited.has(neighborId)) {
        visited.add(neighborId)
        const sourceDoc = documents.get(current.docId)
        const targetDoc = documents.get(neighborId)
        const relDoc = documents.get(neighborId)
        const dir = edgeDirection(edge, sourceDoc?.layer, targetDoc?.layer)

        results.push({
          edge,
          relatedDocumentId: neighborId,
          direction: dir,
          distance: current.distance + 1
        })

        queue.push({ docId: neighborId, distance: current.distance + 1 })
      }
    }
  }

  return results
}

/**
 * Build edge index from document list using heuristic rules.
 * Edges are inferred from:
 * - Shared keywords between documents
 * - Layer adjacency (L1-L2-L3-L4-L5 chain)
 * - Path-based relationships (same source root / folder)
 */
export function buildEdgeIndex(
  documents: KnowledgeDocument[]
): KnowledgeEdge[] {
  const edges: KnowledgeEdge[] = []
  const docMap = new Map(documents.map((d) => [d.id, d]))
  const seen = new Set<string>()
  let edgeCounter = 0

  const layers: KnowledgeLayer[] = ['principle', 'architecture', 'standard', 'implementation', 'experience']

  for (const doc of documents) {
    if (!doc.layer) continue
    const docLayerIdx = layers.indexOf(doc.layer)

    // Layer adjacency: link to documents in adjacent layers
    for (const other of documents) {
      if (other.id === doc.id || !other.layer) continue
      const otherIdx = layers.indexOf(other.layer)
      const absDiff = Math.abs(docLayerIdx - otherIdx)

      // Build edge key to deduplicate
      const edgeKey = doc.id < other.id ? `${doc.id}->${other.id}` : `${other.id}->${doc.id}`
      if (seen.has(edgeKey)) continue

      const relation = inferEdgeRelation(doc.layer, other.layer)
      if (relation) {
        seen.add(edgeKey)
        edgeCounter++
        edges.push({
          id: `edge_${edgeCounter}`,
          sourceId: doc.id,
          targetId: other.id,
          relation,
          weight: absDiff === 0 ? 0.8 : absDiff === 1 ? 0.6 : 0.3
        })
        continue
      }

      // High keyword overlap -> cross_ref
      const docKeywords = new Set(doc.keywords ?? [])
      const otherKeywords = new Set(other.keywords ?? [])
      const overlap = [...docKeywords].filter((k) => otherKeywords.has(k)).length
      if (overlap >= 3) {
        seen.add(edgeKey)
        edgeCounter++
        edges.push({
          id: `edge_${edgeCounter}`,
          sourceId: doc.id,
          targetId: other.id,
          relation: 'cross_ref',
          weight: Math.min(1, overlap / 10)
        })
      }
    }
  }

  return edges
}

/**
 * Infer the edge relation type between two layers.
 */
function inferEdgeRelation(
  sourceLayer: KnowledgeLayer,
  targetLayer: KnowledgeLayer
): KnowledgeEdgeRelation | null {
  const layers: KnowledgeLayer[] = ['principle', 'architecture', 'standard', 'implementation', 'experience']
  const sourceIdx = layers.indexOf(sourceLayer)
  const targetIdx = layers.indexOf(targetLayer)

  if (targetIdx === sourceIdx + 1) {
    // Upstream constrains downstream
    if (sourceLayer === 'principle') return 'governs'
    if (sourceLayer === 'architecture') return 'constrains'
    if (sourceLayer === 'standard') return 'implements'
    if (sourceLayer === 'implementation') return 'validates'
    return 'cross_ref'
  }
  if (targetIdx === sourceIdx - 1) {
    if (targetLayer === 'architecture' || targetLayer === 'standard') return 'defines'
    if (targetLayer === 'implementation') return 'implements'
    if (targetLayer === 'experience') return 'validates'
    return 'feedback'
  }

  return null
}

/**
 * Check connectivity: find orphaned nodes (documents with no edges).
 */
export function findOrphanedDocuments(
  documents: KnowledgeDocument[],
  edges: KnowledgeEdge[]
): KnowledgeDocument[] {
  const connectedIds = new Set<string>()
  for (const edge of edges) {
    connectedIds.add(edge.sourceId)
    connectedIds.add(edge.targetId)
  }
  return documents.filter((doc) => doc.layer && !connectedIds.has(doc.id))
}
