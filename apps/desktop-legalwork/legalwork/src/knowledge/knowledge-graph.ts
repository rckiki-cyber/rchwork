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
 * Optimized with layer bucketing to avoid O(n²) on all documents.
 * Edges are inferred from:
 * - Layer adjacency (L1-L2-L3-L4-L5 chain)
 * - Same-layer documents by keyword overlap
 */
export function buildEdgeIndex(
  documents: KnowledgeDocument[]
): KnowledgeEdge[] {
  const edges: KnowledgeEdge[] = []
  const seen = new Set<string>()
  let edgeCounter = 0

  const layers: KnowledgeLayer[] = ['principle', 'architecture', 'standard', 'implementation', 'experience']

  // Group documents by layer, skip unlayered docs
  const byLayer = new Map<KnowledgeLayer, KnowledgeDocument[]>()
  for (const doc of documents) {
    if (!doc.layer) continue
    const bucket = byLayer.get(doc.layer)
    if (bucket) bucket.push(doc)
    else byLayer.set(doc.layer, [doc])
  }

  // Layer adjacency: compare only documents in adjacent layers
  // This reduces comparisons from O(n²) to O(k * a * b) where a,b are adjacent-layer sizes
  for (let idx = 0; idx < layers.length; idx++) {
    const currentLayer = layers[idx]
    const currentDocs = byLayer.get(currentLayer)
    if (!currentDocs) continue

    // Compare with next layer down
    if (idx < layers.length - 1) {
      const nextLayer = layers[idx + 1]
      const nextDocs = byLayer.get(nextLayer)
      if (nextDocs) {
        for (const doc of currentDocs) {
          for (const other of nextDocs) {
            const edgeKey = `${doc.id}->${other.id}`
            if (seen.has(edgeKey)) continue
            seen.add(edgeKey)
            edgeCounter++
            edges.push({
              id: `edge_${edgeCounter}`,
              sourceId: doc.id,
              targetId: other.id,
              relation: inferDownstreamRelation(currentLayer),
              weight: 0.6
            })
          }
        }
      }
    }

    // Same-layer keyword overlap
    if (currentDocs.length > 1) {
      for (let i = 0; i < currentDocs.length; i++) {
        const doc = currentDocs[i]
        const docKeywords = new Set(doc.keywords ?? [])
        for (let j = i + 1; j < currentDocs.length; j++) {
          const other = currentDocs[j]
          const otherKeywords = new Set(other.keywords ?? [])
          const overlap = [...docKeywords].filter((k) => otherKeywords.has(k)).length
          if (overlap >= 3) {
            const edgeKey = `${doc.id}->${other.id}`
            if (seen.has(edgeKey)) continue
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
    }
  }

  return edges
}

/**
 * Infer the edge relation type when a higher layer constrains a lower layer.
 */
function inferDownstreamRelation(sourceLayer: KnowledgeLayer): KnowledgeEdgeRelation {
  switch (sourceLayer) {
    case 'principle': return 'governs'       // L1→L2
    case 'architecture': return 'constrains'  // L2→L3
    case 'standard': return 'implements'      // L3→L4
    case 'implementation': return 'validates' // L4→L5
    default: return 'cross_ref'
  }
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
