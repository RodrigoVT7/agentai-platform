// src/shared/models/integration.model.ts
export interface Integration {
    id: string;
    agentId: string;
    name: string;
    description?: string;
    type: IntegrationType;
    provider: string;
    config: string;
    credentials: string; // Encrypted credentials
    status: IntegrationStatus;
    createdBy: string;
    createdAt: number;
    updatedAt?: number;
    isActive: boolean;
  }
  
  export enum IntegrationType {
    MESSAGING = 'messaging',         // WhatsApp, Telegram, etc.
    CALENDAR = 'calendar',           // Google Calendar, Outlook
    EMAIL = 'email',                 // Gmail, Outlook
    DOCUMENT = 'document',           // Google Drive, OneDrive
    CRM = 'crm',                     // Salesforce, Hubspot
    ERP = 'erp',                     // SAP, Dynamics
    PAYMENT = 'payment',             // Stripe, PayPal
    TICKETING = 'ticketing',         // Zendesk, Freshdesk
    CUSTOM = 'custom'                // Custom integrations
  }
  
  export enum IntegrationStatus {
    PENDING = 'pending',             // Configuration started but not complete
    CONFIGURED = 'configured',       // Configuration complete but not tested
    ACTIVE = 'active',               // Tested and working
    ERROR = 'error',                 // Configuration error
    EXPIRED = 'expired'              // Auth token expired
  }
  
  export interface IntegrationCatalogItem {
    id: string;                      // Unique identifier in catalog
    name: string;                    // Display name
    description: string;             // Description
    type: IntegrationType;           // Type of integration
    provider: string;                // Provider name
    icon: string;                    // Icon URL
    capabilities: string[];          // List of capabilities
    requiresAuth: boolean;           // Requires OAuth
    setupGuide: string;              // Setup instructions
    configSchema: Record<string, any>; // JSON Schema for configuration
  }
  
  export interface IntegrationAction {
    integrationId: string;
    action: string;
    parameters: Record<string, any>;
    userId: string;
    conversationId?: string;
    messageId?: string;
    async?: boolean;                 // If true, execute asynchronously
    callbackUrl?: string;            // URL to call with result if async
  }
  
  export interface IntegrationWhatsAppConfig {
    phoneNumberId: string;
    businessAccountId: string;
    accessToken: string;
    webhookVerifyToken: string;
    phoneNumber: string;
    displayName: string;
    messagingLimit?: number;         // Daily message limit
    templates?: WhatsAppTemplate[];  // Message templates
  }
  
  export interface WhatsAppTemplate {
    name: string;
    language: string;
    status: string;
    category: string;
    components: any[];
  }
  
  export interface IntegrationGoogleCalendarConfig {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scope: string;
    calendarId: string;
    timezone?: string;
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
  
  export interface IntegrationERPConfig {
    type: string;                    // SAP, Dynamics, Odoo, etc.
    url: string;                     // Base URL
    username?: string;               // If using basic auth
    password?: string;               // If using basic auth
    apiKey?: string;                 // If using API key
    tenant?: string;                 // For multi-tenant systems
    companyId?: string;              // Company ID if applicable
    connectionParams?: Record<string, any>; // Additional connection parameters
    schemas?: Record<string, any>[];  // Schema definitions
  }