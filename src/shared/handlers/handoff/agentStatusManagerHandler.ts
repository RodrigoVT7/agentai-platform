// src/shared/handlers/handoff/agentStatusManagerHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { AgentStatus } from "../../models/handoff.model"; // Necesitarás crear AgentStatus enum

export class AgentStatusManagerHandler {
    private storageService: StorageService;
    private logger: Logger;
    private agentStatusTable: string = STORAGE_TABLES.AGENT_STATUS; // Nombre de la tabla

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.logger = logger || createLogger();
        // Asegúrate de que la tabla AGENT_STATUS esté definida en tus constantes
        if (!STORAGE_TABLES.AGENT_STATUS) {
            this.logger.error("La constante STORAGE_TABLES.AGENT_STATUS no está definida.");
            // Podrías lanzar un error aquí para prevenir la ejecución
        }
    }

    /**
     * Obtiene el estado actual de un agente humano.
     * @param agentUserId ID del agente cuyo estado se quiere obtener.
     */
    async getStatus(agentUserId: string): Promise<any> {
        try {
            const tableClient = this.storageService.getTableClient(this.agentStatusTable);
            // Asumimos PartitionKey = agentUserId, RowKey = 'current' para el estado actual
            const statusEntity = await tableClient.getEntity(agentUserId, 'current');

            return {
                agentId: agentUserId,
                status: statusEntity.status,
                message: statusEntity.message,
                lastStatusChange: statusEntity.lastStatusChange,
                currentHandoffId: statusEntity.currentHandoffId // Opcional: ID del handoff actual
            };

        } catch (error: any) {
            if (error.statusCode === 404) {
                // Si no se encuentra, asumir OFFLINE o un estado predeterminado
                this.logger.warn(`No se encontró registro de estado para el agente ${agentUserId}. Asumiendo ${AgentStatus.OFFLINE}.`);
                return {
                    agentId: agentUserId,
                    status: AgentStatus.OFFLINE, // Estado predeterminado
                    message: "Estado no registrado.",
                    lastStatusChange: null
                };
            }
            this.logger.error(`Error al obtener estado del agente ${agentUserId}:`, error);
            throw createAppError(500, 'Error al obtener el estado del agente');
        }
    }

    /**
     * Actualiza el estado de un agente humano.
     * @param agentUserId ID del agente que actualiza su estado.
     * @param newStatus Nuevo estado (debe ser uno de los valores de AgentStatus enum).
     * @param message Mensaje opcional asociado al estado (ej. motivo de ausencia).
     */
    async updateStatus(agentUserId: string, newStatus: AgentStatus, message?: string): Promise<any> {
        // Validar que newStatus sea un valor válido del enum AgentStatus
        if (!Object.values(AgentStatus).includes(newStatus)) {
             throw createAppError(400, `Estado inválido: ${newStatus}. Valores permitidos: ${Object.values(AgentStatus).join(', ')}`);
        }

        try {
            const tableClient = this.storageService.getTableClient(this.agentStatusTable);
            const now = Date.now();

            const statusData: any = {
                partitionKey: agentUserId,
                rowKey: 'current', // Clave fija para el estado actual
                agentId: agentUserId, // Guardar ID explícitamente
                status: newStatus,
                message: message || null, // Limpiar mensaje si no se proporciona
                lastStatusChange: now
            };

            // Si el agente se pone offline o en pausa, limpiar el handoffId actual
            if (newStatus === AgentStatus.OFFLINE || newStatus === AgentStatus.BREAK) {
                statusData.currentHandoffId = null;
            }

            // Usar upsertEntity para crear el registro si no existe, o actualizarlo si existe
            await tableClient.upsertEntity(statusData, "Merge");

            this.logger.info(`Estado del agente ${agentUserId} actualizado a ${newStatus}`);

            // Podrías querer devolver el estado completo actualizado
            return {
                agentId: agentUserId,
                status: newStatus,
                message: message,
                lastStatusChange: now,
                updateSuccess: true
            };

        } catch (error: unknown) {
            this.logger.error(`Error al actualizar estado del agente ${agentUserId} a ${newStatus}:`, error);
            if (error && typeof error === 'object' && 'statusCode' in error) {
                throw error;
            }
            throw createAppError(500, 'Error al actualizar el estado del agente');
        }
    }
}