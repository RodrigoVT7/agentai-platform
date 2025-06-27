// src/shared/models/meta.model.ts

export interface HandleWhatsAppEmbeddedSignupInput {
  esIntegrationCode: string; // The integration code from Meta's Embedded Signup
  phoneNumberId: string;
  whatsAppBusinessAccountId: string;
  businessId: string; // Facebook Business ID
  agentId: string; // Your internal agent ID
}

export interface MetaAccessTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

export interface WhatsAppPhoneNumberAPI {
  id: string;
  display_phone_number: string;
  verified_name?: string;
  quality_rating?: string;
}

export interface WhatsAppBusinessAccountResponse {
  id: string;
  name?: string;
  currency?: string;
  owner_business_info?: {
    id: string;
    name?: string;
  };
  phone_numbers?: {
    data: WhatsAppPhoneNumberAPI[];
  };
}

export interface MetaSubscribedAppsResponse {
  success: boolean;
}