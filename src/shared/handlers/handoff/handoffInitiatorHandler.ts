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

// Interfaz para la configuración de plantilla recuperada de la BD
interface SystemWhatsAppTemplateDbConfig {
    integrationId: string;
    templateName: string;
    templateLangCode: string;
    parameterMapping?: Record<string, string>; // El mapeo de {{key}} a "1", "2", etc.
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
            const agentEntity = await agentTable.getEntity('agent', agentId); // Asumiendo 'agent' es PartitionKey
            const agentConfig = agentEntity as unknown as Agent;

            if (agentConfig.handoffConfig && typeof agentConfig.handoffConfig === 'string') {
                try {
                    agentConfig.handoffConfig = JSON.parse(agentConfig.handoffConfig);
                } catch (e) {
                    this.logger.error(`Error al parsear handoffConfig para agente ${agentId}: ${e}`);
                    // Asignar un default o manejar el error como prefieras
                    agentConfig.handoffConfig = JSON.stringify({ type: HandoffMethod.PLATFORM, notificationTargets: [] });
                }
            } else if (!agentConfig.handoffConfig) {
                 agentConfig.handoffConfig = JSON.stringify({ type: HandoffMethod.PLATFORM, notificationTargets: [] });
            }
            // Asegurarse de que organizationName exista
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
        return conversation.userId;
    }

    private formatWhatsAppLink(clientIdentifier: string): string {
        if (clientIdentifier.startsWith('whatsapp:')) {
            return `https://wa.me/${clientIdentifier.substring(9)}`;
        } else if (/^\+?[1-9]\d{1,14}$/.test(clientIdentifier)) {
            return `https://wa.me/${clientIdentifier.replace('+', '')}`;
        }
        return "N/A (Identificador de cliente no es de WhatsApp)";
    }

    async execute(data: HandoffInitiateRequest, requestorId: string): Promise<any> {
        const { conversationId, agentId, reason, initiatedBy } = data;

        let agentAIConfigEntity: Agent | null = null;
        let conversation: Conversation | null = null;
        let handoffId = uuidv4(); // Generar ID aquí para usarlo en logs si falla antes de crear entidad

        try {
            agentAIConfigEntity = await this.getAgentAIConfig(agentId);
            if (!agentAIConfigEntity) {
                throw createAppError(404, `Agente AI con ID ${agentId} no encontrado.`);
            }

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
                    this.logger.error(`Error parseando handoffConfig JSON para Agente AI ${agentId}: ${e}. handoffConfig original: "${agentAIConfigEntity.handoffConfig}"`);
                    agentHandoffSettings = { type: HandoffMethod.PLATFORM, notificationTargets: [] };
                }
            } else {
                this.logger.warn(`handoffConfig ausente o no es string para Agente AI ${agentId}. Usando default PLATFORM.`);
                agentHandoffSettings = { type: HandoffMethod.PLATFORM, notificationTargets: [] };
            }

            // Asegurar que organizationName exista
            agentAIConfigEntity.organizationName = agentAIConfigEntity.organizationName || "Organización Desconocida"; //

            if (!agentAIConfigEntity.handoffEnabled) {
                throw createAppError(400, "El handoff no está habilitado para este agente AI.");
            }

            const conversationTable = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
            try {
                const convEntity = await conversationTable.getEntity(agentId, conversationId);
                if ((convEntity.status as ConversationStatus) !== ConversationStatus.ACTIVE) { //
                    throw createAppError(400, `La conversación ${conversationId} no está activa (estado: ${convEntity.status}).`);
                }
                conversation = convEntity as unknown as Conversation;
                if (conversation.metadata && typeof conversation.metadata === 'string') {
                    try { conversation.metadata = JSON.parse(conversation.metadata); }
                    catch (e) { this.logger.warn(`Error parseando metadata de conv ${conversationId}: ${e}`); conversation.metadata = {}; }
                } else if (!conversation.metadata) {
                    conversation.metadata = {};
                }
            } catch (error: any) {
                if (error.statusCode === 404) throw createAppError(404, `Conversación ${conversationId} no encontrada para agente ${agentId}.`);
                throw error;
            }

           const handoffTable = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
            const existingHandoffs = handoffTable.listEntities({
                queryOptions: { filter: `conversationId eq '${conversationId}' and (status eq '${HandoffStatus.PENDING}' or status eq '${HandoffStatus.ACTIVE}') and isActive eq true` } //
            });
            for await (const existing of existingHandoffs) {
                throw createAppError(409, `Ya existe un handoff ${existing.status} para esta conversación (ID: ${existing.rowKey}).`);
            }
            let conversationSummary = reason || "Solicitud de asistencia de agente humano."; //
            try {
                const messagesTable = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
                const lastMessages: any[] = [];
                const messageEntities = messagesTable.listEntities({
                    queryOptions: { filter: `PartitionKey eq '${conversationId}'` }
                });
                for await (const msgEntity of messageEntities) { lastMessages.push(msgEntity); }
                lastMessages.sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
                const clientName = conversation.metadata?.whatsapp?.fromName || "Cliente";
                const recentMessagesSummary = lastMessages.slice(-3).map(m => `${m.role === MessageRole.USER ? clientName : (agentAIConfigEntity?.name || 'Bot')}: ${String(m.content).substring(0, 150)}`).join('\n'); //
                if (recentMessagesSummary) {
                    conversationSummary = `${reason ? reason + '\n\n' : ''}Últimos mensajes:\n${recentMessagesSummary}`;
                }
            } catch (summaryError) {
                this.logger.warn(`No se pudo generar resumen de últimos mensajes para handoff en conv ${conversationId}:`, summaryError);
            }

            const now = Date.now();
            const notifiedViaValues: string[] = [];
            const handoffMethodToUse = agentHandoffSettings.type || HandoffMethod.PLATFORM; //

             const newHandoff: Handoff = {
                id: handoffId,
                agentId,
                conversationId,
                userId: conversation.userId, //
                status: HandoffStatus.PENDING, //
                reason: conversationSummary,
                initiatedBy: initiatedBy || requestorId,
                createdAt: now,
                queuedAt: now,
                isActive: true,
                notificationMethod: undefined, // Se actualizará
                notifiedAgents: undefined
            };

            if (handoffMethodToUse === HandoffMethod.PLATFORM || handoffMethodToUse === HandoffMethod.BOTH) { //
            this.logger.info(`Handoff ${handoffId} marcado para notificación vía plataforma interna.`);
            notifiedViaValues.push(HandoffMethod.PLATFORM);
        }

        // NUEVA LÓGICA para usar la integración y plantilla del cliente
        if (handoffMethodToUse === HandoffMethod.WHATSAPP || handoffMethodToUse === HandoffMethod.BOTH) { //
            const { clientWhatsAppIntegrationId, clientWhatsAppTemplateName, clientWhatsAppTemplateLangCode, notificationTargets, useSystemFallback } = agentHandoffSettings;

            let clientIntegrationConfig: IntegrationWhatsAppConfig | null = null;
            let clientAccessToken: string | null = null;
            let clientPhoneNumberId: string | null = null;

            if (clientWhatsAppIntegrationId) {
                const integrationsTable = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
                try {
                    // Asumimos que PartitionKey es agentId para la tabla Integrations
                    const integrationEntity = await integrationsTable.getEntity(agentId, clientWhatsAppIntegrationId);
                    const clientIntegration = integrationEntity as unknown as Integration;

                    if (clientIntegration && clientIntegration.isActive && clientIntegration.provider === "whatsapp" && clientIntegration.status === IntegrationAppStatus.ACTIVE) { //
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

            if (clientAccessToken && clientPhoneNumberId && clientWhatsAppTemplateName && clientWhatsAppTemplateLangCode && notificationTargets && notificationTargets.length > 0) {
                // Usar la integración y plantilla del cliente
                this.logger.info(`Intentando notificación de handoff vía WhatsApp del CLIENTE: Template '${clientWhatsAppTemplateName}', Lang '${clientWhatsAppTemplateLangCode}'.`);
                const clientIdentifier = this.extractClientOriginalIdentifier(conversation); //
                const clientWhatsAppLink = this.formatWhatsAppLink(clientIdentifier); //
                const clientOwnerName = agentAIConfigEntity.organizationName || "N/A"; //
                // El platformLink sería a tu plataforma donde el agente humano puede tomar la conversación.
                const platformLink = `${process.env.HANDOFF_PLATFORM_URL_BASE}/manage/handoff/${handoffId}`;


                for (const agentHumanPhoneNumber of notificationTargets) {
                    const templateParameters = [ // Ajusta estos parámetros según tu plantilla específica
                        { type: 'text', text: agentAIConfigEntity.name },        // {{1}} Nombre del Agente AI
                        { type: 'text', text: clientOwnerName },                 // {{2}} Nombre de la Organización del Cliente
                        { type: 'text', text: handoffId },                       // {{3}} ID del Handoff
                        { type: 'text', text: clientIdentifier },                // {{4}} Identificador del Usuario Final
                        { type: 'text', text: String(newHandoff.reason).substring(0, 200) + '...' }, // {{5}} Razón del Handoff (acortada)
                        { type: 'text', text: clientWhatsAppLink },              // {{6}} Link al chat del Usuario Final
                        { type: 'text', text: platformLink}                      // {{7}} Link a la plataforma de Handoff
                    ];

                    const messagePayload = {
                        integrationId: clientWhatsAppIntegrationId!, // Sabemos que está definido aquí
                        to: agentHumanPhoneNumber,
                        type: 'template' as 'template',
                        template: {
                            name: clientWhatsAppTemplateName,
                            language: { code: clientWhatsAppTemplateLangCode },
                            components: [{ type: 'body', parameters: templateParameters }]
                        },
                        internalMessageId: `client-handoff-notif-${handoffId}-${agentHumanPhoneNumber}`
                    };
                    try {
                        // Llamar a sendMessage usando las credenciales del CLIENTE
                        // WhatsAppIntegrationHandler.sendMessage necesita ser capaz de usar el accessToken y phoneNumberId de la config.
                        // El 'userId' pasado a sendMessage aquí sería el platformUserId (dueño del agentId) o un ID de sistema.
                        await this.whatsAppHandler.sendMessage(messagePayload, agentAIConfigEntity.userId); //
                        this.logger.info(`Notificación de handoff (plantilla CLIENTE) ${handoffId} enviada a ${agentHumanPhoneNumber}.`);
                    } catch (waError) {
                        this.logger.error(`Error enviando notificación de handoff (plantilla CLIENTE) a ${agentHumanPhoneNumber}:`, waError);
                    }
                }
                notifiedViaValues.push(`${HandoffMethod.WHATSAPP}-cliente`);
            } else if (useSystemFallback !== false && notificationTargets && notificationTargets.length > 0) {
                // Fallback a la notificación de sistema (lógica original)
                this.logger.info(`Fallback: Usando notificación de handoff vía WhatsApp del SISTEMA para agente ${agentId}.`);
                const systemNotificationTemplate = await this.getSystemWhatsAppTemplateConfig(SystemNotificationPurpose.HANDOFF_TO_HUMAN_AGENT); //
                if (systemNotificationTemplate) {
                    // ... (lógica existente para enviar con plantilla de sistema) ...
                    // (Asegúrate que esta lógica interna también funcione bien)
                    const {
                            integrationId: systemWhatsAppIntegrationId, // Este es el ID de la integración de WA de TU PLATAFORMA
                            templateName: systemTemplateName,
                            templateLangCode: systemTemplateLang,
                            parameterMapping
                        } = systemNotificationTemplate;

                    const clientIdentifier = this.extractClientOriginalIdentifier(conversation); //
                    const clientWhatsAppLink = this.formatWhatsAppLink(clientIdentifier); //
                    const clientOwnerName = agentAIConfigEntity.organizationName || "N/A"; //
                    const platformLink = `${process.env.HANDOFF_PLATFORM_URL_BASE}/manage/handoff/${handoffId}`;


                    for (const agentHumanPhoneNumber of notificationTargets) {
                        let templateParameters: { type: string, text: string }[] = [];
                        const paramValues: Record<string, string> = {
                            agentAIName: agentAIConfigEntity.name,
                            clientOwnerName: clientOwnerName,
                            handoffId: handoffId,
                            clientIdentifier: clientIdentifier,
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
                            integrationId: systemWhatsAppIntegrationId, // ID de la integración de WA de TU PLATAFORMA
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
                            await this.whatsAppHandler.sendMessage(messagePayloadSys, agentId); // El 'agentId' del bot que solicita el handoff
                            this.logger.info(`Notificación de handoff (plantilla SISTEMA) ${handoffId} enviada a ${agentHumanPhoneNumber}.`);
                        } catch (waErrorSys) {
                            this.logger.error(`Error enviando notificación de handoff (plantilla SISTEMA) a ${agentHumanPhoneNumber}:`, waErrorSys);
                        }
                    }
                    notifiedViaValues.push(`${HandoffMethod.WHATSAPP}-sistema`);
                } else {
                     this.logger.error("Fallback a sistema, pero no se encontró config de plantilla HANDOFF_TO_HUMAN_AGENT.");
                }
            } else {
                this.logger.warn(`Handoff por WhatsApp para Agente AI ${agentId} pero no hay configuración de cliente ni fallback de sistema habilitado, o no hay números de agentes humanos.`);
            }
        }

        newHandoff.notificationMethod = notifiedViaValues.length > 0 ? notifiedViaValues.join(',') : HandoffMethod.PLATFORM;
        newHandoff.notifiedAgents = (agentHandoffSettings.type === HandoffMethod.WHATSAPP || agentHandoffSettings.type === HandoffMethod.BOTH) && agentHandoffSettings.notificationTargets
            ? JSON.stringify(agentHandoffSettings.notificationTargets)
            : undefined;

        await handoffTable.createEntity({
            partitionKey: agentId,
            rowKey: handoffId,
            ...newHandoff
        });

        await conversationTable.updateEntity({
            partitionKey: agentId,
            rowKey: conversationId,
            status: ConversationStatus.TRANSFERRED, //
            updatedAt: now
        }, "Merge");

        this.logger.info(`Handoff ${handoffId} iniciado para conversación ${conversationId}. Notificado vía: ${newHandoff.notificationMethod}`);

        return {
            handoffId,
            conversationId,
            status: HandoffStatus.PENDING,
            notificationMethod: newHandoff.notificationMethod,
            message: "Solicitud de handoff registrada y notificaciones (si aplica) enviadas."
        };

        } catch (error: unknown) {
            this.logger.error(`Error al iniciar handoff para conversación ${conversationId} (Handoff ID tentativo: ${handoffId}):`, error);
            if (error && typeof error === 'object' && 'statusCode' in error) {
                throw error;
            }
            throw createAppError(500, 'Error al iniciar handoff');
        }
    }
}