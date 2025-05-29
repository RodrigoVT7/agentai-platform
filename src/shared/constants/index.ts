export const STORAGE_TABLES = {
  USERS: "users",
  AGENTS: "agents",
  SESSIONS: "sessions",
  OTP_CODES: "otpcodes",
  KNOWLEDGE_BASES: "knowledgebases",
  DOCUMENTS: "documents",
  CONVERSATIONS: "conversations",
  MESSAGES: "messages",
  USER_ROLES: "userroles",
  HANDOFFS: "handoffs",
  USAGE_STATS: "usagestats",
  FEEDBACK: "feedback",
  INTEGRATION_CATALOG: "integrationcatalog",
  INTEGRATIONS: "integrations",
  INTEGRATION_LOGS: "integrationlogs",
  AGENT_STATUS: "agentstatus",
  SYSTEM_NOTIFICATION_TEMPLATES: "systemnotificationtemplates",
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
  SEND_MESSAGE: "send-message-queue"
};

export const AUTH_CONFIG = {
  JWT_EXPIRES_IN: "1h",
  REFRESH_TOKEN_EXPIRES_IN: "7d",
  OTP_EXPIRES_IN: 15 * 60 * 1000 // 15 minutos
};

export const BLOB_CONTAINERS = {
  DOCUMENTS: "documents",
  PROCESSED_DOCUMENTS: "processed-documents",
  KNOWLEDGE_BASES: "knowledge-bases",
  USER_UPLOADS: "user-uploads",
  BACKUPS: "backups",
  EXPORTS: "exports"
};

export const EMBEDDING_CONFIG = {
  CHUNK_SIZE: 1000,           // Tamaño del chunk en caracteres
  CHUNK_OVERLAP: 200,         // Solapamiento entre chunks
  MAX_TOKENS_PER_CHUNK: 8000  // Máximo de tokens por chunk
};

export const AI_CONFIG = {
  EMBEDDING_MODEL: "text-embedding-ada-002",
  CHAT_MODEL: "gpt-4o",
  TEMPERATURE: 0.7,
  MAX_TOKENS: 4000
};

export const AZURE_SEARCH_CONFIG = {
  ENDPOINT: process.env.AZURE_SEARCH_ENDPOINT || "",
  ADMIN_KEY: process.env.AZURE_SEARCH_ADMIN_KEY || "",
  QUERY_KEY: process.env.AZURE_SEARCH_QUERY_KEY || "",
  INDEX_NAME: process.env.AZURE_SEARCH_INDEX_NAME || ""
};

export const GOOGLE_CALENDAR_CONFIG = {
  DEFAULT_APPOINTMENT_DURATION_MINUTES: 60,
  BOOKED_BY_USER_ID_KEY: 'bookedByUserId_agentai',
  DEFAULT_MAX_CONCURRENT_APPOINTMENTS: 100
};