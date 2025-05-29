// src/shared/handlers/integrations/whatsAppTemplateManagerHandler.ts
import { Logger, createLogger } from "../../utils/logger";
import { createAppError, toAppError } from "../../utils/error.utils";
import fetch from "node-fetch";

// Interfaces based on Meta Graph API documentation for templates
interface WhatsAppTemplateComponent {
    type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
    format?: "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO"; // For HEADER
    text?: string; // For HEADER (type TEXT), BODY, FOOTER
    example?: { // For variable placeholders in BODY or HEADER
        header_text?: string[];
        body_text?: string[][]; // Array of arrays for multiple examples or variables
        // header_handle?: string[]; // For media
    };
    buttons?: WhatsAppTemplateButton[]; // For BUTTONS
}

interface WhatsAppTemplateButton {
    type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER"; // Add "COPY_CODE" if needed
    text: string; // Text for quick reply or button display
    url?: string; // For URL button
    phone_number?: string; // For PHONE_NUMBER button
    example?: string[]; // For URL button with dynamic suffix
}

interface CreateTemplateRequest {
    name: string; // Must be unique within WABA, lowercase, and use underscores
    language: string; // e.g., "en_US", "es_MX"
    category: "AUTHENTICATION" | "MARKETING" | "UTILITY"; // Meta categories
    components: WhatsAppTemplateComponent[];
    allow_category_change?: boolean;
}

interface TemplateStatusResponse {
    id: string;
    status: "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED" | "IN_APPEAL";
    category: string;
    // ... other fields
}

export class WhatsAppTemplateManagerHandler {
    private logger: Logger;

    constructor(logger?: Logger) {
        this.logger = logger || createLogger();
    }

    /**
     * Creates a new message template and submits it for review.
     * @param clientUserAccessToken The long-lived User Access Token of the client.
     * @param wabaId The WhatsApp Business Account ID of the client.
     * @param templateData The template structure.
     */
    async createTemplate(
        clientUserAccessToken: string,
        wabaId: string,
        templateData: CreateTemplateRequest
    ): Promise<{ success: boolean; templateId?: string; status?: string; error?: any }> {
        this.logger.info(`Creando plantilla de WhatsApp '${templateData.name}' para WABA ${wabaId.substring(0,10)}...`);
        try {
            const apiUrl = `https://graph.facebook.com/v19.0/${wabaId}/message_templates`;
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${clientUserAccessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(templateData)
            });

            const responseBody = await response.json() as any;

            if (!response.ok) {
                this.logger.error("Error de API de Meta al crear plantilla:", responseBody);
                throw createAppError(response.status, "Error de API de Meta al crear plantilla", responseBody.error || responseBody);
            }

            this.logger.info("Plantilla enviada a Meta para revisión:", responseBody);
            return {
                success: true,
                templateId: responseBody.id, // Meta returns an ID even if pending
                status: responseBody.status || "PENDING" // Meta might return status
            };

        } catch (error) {
            this.logger.error("Error en WhatsAppTemplateManagerHandler.createTemplate:", error);
            const appError = toAppError(error);
            return { success: false, error: { message: appError.message, details: appError.details, statusCode: appError.statusCode } };
        }
    }

    /**
     * Gets the status of a specific message template.
     * @param clientUserAccessToken The long-lived User Access Token of the client.
     * @param messageTemplateId The ID of the message template (obtained after creation).
     */
    async getTemplateStatus(
        clientUserAccessToken: string,
        messageTemplateId: string
    ): Promise<{ success: boolean; data?: TemplateStatusResponse; error?: any }> {
        this.logger.info(`Consultando estado de plantilla de WhatsApp ID: ${messageTemplateId}`);
        try {
            const apiUrl = `https://graph.facebook.com/v19.0/${messageTemplateId}?fields=id,status,category,name,language,components`; // Request specific fields
            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${clientUserAccessToken}`
                }
            });

            const responseBody = await response.json() as any;

            if (!response.ok) {
                this.logger.error("Error de API de Meta al obtener estado de plantilla:", responseBody);
                throw createAppError(response.status, "Error de API de Meta al obtener estado de plantilla", responseBody.error || responseBody);
            }

            this.logger.info(`Estado de plantilla ${messageTemplateId}:`, responseBody);
            return { success: true, data: responseBody as TemplateStatusResponse };

        } catch (error) {
            this.logger.error(`Error en WhatsAppTemplateManagerHandler.getTemplateStatus para ID ${messageTemplateId}:`, error);
            const appError = toAppError(error);
            return { success: false, error: { message: appError.message, details: appError.details, statusCode: appError.statusCode } };
        }
    }

    // TODO: Add methods for listing templates, deleting templates if needed.
}