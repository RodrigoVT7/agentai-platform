// src/shared/models/document.model.ts
export interface Document {
    id: string;
    knowledgeBaseId: string;
    name: string;
    type: string;
    storageUrl: string;
    sizeMb: number;
    processingStatus: DocumentProcessingStatus;
    documentHash?: string;
    metadata?: Record<string, any>;
    createdBy: string;
    createdAt: number;
    updatedAt?: number;
    isActive: boolean;
  }
  
  export enum DocumentProcessingStatus {
    PENDING = 'pending',
    PROCESSING = 'processing',
    PROCESSED = 'processed',
    VECTORIZED = 'vectorized',
    FAILED = 'failed'
  }
  
  export interface DocumentUploadRequest {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
  }
  
  export interface DocumentUploadResponse {
    documentId: string;
    knowledgeBaseId: string;
    name: string;
    type: string;
    sizeMb: number;
    status: DocumentProcessingStatus;
    message: string;
  }
  
  export interface DocumentProcessingQueueMessage {
    documentId: string;
    knowledgeBaseId: string;
    agentId: string;
    storageUrl: string;
    originalName: string;
    contentType: string;
    uploadedAt: number;
  }