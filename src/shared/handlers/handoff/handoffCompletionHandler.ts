// src/shared/handlers/handoff/handoffCompletionHandler.ts
import { StorageService } from "../../services/storage.service";
import { NotificationService } from "../../services/notification.service"; // Opcional
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Conversation, ConversationStatus } from "../../models/conversation.model";
import { Handoff, HandoffStatus, HandoffCompleteRequest, AgentStatus } from "../../models/handoff.model"; // Asegúrate de crear este archivo/interfaz

export class HandoffCompletionHandler {
    private storageService: StorageService;
    private notificationService: NotificationService; // Opcional
    private logger: Logger;

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.notificationService = new NotificationService(); // Opcional
        this.logger = logger || createLogger();
    }

    async execute(data: HandoffCompleteRequest, agentUserId: string): Promise<any> {
        const { handoffId, summary, resolution, returnToBot = false } = data;

        const handoffTable = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
        const agentStatusTable = this.storageService.getTableClient(STORAGE_TABLES.AGENT_STATUS); // Necesitas crear esta tabla
        const conversationTable = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);

        try {
            // 1. Obtener el handoff y verificar que está activo y asignado a este agente
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
                throw createAppError(400, `El handoff no está activo (estado: ${handoff.status}). No se puede completar.`);
            }

            if (handoff.assignedAgentId !== agentUserId) {
                throw createAppError(403, "No estás asignado a este handoff.");
            }

            // 2. Actualizar el handoff: cambiar estado a COMPLETED
            const now = Date.now();
            await handoffTable.updateEntity({
                partitionKey: handoff.agentId, // PK original
                rowKey: handoffId,
                status: HandoffStatus.COMPLETED,
                completedBy: agentUserId,
                completedAt: now,
                summary: summary, // Guardar resumen/resolución
                resolution: resolution,
                updatedAt: now,
                isActive: false // Marcar como inactivo al completar
            }, "Merge");

            // 3. Actualizar estado de la conversación
            const newConversationStatus = returnToBot ? ConversationStatus.ACTIVE : ConversationStatus.ENDED;
            await conversationTable.updateEntity({
                partitionKey: handoff.agentId, // PK de conversación es agentId
                rowKey: handoff.conversationId,
                status: newConversationStatus,
                updatedAt: now
            }, "Merge");

            // 4. (Opcional) Actualizar estado del agente a 'ONLINE' o 'AVAILABLE'
            await agentStatusTable.updateEntity({
                partitionKey: agentUserId,
                rowKey: 'current',
                status: AgentStatus.ONLINE, // O AVAILABLE
                lastStatusChange: now,
                currentHandoffId: null // Limpiar handoff actual
            }, "Merge");

            // 5. (Opcional) Notificar al usuario final que la sesión con el agente ha terminado
            // await this.notificationService.notifyHandoffCompletion(handoff.userId, agentUserId, handoffId); // Implementar

            this.logger.info(`Handoff ${handoffId} completado por agente ${agentUserId}. Estado de conversación: ${newConversationStatus}`);

            return {
                handoffId,
                status: HandoffStatus.COMPLETED,
                conversationStatus: newConversationStatus,
                message: "Handoff completado con éxito."
            };

        } catch (error: unknown) {
            this.logger.error(`Error al completar handoff ${handoffId}:`, error);
            if (error && typeof error === 'object' && 'statusCode' in error) {
                throw error;
            }
            throw createAppError(500, 'Error al completar handoff');
        }
    }
}