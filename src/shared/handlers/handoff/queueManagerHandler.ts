// src/shared/handlers/handoff/queueManagerHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Handoff, HandoffStatus } from "../../models/handoff.model"; // Asegúrate de crear este archivo/interfaz

interface QueueListOptions {
    agentId?: string; // Para filtrar por agente específico (si un admin quiere ver colas)
    status?: string;  // Filtrar por estado (ej. 'pending')
    limit: number;
    skip: number;
}

export class QueueManagerHandler {
    private storageService: StorageService;
    private logger: Logger;

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.logger = logger || createLogger();
    }

    async execute(options: QueueListOptions, requestingUserId: string): Promise<any> {
        const { agentId, status, limit, skip } = options;

        try {
            // Aquí podrías verificar si requestingUserId tiene permiso para ver la cola
            // (ej. si es admin o si agentId coincide con su propio agentId si fuera un sistema multi-agente)

            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);

            // Construir filtro
            let filterParts: string[] = [];
            if (agentId) {
                filterParts.push(`PartitionKey eq '${agentId}'`); // Asumiendo PK es agentId
            }
            // Por defecto, mostrar solo los pendientes si no se especifica estado
            filterParts.push(`status eq '${status || HandoffStatus.PENDING}'`);
            filterParts.push(`isActive eq true`); // Solo mostrar handoffs activos

            const filter = filterParts.join(' and ');
            this.logger.debug(`Consultando cola de handoff con filtro: ${filter}`);

            const handoffs: Handoff[] = [];
            const entities = tableClient.listEntities({
                queryOptions: { filter }
            });

            const allHandoffs: Handoff[] = [];
            for await (const entity of entities) {
                allHandoffs.push(entity as unknown as Handoff);
            }

            // Ordenar por fecha de creación (más antiguo primero para FIFO)
            allHandoffs.sort((a, b) => a.createdAt - b.createdAt);

            // Aplicar paginación
            const paginatedHandoffs = allHandoffs.slice(skip, skip + limit);

            // (Opcional) Enriquecer con datos de conversación o usuario
            // const enrichedHandoffs = await this.enrichHandoffs(paginatedHandoffs);

            return {
                handoffs: paginatedHandoffs, // O enrichedHandoffs
                totalPending: allHandoffs.length, // Total que coincide con el filtro (antes de paginar)
                pagination: {
                    limit,
                    skip,
                    total: allHandoffs.length
                }
            };

        } catch (error: unknown) {
            this.logger.error("Error al obtener la cola de handoff:", error);
            if (error && typeof error === 'object' && 'statusCode' in error) {
                throw error;
            }
            throw createAppError(500, 'Error al obtener la cola de handoff');
        }
    }

    // private async enrichHandoffs(handoffs: Handoff[]): Promise<any[]> {
    //   // Implementa lógica para buscar datos adicionales si es necesario
    //   return handoffs;
    // }
}