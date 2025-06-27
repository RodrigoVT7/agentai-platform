// src/functions/integrations/WhatsAppTemplateManager.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createLogger } from "../../shared/utils/logger";
import { JwtService } from "../../shared/utils/jwt.service";
import { toAppError } from "../../shared/utils/error.utils";
import { WhatsAppTemplateManagerHandler } from "../../shared/handlers/integrations/whatsAppTemplateManagerHandler";
import { StorageService } from "../../shared/services/storage.service";
import { STORAGE_TABLES } from "../../shared/constants";
import { Integration, IntegrationWhatsAppConfig } from "../../shared/models/integration.model";
import { Agent, AgentHandoffConfig, HandoffMethod } from "../../shared/models/agent.model";

async function getClientWhatsAppIntegration(agentId: string, platformUserId: string, storageService: StorageService, logger: any): Promise<Integration | null> {
    // 1. Fetch Agent to get clientWhatsAppIntegrationId from handoffConfig
    const agentTable = storageService.getTableClient(STORAGE_TABLES.AGENTS);

    let agentConfig: Agent;
    try {
        const agentEntity = await agentTable.getEntity('agent', agentId);
        agentConfig = agentEntity as unknown as Agent;
        if (agentConfig.userId !== platformUserId) {
            logger.warn(`Usuario ${platformUserId} no es dueño del agente ${agentId}.`);
            // Add role check here if non-owners with specific roles can manage templates
            return null;
        }
    } catch (error) {
        logger.error(`Agente ${agentId} no encontrado o error al acceder:`, error);
        return null;
    }

    let handoffConfig: AgentHandoffConfig | undefined;
    if (agentConfig.handoffConfig && typeof agentConfig.handoffConfig === 'string') {
        try {
            handoffConfig = JSON.parse(agentConfig.handoffConfig);
        } catch (e) {
            logger.error(`Error parseando handoffConfig para agente ${agentId}: ${e}`);
            return null;
        }
    }

    const clientWhatsAppIntegrationId = handoffConfig?.clientWhatsAppIntegrationId;
    if (!clientWhatsAppIntegrationId) {
        logger.warn(`Agente ${agentId} no tiene un clientWhatsAppIntegrationId configurado para handoff.`);
        return null;
    }

    // 2. Fetch the client's WhatsApp Integration record
    const integrationsTable = storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
    try {
        const integrationEntity = await integrationsTable.getEntity(agentId, clientWhatsAppIntegrationId);
        const clientIntegration = integrationEntity as unknown as Integration;

        if (clientIntegration.ownerUserId !== platformUserId) {
            logger.warn(`La integración ${clientWhatsAppIntegrationId} no pertenece al usuario ${platformUserId}.`);
            return null;
        }
        if (!clientIntegration.isActive || clientIntegration.provider !== "whatsapp") {
            logger.warn(`Integración ${clientWhatsAppIntegrationId} no está activa o no es de WhatsApp.`);
            return null;
        }
        return clientIntegration;
    } catch (error) {
        logger.error(`Error al obtener la integración de WhatsApp del cliente ${clientWhatsAppIntegrationId}:`, error);
        return null;
    }
}

export async function manageWhatsAppTemplates(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const logger = createLogger(context);
    logger.info("WhatsAppTemplateManager function processed a request.");

    const storageService = new StorageService();

    try {
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { status: 401, jsonBody: { error: "Se requiere autenticación de plataforma." } };
        }
        const token = authHeader.split(' ')[1];
        const jwtService = new JwtService();
        let platformUserPayload;
        try {
            platformUserPayload = jwtService.verifyToken(token);
        } catch (error) {
            return { status: 401, jsonBody: { error: "Token de plataforma inválido o expirado." } };
        }
        const platformUserId = platformUserPayload.userId;

        const handler = new WhatsAppTemplateManagerHandler(logger);
        const agentId = request.query.get("agentId");

        if (!agentId) {
            return { status: 400, jsonBody: { error: "Se requiere el parámetro 'agentId'." } };
        }

        // Fetch the client's WhatsApp integration details (which includes their User Access Token)
        const clientIntegration = await getClientWhatsAppIntegration(agentId, platformUserId, storageService, logger);

        if (!clientIntegration || !clientIntegration.config) {
            return { status: 404, jsonBody: { error: "No se encontró una integración de WhatsApp activa y configurada para este agente y usuario, o no tienes permiso." } };
        }

        const whatsAppConfig = (typeof clientIntegration.config === 'string' ? JSON.parse(clientIntegration.config) : clientIntegration.config) as IntegrationWhatsAppConfig;

        if (!whatsAppConfig.accessToken || !whatsAppConfig.businessAccountId) {
            return { status: 400, jsonBody: { error: "La configuración de la integración de WhatsApp del cliente está incompleta (falta accessToken o WABA ID)." } };
        }
        const clientUserAccessToken = whatsAppConfig.accessToken;
        const clientWabaId = whatsAppConfig.businessAccountId;

        if (request.method === "POST") { // Create a new template
            const templateData = await request.json() as any;
            if (!templateData.name || !templateData.language || !templateData.category || !templateData.components) {
                return { status: 400, jsonBody: { error: "Faltan campos requeridos para crear la plantilla." } };
            }

            const result = await handler.createTemplate(clientUserAccessToken, clientWabaId, templateData);

            if (result.success && result.templateId && result.status === "APPROVED") {
                // If approved (or pending), store template name and lang in Agent.handoffConfig
                const agentTable = storageService.getTableClient(STORAGE_TABLES.AGENTS);
                try {
                    const agentEntity = await agentTable.getEntity('agent', agentId);
                    const currentHandoffConfigStr = agentEntity.handoffConfig as string || '{}';
                    const currentHandoffConfig = JSON.parse(currentHandoffConfigStr) as AgentHandoffConfig;

                    currentHandoffConfig.clientWhatsAppTemplateName = templateData.name;
                    currentHandoffConfig.clientWhatsAppTemplateLangCode = templateData.language;

                    await agentTable.updateEntity({
                        partitionKey: 'agent',
                        rowKey: agentId,
                        handoffConfig: JSON.stringify(currentHandoffConfig)
                    }, "Merge");
                    logger.info(`HandoffConfig del Agente ${agentId} actualizado con la nueva plantilla: ${templateData.name}`);
                } catch (agentUpdateError) {
                     logger.error(`Error al actualizar handoffConfig del Agente ${agentId} con la nueva plantilla:`, agentUpdateError);
                }
            }
            return { status: result.success ? 201 : (result.error?.statusCode || 500), jsonBody: result };
        } else if (request.method === "GET") { // Get template status
            const messageTemplateId = request.query.get("templateId");
            if (!messageTemplateId) {
                return { status: 400, jsonBody: { error: "Se requiere el parámetro 'templateId' para obtener el estado." } };
            }
            const result = await handler.getTemplateStatus(clientUserAccessToken, messageTemplateId);
            return { status: result.success ? 200 : (result.error?.statusCode || 500), jsonBody: result };
        } else {
            return { status: 405, jsonBody: { error: "Método no permitido." } };
        }

    } catch (error) {
        logger.error("Error en WhatsAppTemplateManager:", error);
        const appError = toAppError(error);
        return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
}

app.http('WhatsAppTemplateManager', {
    methods: ['POST', 'GET'],
    authLevel: 'anonymous',
    route: 'integrations/whatsapp/templates',
    handler: manageWhatsAppTemplates
});