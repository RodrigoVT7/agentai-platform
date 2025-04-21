// src/shared/models/conversation.model.ts
export interface Conversation {
    id: string;
    agentId: string;
    userId: string;
    endUserId?: string;
    code?: string;
    startDate: number;
    endDate?: number;
    status: ConversationStatus;
    sourceChannel: string;
    sourceUrl?: string;
    userRating?: number;
    metadata?: Record<string, any>;
    createdAt: number;
    updatedAt: number;
  }
  
  export enum ConversationStatus {
    ACTIVE = 'active',
    ENDED = 'ended',
    TRANSFERRED = 'transferred',
    ABANDONED = 'abandoned'
  }
  
  export interface Message {
    id: string;
    conversationId: string;
    content: string;
    role: MessageRole;
    senderId: string;
    timestamp: number;
    responseTime?: number;
    inputTokens?: number;
    outputTokens?: number;
    status: MessageStatus;
    messageType: MessageType;
    contentType?: string;
    attachments?: Record<string, any>;
    metadata?: Record<string, any>;
    integrationId?: string;
    createdAt: number;
  }
  
  export enum MessageRole {
    SYSTEM = 'system',
    ASSISTANT = 'assistant',
    USER = 'user',
    HUMAN_AGENT = 'human_agent'
  }
  
  export enum MessageStatus {
    SENT = 'sent',
    DELIVERED = 'delivered',
    READ = 'read',
    FAILED = 'failed'
  }
  
  export enum MessageType {
    TEXT = 'text',
    IMAGE = 'image',
    VIDEO = 'video',
    AUDIO = 'audio',
    FILE = 'file',
    CARD = 'card',
    ACTIONS = 'actions'
  }
  
  export interface Feedback {
    id: string;
    messageId: string;
    userId?: string;
    rating: FeedbackRating;
    comment?: string;
    category?: string;
    isHelpful?: boolean;
    actionsTaken?: string;
    feedbackDate: number;
    reviewed: boolean;
    reviewedBy?: string;
    reviewDate?: number;
    createdAt: number;
    updatedAt: number;
  }
  
  export enum FeedbackRating {
    POSITIVE = 1,
    NEUTRAL = 0,
    NEGATIVE = -1
  }
  
  export interface MessageRequest {
    agentId: string;
    conversationId?: string;
    content: string;
    messageType?: MessageType;
    contentType?: string; 
    attachments?: Record<string, any>;
    metadata?: Record<string, any>;
  }
  
  export interface MessageResponse {
    messageId: string;
    conversationId: string;
    status: MessageStatus;
    timestamp: number;
  }
  
  export interface ContextResult {
    relevantChunks: Array<{
      content: string;
      documentId: string;
      chunkId: string;
      similarity: number;
    }>;
    conversationContext: Array<{
      role: MessageRole;
      content: string;
    }>;
    systemInstructions: string;
  }

  export interface IntegrationInfo { // Nueva interfaz auxiliar
    id: string;
    name: string;
    type: string; // Debería ser IntegrationType pero usamos string por simplicidad aquí
    provider: string;
  }

  export interface ContextResult {
    relevantChunks: Array<{
      content: string;
      documentId: string;
      chunkId: string;
      similarity: number;
    }>;
    conversationContext: Array<{
      role: MessageRole;
      content: string;
    }>;
    systemInstructions: string;
    activeIntegrations?: IntegrationInfo[]; // <-- Campo añadido
  }
  