export const STORAGE_TABLES = {
  USERS: "users",
  AGENTS: "agents",
  SESSIONS: "sessions",
  OTP_CODES: "otpcodes",
  KNOWLEDGE_BASES: "knowledgebases",
  DOCUMENTS: "documents",
  VECTORS: "vectors",
  CONVERSATIONS: "conversations",
  MESSAGES: "messages",
  USER_ROLES: "userroles",
  HANDOFFS: "handoffs",
  USAGE_STATS: "usagestats",
  FEEDBACK: "feedback",
  INTEGRATION_CATALOG: "integrationcatalog",
  INTEGRATIONS: "integrations",
  INTEGRATION_LOGS: "integrationlogs",
};

export const STORAGE_CONTAINERS = {
  QUESTIONNAIRE_SUBMISSIONS: "questionnaire-submissions",
  QUESTIONNAIRE_RESPONSES: "questionnaireresponses",
};

export const STORAGE_QUEUES = {
  NOTIFICATION: "notification-queue",
  OTP: "otp-queue",
  DOCUMENT_PROCESSING: "document-processing-queue",
  EMBEDDING: "embedding-queue",
  CONVERSATION: "conversation-queue",
  COMPLETION: "completion-queue",
  HANDOFF: "handoff-queue",
  INTEGRATION: "integration-queue",
};

export const AUTH_CONFIG = {
  JWT_EXPIRES_IN: "1h",
  REFRESH_TOKEN_EXPIRES_IN: "7d",
  OTP_EXPIRES_IN: 15 * 60 * 1000, // 15 minutos
};

export const BLOB_CONTAINERS = {
  DOCUMENTS: "documents",
  PROCESSED_DOCUMENTS: "processed-documents",
  KNOWLEDGE_BASES: "knowledge-bases",
  USER_UPLOADS: "user-uploads",
  BACKUPS: "backups",
  EXPORTS: "exports",
};

export const EMBEDDING_CONFIG = {
  CHUNK_SIZE: 1000, // Tamaño del chunk en caracteres
  CHUNK_OVERLAP: 200, // Solapamiento entre chunks
  MAX_TOKENS_PER_CHUNK: 8000, // Máximo de tokens por chunk
};

export const AI_CONFIG = {
  EMBEDDING_MODEL: "embeddings",
  CHAT_MODEL: "gpt-4o",
  TEMPERATURE: 0.7,
  MAX_TOKENS: 4000,
};
