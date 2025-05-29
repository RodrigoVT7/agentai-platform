// src/shared/models/systemNotification.model.ts
export enum SystemNotificationPurpose {
  HANDOFF_TO_HUMAN_AGENT = 'HANDOFF_TO_HUMAN_AGENT',
  // Otros propósitos futuros, ej: OTP_VIA_WHATSAPP, PASSWORD_RESET_VIA_WHATSAPP
}

export interface SystemNotificationTemplate {
  templateId: string; // RowKey: Identificador único de esta configuración de plantilla en tu sistema (ej. "default_handoff_es_mx")
  purpose: SystemNotificationPurpose; // PartitionKey: Para qué se usa la plantilla
  description?: string;
  // El ID de TU integración de WhatsApp (de la tabla Integrations) que se usará para enviar.
  // Este integrationId debe corresponder a una integración activa de tu propiedad.
  whatsAppIntegrationId: string;
  metaTemplateName: string; // El nombre exacto de la plantilla aprobada en Meta Business Manager
  metaTemplateLangCode: string; // Ej. "es_MX", "en_US"
  // Opcional: Mapeo de variables conceptuales a placeholders {{n}} de la plantilla de Meta.
  // Esto da flexibilidad si los placeholders de la plantilla de Meta cambian.
  // Ejemplo: { "agentAIName": 1, "clientOwnerName": 2, "handoffId": 3, ... }
  // Indica que la variable conceptual "agentAIName" se mapea al placeholder {{1}} en la plantilla de Meta.
  parameterMapping?: string; // Almacenado como JSON string
  isActive: boolean;
  createdAt: number;
  updatedAt?: number;
}