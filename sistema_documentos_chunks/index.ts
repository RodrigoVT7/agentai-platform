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

  // NUEVAS TABLAS PARA WORKFLOWS AVANZADOS
  WORKFLOW_LOGS: 'workflowLogs',
  WORKFLOW_ANALYTICS: 'workflowAnalytics', 
  WORKFLOW_ALERTS: 'workflowAlerts',
  USER_PROFILES: 'userProfiles'
  
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

// src/shared/constants.ts
export const GOOGLE_CALENDAR_CONFIG = {
    DEFAULT_MAX_CONCURRENT_APPOINTMENTS: 1,
    DEFAULT_APPOINTMENT_DURATION_MINUTES: 60,
    BOOKED_BY_USER_ID_KEY: 'bookedByUserId',
    // NUEVO: Claves para metadatos de WhatsApp
    WHATSAPP_NUMBER_KEY: 'whatsappNumber',
    WHATSAPP_EMAIL_KEY: 'whatsappProvidedEmail',
    WHATSAPP_NAME_KEY: 'whatsappProvidedName',
    WHATSAPP_CONVERSATION_KEY: 'whatsappConversationId',
    WHATSAPP_AGENT_KEY: 'whatsappAgentId',
    // Configuración de validación de email
    EMAIL_VALIDATION_REGEX: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    // Tiempo de expiración para información temporal (30 minutos)
    TEMP_USER_INFO_EXPIRY_MS: 30 * 60 * 1000
};

// CONFIGURACIÓN DE WORKFLOWS AVANZADOS
export const WORKFLOW_CONFIG = {
  // Tiempos de ejecución
  MAX_EXECUTION_TIME_MS: 10000,
  DEFAULT_RETRY_DELAY_MS: 1000,
  MAX_RETRIES_PER_STEP: 3,
  
  // Scoring y selección
  MIN_WORKFLOW_SCORE: 10,
  ADVANCED_WORKFLOW_BONUS: 20,
  SUCCESS_RATE_WEIGHT: 30,
  EXECUTION_TIME_WEIGHT: 20,
  
  // Categorías de workflows
  CATEGORIES: {
    APPOINTMENTS: 'appointments',
    CUSTOMER_SERVICE: 'customer_service',
    SALES: 'sales',
    SUPPORT: 'support'
  },
  
  // Horarios de negocio (configurable por agente)
  DEFAULT_BUSINESS_HOURS: {
    START_HOUR: 9,
    END_HOUR: 18,
    WORKING_DAYS: [1, 2, 3, 4, 5] // Lunes a Viernes
  },
  
  // Umbrales para alertas
  ALERT_THRESHOLDS: {
    LOW_SUCCESS_RATE: 0.7,
    HIGH_RESPONSE_TIME_MS: 5000,
    MIN_EXECUTIONS_FOR_ALERT: 5
  },
  
  // Métricas y analytics
  ANALYTICS_RETENTION_DAYS: 90,
  REALTIME_WINDOW_MINUTES: 15
};

// PATRONES DE DETECCIÓN DE INTENCIONES
export const INTENT_PATTERNS = {
  SCHEDULE_APPOINTMENT: [
    'agendar', 'cita', 'appointment', 'schedule', 'consulta', 'reunión'
  ],
  RESCHEDULE_APPOINTMENT: [
    'cambiar', 'mover', 'reagendar', 'modificar', 'actualizar', 'reschedule'
  ],
  CANCEL_APPOINTMENT: [
    'cancelar', 'eliminar', 'borrar', 'cancel', 'delete'
  ],
  INQUIRY_PRICING: [
    'precio', 'costo', 'cost', 'price', 'cuanto', 'how much'
  ],
  INQUIRY_SERVICES: [
    'servicio', 'servicios', 'service', 'services', 'que ofrecen', 'what do you offer'
  ],
  URGENT_REQUEST: [
    'urgente', 'emergency', 'asap', 'ahora mismo', 'immediately', 'ya'
  ],
  CHECK_APPOINTMENTS: [
    'qué citas tengo', 'mis citas', 'my appointments', 'check appointments'
  ]
};

// CONFIGURACIÓN DE LOGGING AVANZADO
export const WORKFLOW_LOGGING = {
  LOG_LEVELS: {
    EXECUTION: 'execution',
    PERFORMANCE: 'performance',
    ERROR: 'error',
    USER_INTENT: 'user_intent'
  },
  
  RETENTION_POLICY: {
    EXECUTION_LOGS_DAYS: 30,
    ANALYTICS_DAYS: 90,
    ERROR_LOGS_DAYS: 180
  },
  
  BATCH_SIZE: 100 // Para procesamiento de analytics
};