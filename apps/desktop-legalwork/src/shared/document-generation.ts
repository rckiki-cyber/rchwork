/**
 * Shared types for AI-powered legal document generation.
 */

import { z } from 'zod'

/** Request to generate a legal document via AI. */
export interface DocumentGenerationRequest {
  /** Template name (e.g. "民事起诉状") */
  templateName: string
  /** Template description / context */
  templateDescription: string
  /** Template content or structure (Markdown with {{field}} placeholders) */
  templateContent: string
  /** Field definitions from the template */
  fields: Array<{
    id: string
    label: string
    type: string
    value: string
    required?: boolean
  }>
  /** Legal basis / references if available */
  legalBasis?: string[]
}

/** Result of an AI document generation call. */
export type DocumentGenerationResult = {
  ok: true
  content: string
  model?: string
} | {
  ok: false
  message: string
}

/** Zod schema for IPC payload validation. */
export const documentGenerationPayloadSchema = z.object({
  templateName: z.string().trim().min(1).max(200),
  templateDescription: z.string().max(20_000),
  templateContent: z.string().max(500_000),
  fields: z.array(
    z.object({
      id: z.string().max(200),
      label: z.string().max(500),
      type: z.string().max(100),
      value: z.string().max(100_000),
      required: z.boolean().optional()
    }).strict()
  ).max(200),
  legalBasis: z.array(z.string().max(20_000)).max(100).optional()
}).strict()
