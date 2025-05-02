// src/shared/handlers/conversation/messageSenderHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Conversation, Message } from "../../models/conversation.model";
import { WhatsAppIntegrationHandler } from "../integrations/whatsAppIntegrationHandler"; // Importar handler específico
import {Integration, IntegrationStatus } from "../../models/integration.model";

interface SendMessageQueuePayload {
    conversationId: string;
    messageToSendId: string; // ID del mensaje del *asistente*
    agentId: string;
    recipientId: string; // ID del usuario final (ej. whatsapp:123)
}

export class MessageSenderHandler {
    private storageService: StorageService;
    private logger: Logger;
    // Instanciar handlers de integración aquí
    private whatsAppHandler: WhatsAppIntegrationHandler;

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.logger = logger || createLogger();
        this.whatsAppHandler = new WhatsAppIntegrationHandler(this.logger);
    }

    async execute(payload: SendMessageQueuePayload): Promise<void> {
        const { conversationId, messageToSendId, agentId, recipientId } = payload;
        this.logger.info(`Procesando solicitud de envío para mensaje ${messageToSendId} en conversación ${conversationId}`);

        try {
            // 1. Obtener la conversación para saber el canal y otros detalles
            const conversation = await this.getConversation(conversationId, agentId);
            if (!conversation) {
                throw createAppError(404, `Conversación ${conversationId} no encontrada para agente ${agentId}`);
            }
            const sourceChannel = conversation.sourceChannel;

            // 2. Obtener el mensaje del asistente que se debe enviar
            const messageToSend = await this.getMessage(conversationId, messageToSendId);
            if (!messageToSend) {
                throw createAppError(404, `Mensaje ${messageToSendId} no encontrado en conversación ${conversationId}`);
            }

            // 3. Obtener la integración activa para este canal y agente
            const integration = await this.getActiveIntegration(agentId, sourceChannel);
            if (!integration) {
                this.logger.warn(`No se encontró integración activa para canal ${sourceChannel} y agente ${agentId}. No se puede enviar mensaje.`);
                // Podrías marcar el mensaje como fallido aquí
                return;
            }

            // 4. Determinar el destinatario real (ej. número de teléfono para WhatsApp)
            // Esta información podría estar en conversation.metadata o recipientId
            let recipientAddress: string | undefined;
            if (sourceChannel === 'whatsapp') {
                 // Extraer número de teléfono del recipientId (ej. "whatsapp:521...")
                 if (recipientId.startsWith('whatsapp:')) {
                     recipientAddress = recipientId.substring(9);
                 } else {
                      // O buscar en metadata si lo guardaste diferente
                      recipientAddress = conversation.metadata?.whatsapp?.from;
                 }
            } else {
                // Lógica para otros canales...
            }

            if (!recipientAddress) {
                throw createAppError(400, `No se pudo determinar la dirección del destinatario para ${recipientId} en canal ${sourceChannel}`);
            }


            // 5. Llamar al handler de integración correspondiente
            this.logger.info(`Enviando mensaje ${messageToSendId} a ${recipientAddress} via ${sourceChannel} (Integración: ${integration.id})`);

            let sendResult: any; // Usar 'any' o definir un tipo común de respuesta de envío

            switch (sourceChannel) {
                case 'whatsapp':
                    // Preparar datos para sendMessage de WhatsAppIntegrationHandler
                    const messageData: WhatsAppMessageData = {
                        integrationId: integration.id,
                        to: recipientAddress,
                        type: 'text', // Asumir texto por ahora, adaptar según messageToSend.messageType
                        text: { body: messageToSend.content },
                        internalMessageId: messageToSendId // Pasar ID interno opcionalmente
                        // Añadir lógica para otros tipos (template, image, etc.) basada en messageToSend
                    };
                     // Llama al sendMessage del handler específico
                     const response = await this.whatsAppHandler.sendMessage(messageData, conversation.userId || agentId); // Pasamos el userId de la conversación o el agentId como solicitante

                     // Analizar la respuesta para determinar el éxito
                    if (response.status === 200 && response.jsonBody && (response.jsonBody as any).success) {
                         sendResult = { success: true, response: response.jsonBody };
                         // Podrías actualizar el estado del mensaje a 'DELIVERED' o esperar webhook de estado
                    } else {
                         sendResult = { success: false, response: response.jsonBody || { error: `Status ${response.status}` } };
                         // Marcar el mensaje como FAILED
                         // await this.updateMessageStatus(conversationId, messageToSendId, MessageStatus.FAILED, JSON.stringify(sendResult.response));
                     }
                    break;
                // case 'telegram':
                // case 'web':
                // etc.
                default:
                    this.logger.warn(`Canal de envío no soportado: ${sourceChannel}`);
                    // Marcar mensaje como fallido
                    // await this.updateMessageStatus(conversationId, messageToSendId, MessageStatus.FAILED, `Canal no soportado: ${sourceChannel}`);
                    return;
            }

            if (sendResult.success) {
                 this.logger.info(`Mensaje ${messageToSendId} enviado exitosamente a ${recipientAddress}. Respuesta API: ${JSON.stringify(sendResult.response)}`);
            } else {
                 this.logger.error(`Fallo al enviar mensaje ${messageToSendId} a ${recipientAddress}. Respuesta API: ${JSON.stringify(sendResult.response)}`);
            }


        } catch (error) {
            this.logger.error(`Error en MessageSenderHandler para mensaje ${messageToSendId}:`, error);
            // Considera marcar el mensaje como FAILED aquí
            // await this.updateMessageStatus(conversationId, messageToSendId, MessageStatus.FAILED, `Error en MessageSender: ${error.message}`);
            // No relanzar para evitar que el mensaje vuelva a la cola indefinidamente si es un error persistente
        }
    }

    // --- Métodos auxiliares para obtener datos ---

    private async getConversation(conversationId: string, agentId: string): Promise<Conversation | null> {
        try {
            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
            const entity = await tableClient.getEntity(agentId, conversationId); // Asumiendo agentId es PartitionKey
            // Parse metadata si es string
            if (typeof entity.metadata === 'string') {
                try {
                    entity.metadata = JSON.parse(entity.metadata);
                } catch { entity.metadata = {}; }
            }
            return entity as unknown as Conversation;
        } catch (error: any) {
            if (error.statusCode === 404) return null;
            this.logger.error(`Error al obtener conversación ${conversationId} (Agente: ${agentId}):`, error);
            throw error; // Relanzar otros errores
        }
    }

    private async getMessage(conversationId: string, messageId: string): Promise<Message | null> {
        try {
            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
            const entity = await tableClient.getEntity(conversationId, messageId);
             // Parse metadata/attachments si son strings
             if (typeof entity.metadata === 'string') { try { entity.metadata = JSON.parse(entity.metadata); } catch { entity.metadata = {}; } }
             if (typeof entity.attachments === 'string') { try { entity.attachments = JSON.parse(entity.attachments); } catch { entity.attachments = {}; } }
            return entity as unknown as Message;
        } catch (error: any) {
            if (error.statusCode === 404) return null;
            this.logger.error(`Error al obtener mensaje ${messageId} (Conv: ${conversationId}):`, error);
            throw error;
        }
    }

    private async getActiveIntegration(agentId: string, channel: string): Promise<Integration | null> {
         try {
             const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
             const provider = channel; // Asumimos que el channel es el provider (ej. 'whatsapp')
             const filter = `PartitionKey eq '${agentId}' and provider eq '${provider}' and status eq '${IntegrationStatus.ACTIVE}' and isActive eq true`;
             const integrations = tableClient.listEntities({ queryOptions: { filter } });

             for await (const integration of integrations) {
                 return integration as unknown as Integration; // Devolver la primera activa encontrada
             }
             return null;
         } catch (error) {
             this.logger.error(`Error buscando integración activa para agente ${agentId} y canal ${channel}:`, error);
             return null;
         }
     }

}