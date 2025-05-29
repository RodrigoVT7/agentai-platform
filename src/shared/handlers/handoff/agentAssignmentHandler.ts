// src/shared/handlers/handoff/agentAssignmentHandler.ts
import { StorageService } from "../../services/storage.service";
import { NotificationService } from "../../services/notification.service"; // Opcional
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Conversation, ConversationStatus } from "../../models/conversation.model";
import { Handoff, HandoffStatus } from "../../models/handoff.model"; // Asegúrate de crear este archivo/interfaz
import { AgentStatus } from "../../models/handoff.model"; // Necesitarás definir AgentStatus

export class AgentAssignmentHandler {
    private storageService: StorageService;
    private notificationService: NotificationService; // Opcional
    private logger: Logger;

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.notificationService = new NotificationService(); // Opcional
        this.logger = logger || createLogger();
    }

    async execute(handoffId: string, agentUserId: string): Promise<any> {
        const handoffTable = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
        const agentStatusTable = this.storageService.getTableClient(STORAGE_TABLES.AGENT_STATUS); // Necesitas crear esta tabla
        const conversationTable = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);

        try {
            // 1. Obtener el registro de handoff
            let handoff: Handoff | null = null;
            const handoffs = handoffTable.listEntities({ queryOptions: { filter: `RowKey eq '${handoffId}' and isActive eq true` } });
            for await (const entity of handoffs) {
                handoff = entity as unknown as Handoff;
                break;
            }

            if (!handoff) {
                throw createAppError(404, "Solicitud de handoff no encontrada.");
            }

            if (handoff.status !== HandoffStatus.PENDING) {
                throw createAppError(409, `El handoff ya está en estado ${handoff.status}.`);
            }

            // 2. Verificar estado del agente humano que va a tomar la conversación
            try {
                const agentStatusEntity = await agentStatusTable.getEntity(agentUserId, 'current'); // Asume PK=userId, RK='current'
                const agentStatus = agentStatusEntity.status as AgentStatus;
                if (agentStatus !== AgentStatus.ONLINE && agentStatus !== AgentStatus.AVAILABLE) { // Ajusta los estados según tu modelo
                     throw createAppError(400, `El agente ${agentUserId} no está disponible (estado: ${agentStatus}).`);
                }
            } catch (error: any) {
                if (error.statusCode === 404) {
                     throw createAppError(404, `Estado no encontrado para el agente ${agentUserId}. Debe establecer su estado primero.`);
                }
                 this.logger.error(`Error al verificar estado del agente ${agentUserId}:`, error);
                 throw createAppError(500, "Error al verificar la disponibilidad del agente.");
            }


            // 3. Actualizar el handoff: asignar agente y cambiar estado a ACTIVE
            const now = Date.now();
            await handoffTable.updateEntity({
                partitionKey: handoff.agentId, // PK original
                rowKey: handoffId,
                assignedAgentId: agentUserId,
                status: HandoffStatus.ACTIVE,
                assignedAt: now,
                updatedAt: now
            }, "Merge");

            // 4. (Opcional) Actualizar estado del agente a 'BUSY' u 'ON_CONVERSATION'
            await agentStatusTable.updateEntity({
                partitionKey: agentUserId,
                rowKey: 'current',
                status: AgentStatus.BUSY, // O el estado que uses
                lastStatusChange: now,
                currentHandoffId: handoffId // Guardar el handoff actual
            }, "Merge");

            // 5. (Opcional) Notificar al usuario final que un agente se ha unido
            // CORRECCIÓN: Comentar la línea si la función no existe en NotificationService
            // const conversation = await conversationTable.getEntity(handoff.agentId, handoff.conversationId) as unknown as Conversation;
            // if (conversation) {
            //     await this.notificationService.notifyHandoffAssignment(conversation.userId, agentUserId, handoffId); // Implementar
            // }


            this.logger.info(`Agente ${agentUserId} asignado al handoff ${handoffId}`);

            return {
                handoffId,
                assignedAgentId: agentUserId,
                status: HandoffStatus.ACTIVE,
                message: "Agente asignado con éxito."
            };

        } catch (error: unknown) {
            this.logger.error(`Error al asignar agente ${agentUserId} al handoff ${handoffId}:`, error);
            if (error && typeof error === 'object' && 'statusCode' in error) {
                throw error;
            }
            throw createAppError(500, 'Error al asignar agente');
        }
    }
}