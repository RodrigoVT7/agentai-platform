export const STORAGE_TABLES = {
  USERS: "users",
  AGENTS: "agents",
  SESSIONS: "sessions",
  OTP_CODES: "otp_codes",
  KNOWLEDGE_BASES: "knowledge_bases",
  DOCUMENTS: "documents",
  CONVERSATIONS: "conversations",
  MESSAGES: "messages"
};

export const STORAGE_QUEUES = {
  NOTIFICATION: "notification-queue",
  OTP: "otp-queue",
  DOCUMENT_PROCESSING: "document-processing-queue",
  EMBEDDING: "embedding-queue"
};

export const AUTH_CONFIG = {
  JWT_EXPIRES_IN: "1h",
  REFRESH_TOKEN_EXPIRES_IN: "7d",
  OTP_EXPIRES_IN: 15 * 60 * 1000 // 15 minutos
};
