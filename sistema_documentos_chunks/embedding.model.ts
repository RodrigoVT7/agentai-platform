// src/shared/models/embedding.model.ts
export interface Vector {
    id: string;
    documentId: string;
    chunkId: string;
    knowledgeBaseId: string;
    vector: number[];
    content: string; // Contenido del texto para el que se generó el embedding
    metadata?: Record<string, any>;
    createdAt: number;
  }
  
  export interface EmbeddingResult {
    chunkId: string;
    documentId: string;
    knowledgeBaseId: string;
    success: boolean;
    error?: string;
    vector?: number[];
  }
  
  export interface OpenAIEmbeddingResponse {
    data: {
      embedding: number[];
      index: number;
      object: string;
    }[];
    model: string;
    object: string;
    usage: {
      prompt_tokens: number;
      total_tokens: number;
    };
  }