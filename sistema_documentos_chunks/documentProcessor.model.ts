// src/shared/models/documentProcessor.model.ts
import { DocumentProcessingStatus } from "./document.model";

export interface DocumentChunk {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  content: string;
  position: number;
  tokenCount: number;
  metadata?: Record<string, any>;
  embedding?: number[];
}

export interface ProcessingResult {
  documentId: string;
  knowledgeBaseId: string;
  status: DocumentProcessingStatus;
  chunks: DocumentChunk[];
  error?: string;
}

export interface EmbeddingQueueMessage {
  chunkId: string;
  documentId: string;
  knowledgeBaseId: string;
  agentId: string;
  content: string;
  position: number;
  metadata?: Record<string, any>;
}