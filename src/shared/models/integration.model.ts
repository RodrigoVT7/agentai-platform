// src/shared/models/integration.model.ts

export enum IntegrationType {
  MESSAGING = 'messaging',
  CALENDAR = 'calendar',
  EMAIL = 'email',
  DOCUMENT = 'document',
  CRM = 'crm',
  ERP = 'erp',
  PAYMENT = 'payment',
  TICKETING = 'ticketing',
  CUSTOM = 'custom',
  SYSTEM_INTERNAL = 'system_internal'
}

export enum IntegrationStatus {
  PENDING = 'pending',
  CONFIGURED = 'configured',
  ACTIVE = 'active',
  ERROR = 'error',
  EXPIRED = 'expired'
}

// *** Definición para cada herramienta/capacidad ***
export interface CapabilityToolDefinition {
  capabilityId: string; // ID interno (ej: "createEvent")
  toolName: string;     // Nombre para OpenAI (ej: "createCalendarEvent")
  description: string;  // Descripción para OpenAI
  parametersSchema: {   // Esquema JSON para OpenAI
    type: "object";
    properties: Record<string, {
      type: string;
      description: string;
      format?: string;
      enum?: string[];
      items?: any;
      properties?: Record<string, any>; // Para objetos anidados
      required?: string[]; // Para propiedades requeridas en objetos anidados
    }>;
    required?: string[];
  };
}

// *** Interfaz actualizada para el catálogo ***
export interface IntegrationCatalogItem {
  id: string;
  name: string;
  description: string;
  type: IntegrationType;
  provider: string;
  icon: string;
  capabilityTools: CapabilityToolDefinition[]; // <-- Usar esta propiedad
  requiresAuth: boolean;
  setupGuide: string;
  configSchema: Record<string, any>; // Schema para configurar la integración
}

export interface Integration {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  type: IntegrationType;
  provider: string; // e.g., 'whatsapp', 'google'
  config: string | object; // JSON string o un objeto parseado (IntegrationWhatsAppConfig, IntegrationGoogleCalendarConfig, etc.)
  credentials?: string; // Considerar para tokens de corta duración o API keys, pero el accessToken de WhatsApp irá en config.
  status: IntegrationStatus;
  createdBy: string; // userId del dueño de la plataforma o del cliente que configuró.
  createdAt: number;
  updatedAt?: number;
  isActive: boolean;
  // Nuevo campo para identificar al dueño de la plataforma/cliente
  ownerUserId?: string; // userId del cliente dueño del Agente AI y, por ende, de esta config.
}

export interface IntegrationAction { /* ... */ 
  integrationId: string; 
  action: string; 
  parameters: Record<string, any>; 
  userId: string; 
  conversationId?: string; 
  messageId?: string; 
  async?: boolean; 
  callbackUrl?: string; 
  customHandlerParams?: Record<string, any>;
}

export interface IntegrationGoogleCalendarConfig { /* ... */ 
  accessToken: string; 
  refreshToken: string; 
  expiresAt: number; 
  scope: string; 
  calendarId: string; 
  timezone?: string; 
  maxConcurrentAppointments?: number; 
}
export interface IntegrationERPConfig {
  type: string;
  url: string;
  username?: string;
  password?: string;
  apiKey?: string;
  tenant?: string;
  companyId?: string;
  connectionParams?: Record<string, any>;
  schemas?: { name: string; entities: any[] }[];
}
export interface IntegrationMicrosoftConfig {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  primaryCalendar?: string;
  primaryMailbox?: string;
  timezone?: string;
}

export interface IntegrationWhatsAppConfig {
  phoneNumberId: string; // ID del número de teléfono de WhatsApp del cliente
  businessAccountId: string; // ID de la cuenta de negocio de WhatsApp del cliente (WABA ID)
  accessToken: string; // Token de acceso de USUARIO de larga duración del cliente
  webhookVerifyToken?: string; // Si tu plataforma gestiona el webhook para el cliente
  phoneNumber: string; // Número de teléfono legible del cliente
  displayName: string; // Nombre para mostrar del número
  messagingLimit?: number;
  templates?: any[]; // Podrías almacenar aquí plantillas gestionadas por el cliente
  platformManaged?: boolean; // Indica si esta integración fue autorizada por el cliente para gestión de la plataforma
  userAccessTokenExpiresAt?: number; // Fecha de expiración del userAccessToken
  // systemAppScopedBusinessAssetId?: string; // ID del activo de negocio (WABA) con alcance de aplicación de sistema (si aplica)
}