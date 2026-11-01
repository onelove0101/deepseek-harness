/**
 * The Experts storage domain: record schemas and the `defineDomain` spec the
 * service opens. The schemas validate the stored format at the durability
 * boundary; request limits are enforced by the service before a write.
 * @module @deepseek-ai/dsh-expert/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ExpertDocumentId, ExpertId, ExpertKnowledgeBaseId } from './types.ts'

/** Stored Expert. Selections are ids and names resolved at invocation. */
export const expertRecord = z.object({
  name: z.string(),
  enabled: z.boolean(),
  soul: z.string(),
  skills: z.array(z.string()),
  documentIds: z.array(z.string()),
  knowledgeBaseIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Invocations whose instructions message was committed to a Session log. */
  uses: z.number().default(0),
  /** Unix epoch milliseconds of the latest committed invocation; 0 when never used. */
  lastUsedAt: z.number().default(0),
})

/** One stored Expert, inferred from {@link expertRecord}. */
export type ExpertRecord = z.infer<typeof expertRecord>

/** Stored library document; `text` never leaves the Host except as an injected snapshot. */
export const documentRecord = z.object({
  title: z.string(),
  text: z.string(),
  bytes: z.number(),
  createdAt: z.number(),
})

/** One stored document, inferred from {@link documentRecord}. */
export type DocumentRecord = z.infer<typeof documentRecord>

/** Stored knowledge base: an ordered list of member document ids. */
export const knowledgeBaseRecord = z.object({
  name: z.string(),
  documentIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** One stored knowledge base, inferred from {@link knowledgeBaseRecord}. */
export type KnowledgeBaseRecord = z.infer<typeof knowledgeBaseRecord>

/** The Experts domain: one table per resource kind, keyed by random UUID. */
export const expertDomainSpec = defineDomain({
  name: 'experts',
  version: 1,
  tables: {
    experts: domainTable<ExpertId, ExpertRecord>(expertRecord),
    documents: domainTable<ExpertDocumentId, DocumentRecord>(documentRecord),
    knowledge_bases: domainTable<ExpertKnowledgeBaseId, KnowledgeBaseRecord>(knowledgeBaseRecord),
  },
})
