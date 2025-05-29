// src/shared/handlers/handoff/agentMessagingHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { NotificationService } from "../../services/notification.service"; // Opcional
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Conversation, ConversationStatus, Message, MessageRole, MessageStatus, MessageType } from "../../models/conversation.model";
import { Handoff, HandoffStatus, AgentMessageRequest } from "../../models/handoff.model"; // Asegúrate de crear este archivo/interfaz

export class AgentMessagingHandler {
    private storageService: StorageService;
    private notificationService: NotificationService; // Opcional
    private logger: Logger;

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.notificationService = new NotificationService(); // Opcional
        this.logger = logger || createLogger();
    }

    async execute(data: AgentMessageRequest, agentUserId: string): Promise<any> {
        const { handoffId, content, messageType = MessageType.TEXT, attachments } = data;

        try {
            // 1. Obtener el handoff y verificar que está activo y asignado a este agente
            const handoffTable = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
            let handoff: Handoff | null = null;
            const handoffs = handoffTable.listEntities({ queryOptions: { filter: `RowKey eq '${handoffId}' and isActive eq true` } });
            for await (const entity of handoffs) {
                handoff = entity as unknown as Handoff;
                break;
            }

            if (!handoff) {
                throw createAppError(404, "Solicitud de handoff no encontrada.");
            }

            if (handoff.status !== HandoffStatus.ACTIVE) {
                throw createAppError(400, `El handoff no está activo (estado: ${handoff.status}). No se pueden enviar mensajes.`);
            }

            if (handoff.assignedAgentId !== agentUserId) {
                throw createAppError(403, "No estás asignado a este handoff.");
            }

            // 2. Crear el mensaje en la tabla de mensajes
            const messageTable = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
            const messageId = uuidv4();
            const now = Date.now();

            const newMessage: Message = {
                id: messageId,
                conversationId: handoff.conversationId,
                content: content,
                role: MessageRole.HUMAN_AGENT, // Rol específico para agente humano
                senderId: agentUserId, // ID del agente humano
                timestamp: now,
                status: MessageStatus.SENT, // Estado inicial
                messageType: messageType,
                attachments: attachments, // Guarda los adjuntos si existen
                metadata: { handoffId: handoffId }, // Vincular al handoff
                createdAt: now
            };

            await messageTable.createEntity({
                partitionKey: handoff.conversationId,
                rowKey: messageId,
                ...newMessage,
                attachments: attachments ? JSON.stringify(attachments) : undefined,
                metadata: JSON.stringify({ handoffId: handoffId }), // Serializar metadata
            });

            // 3. Actualizar el timestamp de la conversación
            const conversationTable = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
            await conversationTable.updateEntity({
                partitionKey: handoff.agentId, // PK de la conversación es agentId
                rowKey: handoff.conversationId,
                updatedAt: now
            }, "Merge");

            // 4. (Opcional) Enviar el mensaje al usuario final a través del canal original
            // Esto requeriría lógica similar a MessageSenderHandler, determinando el canal
            // y llamando a la integración correspondiente (WhatsApp, Web Chat, etc.)
            // Ejemplo simplificado:
            // const conversation = await conversationTable.getEntity(handoff.agentId, handoff.conversationId);
            // await this.sendMessageToUser(conversation, newMessage);

            this.logger.info(`Mensaje ${messageId} enviado por agente ${agentUserId} en handoff ${handoffId}`);

            return {
                messageId,
                handoffId,
                conversationId: handoff.conversationId,
                status: MessageStatus.SENT,
                timestamp: now,
                message: "Mensaje enviado con éxito."
            };

        } catch (error: unknown) {
            this.logger.error(`Error al enviar mensaje de agente para handoff ${handoffId}:`, error);
            if (error && typeof error === 'object' && 'statusCode' in error) {
                throw error;
            }
            throw createAppError(500, 'Error al enviar mensaje');
        }
    }

    // private async sendMessageToUser(conversation: Conversation, message: Message): Promise<void> {
    //    // Implementar lógica para enviar al canal (WhatsApp, etc.)
    //    // Usar conversation.sourceChannel, conversation.userId (endUserId)
    //    // y las integraciones activas.
    // }
}