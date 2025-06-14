// src/shared/handlers/handoff/handoffInitiatorHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Conversation, ConversationStatus, MessageRole } from "../../models/conversation.model";
import { Handoff, HandoffStatus, HandoffInitiateRequest } from "../../models/handoff.model";
import { Agent, HandoffMethod, AgentHandoffConfig } from "../../models/agent.model";
import { WhatsAppIntegrationHandler } from "../integrations/whatsAppIntegrationHandler";
import { IntegrationWhatsAppConfig, IntegrationStatus as IntegrationAppStatus, Integration } from "../../models/integration.model";
import { SystemNotificationPurpose, SystemNotificationTemplate } from "../../models/systemNotification.model";

interface SystemWhatsAppTemplateDbConfig {
    integrationId: string;
    templateName: string;
    templateLangCode: string;
    parameterMapping?: Record<string, string>;
}

export class HandoffInitiatorHandler {
    private storageService: StorageService;
    private logger: Logger;
    private whatsAppHandler: WhatsAppIntegrationHandler;

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.logger = logger || createLogger();
        this.whatsAppHandler = new WhatsAppIntegrationHandler(this.logger);
    }

    private async getAgentAIConfig(agentId: string): Promise<Agent | null> {
        const agentTable = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
        try {
            const agentEntity = await agentTable.getEntity('agent', agentId);
            const agentConfig = agentEntity as unknown as Agent;

            if (agentConfig.handoffConfig && typeof agentConfig.handoffConfig === 'string') {
                try {
                    agentConfig.handoffConfig = JSON.parse(agentConfig.handoffConfig);
                } catch (e) {
                    this.logger.error(`Error al parsear handoffConfig para agente ${agentId}: ${e}`);
                    agentConfig.handoffConfig = JSON.stringify({ type: HandoffMethod.PLATFORM, notificationTargets: [] });
                }
            } else if (!agentConfig.handoffConfig) {
                agentConfig.handoffConfig = JSON.stringify({ type: HandoffMethod.PLATFORM, notificationTargets: [] });
            }

            agentConfig.organizationName = agentConfig.organizationName || "Organización Desconocida";
            return agentConfig;
        } catch (e: any) {
            if (e.statusCode === 404) {
                this.logger.error(`Agente AI con ID ${agentId} no encontrado.`);
                return null;
            }
            this.logger.error(`Error obteniendo configuración del agente AI ${agentId}:`, e);
            throw e;
        }
    }

    private async getSystemWhatsAppTemplateConfig(purpose: SystemNotificationPurpose): Promise<SystemWhatsAppTemplateDbConfig | null> {
        try {
            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.SYSTEM_NOTIFICATION_TEMPLATES);
            const filter = `PartitionKey eq '${purpose}' and isActive eq true`;
            const templateConfigs = tableClient.listEntities({ queryOptions: { filter } });

            for await (const configEntity of templateConfigs) {
                this.logger.info(`Configuración de plantilla de sistema encontrada para propósito '${purpose}': ${configEntity.rowKey}`);
                let parameterMapping;
                if (configEntity.parameterMapping && typeof configEntity.parameterMapping === 'string') {
                    try {
                        parameterMapping = JSON.parse(configEntity.parameterMapping as string);
                    } catch (e) {
                        this.logger.error(`Error parseando parameterMapping para plantilla ${configEntity.rowKey}: ${e}`);
                        parameterMapping = undefined;
                    }
                }

                return {
                    integrationId: configEntity.whatsAppIntegrationId as string,
                    templateName: configEntity.metaTemplateName as string,
                    templateLangCode: configEntity.metaTemplateLangCode as string,
                    parameterMapping: parameterMapping
                };
            }
            this.logger.error(`No se encontró configuración de plantilla de sistema activa para el propósito: ${purpose}`);
            return null;
        } catch (error) {
            this.logger.error(`Error obteniendo configuración de plantilla de sistema para propósito '${purpose}':`, error);
            return null;
        }
    }

    private extractClientOriginalIdentifier(conversation: Conversation): string {
        if (conversation.metadata?.whatsapp?.from) {
            return conversation.metadata.whatsapp.from;
        }
        return conversation.endUserId || conversation.userId;
    }

    private formatWhatsAppLink(clientIdentifier: string): string {
        if (clientIdentifier.startsWith('whatsapp:')) {
            return `https://wa.me/${clientIdentifier.substring(9)}`;
        } else if (/^\+?[1-9]\d{1,14}$/.test(clientIdentifier)) {
            return `https://wa.me/${clientIdentifier.replace('+', '')}`;
        }
        return "N/A (Identificador de cliente no es de WhatsApp)";
    }

    /**
     * Genera un resumen mejorado de la conversación para el handoff
     */
    private async generateConversationSummary(conversationId: string, reason?: string): Promise<string> {
        try {
            const messagesTable = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
            const lastMessages: any[] = [];
            
            // Obtener más mensajes para un contexto mejor
            const messageEntities = messagesTable.listEntities({
                queryOptions: { filter: `PartitionKey eq '${conversationId}'` }
            });
            
            for await (const msgEntity of messageEntities) { 
                lastMessages.push(msgEntity); 
            }

            // Ordenar por timestamp y tomar los últimos 8 mensajes
            lastMessages.sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
            const recentMessages = lastMessages.slice(-8);

            if (recentMessages.length === 0) {
                return reason || "Solicitud de asistencia de agente humano.";
            }

            // Construir resumen estructurado
            let summary = reason ? `**Motivo:** ${reason}\n\n` : '';
            summary += `**Resumen de la conversación (últimos ${recentMessages.length} mensajes):**\n\n`;

            // Calcular duración de la conversación
            const firstMessage = recentMessages[0];
            const lastMessage = recentMessages[recentMessages.length - 1];
            const durationMinutes = Math.round((lastMessage.timestamp - firstMessage.timestamp) / (1000 * 60));
            
            if (durationMinutes > 0) {
                summary += `⏱️ **Duración:** ${durationMinutes} minutos\n\n`;
            }

            // Agregar mensajes con formato mejorado
            recentMessages.forEach((msg, index) => {
                const timestamp = new Date(msg.timestamp).toLocaleTimeString('es-MX', { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                });
                
                const roleIcon = msg.role === MessageRole.USER ? '👤' : '🤖';
                const roleName = msg.role === MessageRole.USER ? 'Cliente' : 'Bot';
                const content = String(msg.content).substring(0, 200);
                const truncated = String(msg.content).length > 200 ? '...' : '';
                
                summary += `${roleIcon} **${roleName}** (${timestamp}): ${content}${truncated}\n\n`;
            });

            // Detectar patrones en la conversación
            const userMessages = recentMessages.filter(m => m.role === MessageRole.USER);
            const botMessages = recentMessages.filter(m => m.role === MessageRole.ASSISTANT);
            
            if (userMessages.length > botMessages.length) {
                summary += `⚠️ **Nota:** El cliente ha enviado más mensajes que respuestas del bot, posible frustración.\n`;
            }

            // Detectar palabras clave de escalación
            const escalationKeywords = ['agente', 'humano', 'persona', 'ayuda', 'problema', 'no entiendo', 'malo', 'error'];
            const hasEscalationKeywords = userMessages.some(msg => 
                escalationKeywords.some(keyword => 
                    String(msg.content).toLowerCase().includes(keyword)
                )
            );
            
            if (hasEscalationKeywords) {
                summary += `🔍 **Detectado:** El cliente ha solicitado asistencia humana explícitamente.\n`;
            }

            return summary.trim();

        } catch (summaryError) {
            this.logger.warn(`No se pudo generar resumen mejorado para conv ${conversationId}:`, summaryError);
            return reason || "Solicitud de asistencia de agente humano.";
        }
    }

    /**
     * Genera el enlace a la plataforma con información contextual
     */
    private generatePlatformLink(handoffId: string, conversation: Conversation): string {
        const baseUrl = process.env.HANDOFF_PLATFORM_URL_BASE || 'https://platform.example.com';
        
        // Incluir parámetros útiles para el agente humano
        const params = new URLSearchParams({
            handoffId: handoffId,
            conversationId: conversation.id,
            agentId: conversation.agentId,
            channel: conversation.sourceChannel,
            userId: conversation.endUserId || conversation.userId
        });

        return `${baseUrl}/manage/handoff/${handoffId}?${params.toString()}`;
    }

    async execute(data: HandoffInitiateRequest, requestorId: string): Promise<any> {
        const { conversationId, agentId, reason, initiatedBy } = data;

        let agentAIConfigEntity: Agent | null = null;
        let conversation: Conversation | null = null;
        let handoffId = uuidv4();

        try {
            // 1. Validar agente AI
            agentAIConfigEntity = await this.getAgentAIConfig(agentId);
            if (!agentAIConfigEntity) {
                throw createAppError(404, `Agente AI con ID ${agentId} no encontrado.`);
            }

            if (!agentAIConfigEntity.handoffEnabled) {
                throw createAppError(400, "El handoff no está habilitado para este agente AI.");
            }

            // 2. Parsear configuración de handoff
            let agentHandoffSettings: AgentHandoffConfig;
            if (agentAIConfigEntity.handoffConfig && typeof agentAIConfigEntity.handoffConfig === 'string') {
                try {
                    agentHandoffSettings = JSON.parse(agentAIConfigEntity.handoffConfig);
                    if (!agentHandoffSettings || typeof agentHandoffSettings.type !== 'string' || !Object.values(HandoffMethod).includes(agentHandoffSettings.type)) {
                        this.logger.warn(`handoffConfig.type inválido para Agente AI ${agentId}. Usando default PLATFORM.`);
                        agentHandoffSettings = { type: HandoffMethod.PLATFORM, notificationTargets: [] };
                    }
                    agentHandoffSettings.notificationTargets = Array.isArray(agentHandoffSettings.notificationTargets) ? agentHandoffSettings.notificationTargets : [];
                } catch (e) {
                    this.logger.error(`Error parseando handoffConfig JSON para Agente AI ${agentId}: ${e}`);
                    agentHandoffSettings = { type: HandoffMethod.PLATFORM, notificationTargets: [] };
                }
            } else {
                agentHandoffSettings = { type: HandoffMethod.PLATFORM, notificationTargets: [] };
            }

            // 3. Validar conversación
            const conversationTable = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
            try {
                const convEntity = await conversationTable.getEntity(agentId, conversationId);
                if ((convEntity.status as ConversationStatus) !== ConversationStatus.ACTIVE) {
                    throw createAppError(400, `La conversación ${conversationId} no está activa (estado: ${convEntity.status}).`);
                }
                conversation = convEntity as unknown as Conversation;
                
                // Parsear metadata si es string
                if (conversation.metadata && typeof conversation.metadata === 'string') {
                    try { 
                        conversation.metadata = JSON.parse(conversation.metadata); 
                    } catch (e) { 
                        this.logger.warn(`Error parseando metadata de conv ${conversationId}: ${e}`); 
                        conversation.metadata = {}; 
                    }
                } else if (!conversation.metadata) {
                    conversation.metadata = {};
                }
            } catch (error: any) {
                if (error.statusCode === 404) {
                    throw createAppError(404, `Conversación ${conversationId} no encontrada para agente ${agentId}.`);
                }
                throw error;
            }

            // 4. Verificar handoffs existentes
            const handoffTable = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
            const existingHandoffs = handoffTable.listEntities({
                queryOptions: { 
                    filter: `conversationId eq '${conversationId}' and (status eq '${HandoffStatus.PENDING}' or status eq '${HandoffStatus.ACTIVE}') and isActive eq true` 
                }
            });
            for await (const existing of existingHandoffs) {
                throw createAppError(409, `Ya existe un handoff ${existing.status} para esta conversación (ID: ${existing.rowKey}).`);
            }

            // 5. Generar resumen mejorado de la conversación
            const conversationSummary = await this.generateConversationSummary(conversationId, reason);

            // 6. Crear el handoff
            const now = Date.now();
            const notifiedViaValues: string[] = [];
            const handoffMethodToUse = agentHandoffSettings.type || HandoffMethod.PLATFORM;

            const newHandoff: Handoff = {
                id: handoffId,
                agentId,
                conversationId,
                userId: conversation.endUserId || conversation.userId,
                status: HandoffStatus.PENDING,
                reason: conversationSummary,
                initiatedBy: initiatedBy || requestorId,
                createdAt: now,
                queuedAt: now,
                isActive: true,
                notificationMethod: undefined,
                notifiedAgents: undefined
            };

            // 7. Procesar notificaciones según el método configurado
            if (handoffMethodToUse === HandoffMethod.PLATFORM || handoffMethodToUse === HandoffMethod.BOTH) {
                this.logger.info(`Handoff ${handoffId} marcado para notificación vía plataforma interna.`);
                notifiedViaValues.push(HandoffMethod.PLATFORM);
            }

            if (handoffMethodToUse === HandoffMethod.WHATSAPP || handoffMethodToUse === HandoffMethod.BOTH) {
                const notificationResult = await this.processWhatsAppNotifications(
                    agentHandoffSettings, 
                    agentAIConfigEntity, 
                    conversation, 
                    newHandoff, 
                    handoffId
                );
                notifiedViaValues.push(...notificationResult);
            }

            // 8. Finalizar creación del handoff
            newHandoff.notificationMethod = notifiedViaValues.length > 0 ? notifiedViaValues.join(',') : HandoffMethod.PLATFORM;
            newHandoff.notifiedAgents = (handoffMethodToUse === HandoffMethod.WHATSAPP || handoffMethodToUse === HandoffMethod.BOTH) && agentHandoffSettings.notificationTargets
                ? JSON.stringify(agentHandoffSettings.notificationTargets)
                : undefined;

            await handoffTable.createEntity({
                partitionKey: agentId,
                rowKey: handoffId,
                ...newHandoff
            });

            // 9. Actualizar estado de la conversación
            await conversationTable.updateEntity({
                partitionKey: agentId,
                rowKey: conversationId,
                status: ConversationStatus.TRANSFERRED,
                updatedAt: now
            }, "Merge");

            this.logger.info(`Handoff ${handoffId} iniciado para conversación ${conversationId}. Notificado vía: ${newHandoff.notificationMethod}`);

            return {
                handoffId,
                conversationId,
                status: HandoffStatus.PENDING,
                notificationMethod: newHandoff.notificationMethod,
                message: "Solicitud de handoff registrada y notificaciones enviadas."
            };

        } catch (error: unknown) {
            this.logger.error(`Error al iniciar handoff para conversación ${conversationId}:`, error);
            if (error && typeof error === 'object' && 'statusCode' in error) {
                throw error;
            }
            throw createAppError(500, 'Error al iniciar handoff');
        }
    }

    /**
     * Procesa las notificaciones de WhatsApp para el handoff
     */
    private async processWhatsAppNotifications(
        agentHandoffSettings: AgentHandoffConfig,
        agentAIConfigEntity: Agent,
        conversation: Conversation,
        newHandoff: Handoff,
        handoffId: string
    ): Promise<string[]> {
        const notifiedViaValues: string[] = [];
        const { clientWhatsAppIntegrationId, clientWhatsAppTemplateName, clientWhatsAppTemplateLangCode, notificationTargets, useSystemFallback } = agentHandoffSettings;

        let clientIntegrationConfig: IntegrationWhatsAppConfig | null = null;
        let clientAccessToken: string | null = null;
        let clientPhoneNumberId: string | null = null;

        // Intentar usar integración del cliente
        if (clientWhatsAppIntegrationId) {
            const integrationsTable = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
            try {
                const integrationEntity = await integrationsTable.getEntity(agentAIConfigEntity.id, clientWhatsAppIntegrationId);
                const clientIntegration = integrationEntity as unknown as Integration;

                if (clientIntegration && clientIntegration.isActive && clientIntegration.provider === "whatsapp" && clientIntegration.status === IntegrationAppStatus.ACTIVE) {
                    if (typeof clientIntegration.config === 'string') {
                        clientIntegrationConfig = JSON.parse(clientIntegration.config) as IntegrationWhatsAppConfig;
                    } else {
                        clientIntegrationConfig = clientIntegration.config as IntegrationWhatsAppConfig;
                    }
                    clientAccessToken = clientIntegrationConfig.accessToken;
                    clientPhoneNumberId = clientIntegrationConfig.phoneNumberId;
                    this.logger.info(`Usando integración de WhatsApp del cliente ${clientWhatsAppIntegrationId} para handoff ${handoffId}.`);
                } else {
                    this.logger.warn(`La integración de WhatsApp del cliente ${clientWhatsAppIntegrationId} no está activa o no es válida.`);
                }
            } catch (err) {
                this.logger.error(`Error al obtener la integración de WhatsApp del cliente ${clientWhatsAppIntegrationId}:`, err);
            }
        }

        // Enviar notificaciones usando plantilla del cliente
        if (clientAccessToken && clientPhoneNumberId && clientWhatsAppTemplateName && clientWhatsAppTemplateLangCode && notificationTargets && notificationTargets.length > 0) {
            const success = await this.sendClientTemplateNotifications(
                clientAccessToken,
                clientPhoneNumberId,
                clientWhatsAppTemplateName,
                clientWhatsAppTemplateLangCode,
                notificationTargets,
                agentAIConfigEntity,
                conversation,
                newHandoff,
                handoffId
            );
            
            if (success) {
                notifiedViaValues.push(`${HandoffMethod.WHATSAPP}-cliente`);
            }
        } 
        // Fallback a sistema si está habilitado
        else if (useSystemFallback !== false && notificationTargets && notificationTargets.length > 0) {
            const success = await this.sendSystemTemplateNotifications(
                notificationTargets,
                agentAIConfigEntity,
                conversation,
                newHandoff,
                handoffId
            );
            
            if (success) {
                notifiedViaValues.push(`${HandoffMethod.WHATSAPP}-sistema`);
            }
        } else {
            this.logger.warn(`Handoff por WhatsApp para Agente AI ${agentAIConfigEntity.id} pero no hay configuración válida.`);
        }

        return notifiedViaValues;
    }

    /**
     * Envía notificaciones usando plantilla del cliente
     */
    private async sendClientTemplateNotifications(
        clientAccessToken: string,
        clientPhoneNumberId: string,
        templateName: string,
        templateLangCode: string,
        notificationTargets: string[],
        agentAIConfigEntity: Agent,
        conversation: Conversation,
        newHandoff: Handoff,
        handoffId: string
    ): Promise<boolean> {
        try {
            this.logger.info(`Enviando notificaciones de handoff usando plantilla del CLIENTE: ${templateName}`);
            
            const clientIdentifier = this.extractClientOriginalIdentifier(conversation);
            const clientWhatsAppLink = this.formatWhatsAppLink(clientIdentifier);
            const clientOwnerName = agentAIConfigEntity.organizationName || "N/A";
            const platformLink = this.generatePlatformLink(handoffId, conversation);
            const clientName = conversation.metadata?.whatsapp?.fromName || clientIdentifier;

            let successCount = 0;

            for (const agentHumanPhoneNumber of notificationTargets) {
                const templateParameters = [
                    { type: 'text', text: agentAIConfigEntity.name },        // {{1}} Nombre del Agente AI
                    { type: 'text', text: clientOwnerName },                 // {{2}} Nombre de la Organización
                    { type: 'text', text: handoffId },                       // {{3}} ID del Handoff
                    { type: 'text', text: clientName },                      // {{4}} Nombre del Cliente
                    { type: 'text', text: String(newHandoff.reason).substring(0, 200) + '...' }, // {{5}} Razón (acortada)
                    { type: 'text', text: clientWhatsAppLink },              // {{6}} Link al chat del Cliente
                    { type: 'text', text: platformLink}                      // {{7}} Link a la plataforma
                ];

                const messagePayload = {
                    integrationId: clientPhoneNumberId, // Usar directamente el phoneNumberId
                    to: agentHumanPhoneNumber,
                    type: 'template' as 'template',
                    template: {
                        name: templateName,
                        language: { code: templateLangCode },
                        components: [{ type: 'body', parameters: templateParameters }]
                    },
                    internalMessageId: `client-handoff-notif-${handoffId}-${agentHumanPhoneNumber}`
                };

                try {
                    await this.whatsAppHandler.sendMessage(messagePayload, agentAIConfigEntity.userId);
                    this.logger.info(`Notificación de handoff (plantilla CLIENTE) ${handoffId} enviada a ${agentHumanPhoneNumber}.`);
                    successCount++;
                } catch (waError) {
                    this.logger.error(`Error enviando notificación de handoff (plantilla CLIENTE) a ${agentHumanPhoneNumber}:`, waError);
                }
            }

            return successCount > 0;
        } catch (error) {
            this.logger.error(`Error en sendClientTemplateNotifications:`, error);
            return false;
        }
    }

    /**
     * Envía notificaciones usando plantilla del sistema
     */
    private async sendSystemTemplateNotifications(
        notificationTargets: string[],
        agentAIConfigEntity: Agent,
        conversation: Conversation,
        newHandoff: Handoff,
        handoffId: string
    ): Promise<boolean> {
        try {
            this.logger.info(`Fallback: Usando notificación de handoff vía WhatsApp del SISTEMA para agente ${agentAIConfigEntity.id}.`);
            
            const systemNotificationTemplate = await this.getSystemWhatsAppTemplateConfig(SystemNotificationPurpose.HANDOFF_TO_HUMAN_AGENT);
            if (!systemNotificationTemplate) {
                this.logger.error("Fallback a sistema, pero no se encontró config de plantilla HANDOFF_TO_HUMAN_AGENT.");
                return false;
            }

            const {
                integrationId: systemWhatsAppIntegrationId,
                templateName: systemTemplateName,
                templateLangCode: systemTemplateLang,
                parameterMapping
            } = systemNotificationTemplate;

            const clientIdentifier = this.extractClientOriginalIdentifier(conversation);
            const clientWhatsAppLink = this.formatWhatsAppLink(clientIdentifier);
            const clientOwnerName = agentAIConfigEntity.organizationName || "N/A";
            const platformLink = this.generatePlatformLink(handoffId, conversation);
            const clientName = conversation.metadata?.whatsapp?.fromName || clientIdentifier;

            let successCount = 0;

            for (const agentHumanPhoneNumber of notificationTargets) {
                let templateParameters: { type: string, text: string }[] = [];
                const paramValues: Record<string, string> = {
                    agentAIName: agentAIConfigEntity.name,
                    clientOwnerName: clientOwnerName,
                    handoffId: handoffId,
                    clientIdentifier: clientName,
                    handoffReason: String(newHandoff.reason).substring(0, 200) + '...',
                    clientContactLink: clientWhatsAppLink,
                    platformLink: platformLink
                };

                if (parameterMapping) {
                    const sortedMappingKeys = Object.keys(parameterMapping).sort((keyA, keyB) => (parameterMapping[keyA] as any) - (parameterMapping[keyB] as any));
                    for (const key of sortedMappingKeys) {
                        templateParameters.push({ type: 'text', text: paramValues[key] || '' });
                    }
                } else {
                    templateParameters = [
                        { type: 'text', text: paramValues.agentAIName },
                        { type: 'text', text: paramValues.clientOwnerName },
                        { type: 'text', text: paramValues.handoffId },
                        { type: 'text', text: paramValues.clientIdentifier },
                        { type: 'text', text: paramValues.handoffReason },
                        { type: 'text', text: paramValues.clientContactLink },
                        { type: 'text', text: paramValues.platformLink }
                    ];
                }

                const messagePayloadSys = {
                    integrationId: systemWhatsAppIntegrationId,
                    to: agentHumanPhoneNumber,
                    type: 'template' as 'template',
                    template: {
                        name: systemTemplateName,
                        language: { code: systemTemplateLang },
                        components: [{ type: 'body', parameters: templateParameters }]
                    },
                    internalMessageId: `sys-handoff-notif-${handoffId}-${agentHumanPhoneNumber}`
                };

                try {
                    await this.whatsAppHandler.sendMessage(messagePayloadSys, agentAIConfigEntity.id);
                    this.logger.info(`Notificación de handoff (plantilla SISTEMA) ${handoffId} enviada a ${agentHumanPhoneNumber}.`);
                    successCount++;
                } catch (waErrorSys) {
                    this.logger.error(`Error enviando notificación de handoff (plantilla SISTEMA) a ${agentHumanPhoneNumber}:`, waErrorSys);
                }
            }

            return successCount > 0;
        } catch (error) {
            this.logger.error(`Error en sendSystemTemplateNotifications:`, error);
            return false;
        }
    }
}