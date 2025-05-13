// src/shared/models/meta.model.ts

// Respuesta al intercambiar el código de autorización por un token de acceso de corta duración
export interface MetaShortLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

// Respuesta al intercambiar el token de corta duración por uno de larga duración
export interface MetaLongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

// Datos de la cuenta de negocios de WhatsApp
export interface WhatsAppBusinessAccount {
  id: string;
  name: string;
  message_template_namespace?: string;
  timezone_id?: string;
}

// Información del número de teléfono de WhatsApp Business
export interface WhatsAppPhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating?: string;
  certificate?: string;
}

// Respuesta al obtener números de teléfono asociados a una cuenta de WhatsApp Business
export interface WhatsAppPhoneNumbersResponse {
  data: WhatsAppPhoneNumber[];
  paging?: {
    cursors: {
      before: string;
      after: string;
    };
    next?: string;
  };
}

// Respuesta al obtener cuentas de WhatsApp Business asociadas a una cuenta de Meta
export interface WhatsAppBusinessAccountsResponse {
  data: WhatsAppBusinessAccount[];
  paging?: {
    cursors: {
      before: string;
      after: string;
    };
    next?: string;
  };
}
