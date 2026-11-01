/**
 * Public wire vocabulary of the Experts library: stored values, requests,
 * failure codes, and the durable invocation source. Types only, so generated
 * Remote clients consume it without importing Host runtime code.
 * @module @deepseek-ai/dsh-expert/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one Expert. */
export type ExpertId = Branded<'ExpertId'>

/** Opaque identity of one stored library document. */
export type ExpertDocumentId = Branded<'ExpertDocumentId'>

/** Opaque identity of one knowledge base. */
export type ExpertKnowledgeBaseId = Branded<'ExpertKnowledgeBaseId'>

/**
 * One Expert as the Settings page reads and edits it. `name` is the lowercase
 * mention handle (`@name`) and is unique among Experts.
 */
export interface ExpertValue {
  /** Stable identity assigned at creation. */
  readonly id: ExpertId
  /** Mention handle: lowercase letters, digits, and hyphens, starting with a letter. */
  readonly name: string
  /** Whether `@name` invokes the Expert; a disabled Expert stays listed and edited. */
  readonly enabled: boolean
  /** The Expert's Soul: standing instructions injected verbatim on invocation. */
  readonly soul: string
  /** Names of the skills whose bodies are injected on invocation, in injection order. */
  readonly skills: readonly string[]
  /** Library documents injected on invocation, in injection order. */
  readonly documentIds: readonly ExpertDocumentId[]
  /** Knowledge bases whose documents are injected on invocation, in injection order. */
  readonly knowledgeBaseIds: readonly ExpertKnowledgeBaseId[]
  /** Creation time in Unix epoch milliseconds. */
  readonly createdAt: number
  /** Time of the latest edit in Unix epoch milliseconds. */
  readonly updatedAt: number
}

/** One stored library document without its text; the text is never returned to Clients. */
export interface ExpertDocumentValue {
  /** Stable identity assigned at creation. */
  readonly id: ExpertDocumentId
  /** Display title. */
  readonly title: string
  /** UTF-8 byte length of the stored text. */
  readonly bytes: number
  /** Creation time in Unix epoch milliseconds. */
  readonly createdAt: number
}

/** A named, ordered group of library documents. */
export interface ExpertKnowledgeBaseValue {
  /** Stable identity assigned at creation. */
  readonly id: ExpertKnowledgeBaseId
  /** Display name. */
  readonly name: string
  /** Member documents, in injection order. */
  readonly documentIds: readonly ExpertDocumentId[]
  /** Creation time in Unix epoch milliseconds. */
  readonly createdAt: number
  /** Time of the latest edit in Unix epoch milliseconds. */
  readonly updatedAt: number
}

/** The deployment's storage bounds, reported so the Settings page can pre-check input. */
export interface ExpertLimits {
  /** Maximum number of Experts. */
  readonly maxExperts: number
  /** Maximum UTF-8 bytes of one Soul. */
  readonly maxSoulBytes: number
  /** Maximum skills selected by one Expert. */
  readonly maxSkillsPerExpert: number
  /** Maximum number of stored documents. */
  readonly maxDocuments: number
  /** Maximum UTF-8 bytes of one document's text. */
  readonly maxDocumentBytes: number
  /** Maximum number of knowledge bases. */
  readonly maxKnowledgeBases: number
  /** Maximum documents in one knowledge base. */
  readonly maxDocumentsPerKnowledgeBase: number
  /** Maximum total UTF-8 bytes of all stored document text. */
  readonly maxLibraryBytes: number
  /** Maximum UTF-8 bytes of the complete rendered invocation message: Soul, skill bodies, library text, wrappers, and XML escaping. */
  readonly maxInvocationLibraryBytes: number
}

/** The whole library as the Settings page reads it. */
export interface ExpertLibraryValue {
  /** Experts, in creation order. */
  readonly experts: readonly ExpertValue[]
  /** Documents, in creation order. */
  readonly documents: readonly ExpertDocumentValue[]
  /** Knowledge bases, in creation order. */
  readonly knowledgeBases: readonly ExpertKnowledgeBaseValue[]
  /** Storage bounds in force. */
  readonly limits: ExpertLimits
}

/** One enabled Expert as the composer menu lists it. */
export interface ExpertRankedEntry {
  /** Stable identity assigned at creation. */
  readonly id: ExpertId
  /** Mention handle inserted as `@name`. */
  readonly name: string
  /** The Expert's Soul, from which the menu derives a one-line description. */
  readonly soul: string
}

/** Enabled Experts ordered for the composer menu. */
export interface ExpertRankedValue {
  /**
   * Enabled Experts, most used first. Ties order by most recent use, then by
   * name. Use counts only invocations whose instructions message was committed
   * to a Session log.
   */
  readonly experts: readonly ExpertRankedEntry[]
}

/** Read the enabled Experts in usage order. */
export type ExpertRankedRequest = Record<string, never>

/** Read the library. */
export type ExpertListRequest = Record<string, never>

/** Create an Expert, or replace the editable fields of the Expert named by `id`. */
export interface ExpertSaveRequest {
  /** Existing Expert to edit; absent creates a new Expert. */
  readonly id?: ExpertId
  /** Mention handle; unique among Experts. */
  readonly name: string
  /** Whether `@name` invokes the Expert. */
  readonly enabled: boolean
  /** Soul text; must not be blank. */
  readonly soul: string
  /** Selected skill names. */
  readonly skills: readonly string[]
  /** Selected library documents. */
  readonly documentIds: readonly ExpertDocumentId[]
  /** Selected knowledge bases. */
  readonly knowledgeBaseIds: readonly ExpertKnowledgeBaseId[]
}

/** Delete one Expert. */
export interface ExpertDeleteRequest {
  /** Expert to delete. */
  readonly id: ExpertId
}

/** Store one text document in the private library. */
export interface ExpertDocumentCreateRequest {
  /** Display title; must not be blank. */
  readonly title: string
  /** Document text. The Host never accepts a filesystem path or URL here. */
  readonly text: string
}

/** Delete one document and remove it from every Expert and knowledge base that selects it. */
export interface ExpertDocumentDeleteRequest {
  /** Document to delete. */
  readonly id: ExpertDocumentId
}

/** Create a knowledge base, or replace the editable fields of the one named by `id`. */
export interface ExpertKnowledgeBaseSaveRequest {
  /** Existing knowledge base to edit; absent creates a new one. */
  readonly id?: ExpertKnowledgeBaseId
  /** Display name; must not be blank. */
  readonly name: string
  /** Member documents. */
  readonly documentIds: readonly ExpertDocumentId[]
}

/** Delete one knowledge base and remove it from every Expert that selects it. */
export interface ExpertKnowledgeBaseDeleteRequest {
  /** Knowledge base to delete. */
  readonly id: ExpertKnowledgeBaseId
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A field of the request is malformed or outside the deployment's bounds. */
    'expert/invalid': { readonly field: string; readonly reason: string }
    /** The named Expert, document, or knowledge base does not exist. */
    'expert/not-found': { readonly kind: 'expert' | 'document' | 'knowledge-base'; readonly id: string }
    /** Another Expert already uses the mention handle. */
    'expert/name-taken': { readonly name: string }
    /** The write would exceed a storage bound. */
    'expert/limit-exceeded': { readonly limit: keyof ExpertLimits; readonly max: number }
  }
}
