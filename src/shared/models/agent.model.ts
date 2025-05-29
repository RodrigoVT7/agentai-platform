// src/shared/models/agent.model.ts
export enum HandoffMethod {
  PLATFORM = 'platform',
  WHATSAPP = 'whatsapp',
  BOTH = 'both'
}

export interface AgentHandoffConfig {
  type: HandoffMethod;
  notificationTargets?: string[]; // Números de los agentes humanos del cliente (para notificaciones)

  // Campos para notificación de handoff usando el WhatsApp del CLIENTE
  clientWhatsAppIntegrationId?: string; // ID de la Integration del cliente con permisos de WA Business Management
  clientWhatsAppTemplateName?: string;  // Nombre de la plantilla de WhatsApp del CLIENTE para notificar handoff
  clientWhatsAppTemplateLangCode?: string; // Código de idioma de la plantilla del CLIENTE

  // (Opcional) Fallback a la plantilla de sistema si la del cliente no está configurada
  useSystemFallback?: boolean;
}

export interface Agent {
  id: string;
  userId: string; // Dueño del agente (tu cliente)
  code: string;
  name: string;
  description: string;
  modelType: string;
  modelConfig: string; // JSON string
  handoffEnabled: boolean;
  systemInstructions: string;
  temperature: number;
  isActive: boolean;
  operatingHours: string | null; // JSON string
  createdAt: number;
  organizationName?: string;
  handoffConfig?: string; // JSON string de AgentHandoffConfig
}