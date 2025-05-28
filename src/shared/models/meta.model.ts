export interface WhatsAppBusinessAccount {
  id: string;
  name: string;
  message_template_namespace?: string;
  timezone_id?: string;
}

export interface WhatsAppPhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating?: string;
  certificate?: string;
}

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

export interface HandleWhatsAppEmbeddedSignupInput {
  agentId: string;
  esIntegrationCode: string;
  phoneNumberId: string;
  whatsAppBusinessAccountId: string;
  businessId: string;
}

export interface WhatsAppBusinessAccountResponse {
  id: string;
  name: string;
  owner_business_info: {
    name: string;
    id: string;
  };
}
