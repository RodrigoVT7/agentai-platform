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
  CUSTOM = 'custom'
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
    id: string; agentId: string; name: string; description?: string; type: IntegrationType; provider: string; config: string | object; // Puede ser string u objeto parseado
    credentials?: string; // Encrypted?
    status: IntegrationStatus; createdBy: string; createdAt: number; updatedAt?: number; isActive: boolean;
  }
export interface IntegrationAction { /* ... */ integrationId: string; action: string; parameters: Record<string, any>; userId: string; conversationId?: string; messageId?: string; async?: boolean; callbackUrl?: string; }
export interface IntegrationWhatsAppConfig { /* ... */ phoneNumberId: string; businessAccountId: string; accessToken: string; webhookVerifyToken: string; phoneNumber: string; displayName: string; messagingLimit?: number; templates?: any[];}
export interface IntegrationGoogleCalendarConfig { /* ... */ accessToken: string; refreshToken: string; expiresAt: number; scope: string; calendarId: string; timezone?: string; }
export interface IntegrationERPConfig {
  type: string;
  url: string;
  username?: string;
  password?: string;
  apiKey?: string;
  tenant?: string;
  companyId?: string;
  connectionParams?: Record<string, any>;
  // Define una estructura más específica si es posible
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
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  webhookVerifyToken: string;
  phoneNumber: string;
  displayName: string;
  messagingLimit?: number;
  templates?: any[];
}