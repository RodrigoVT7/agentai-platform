// src/shared/validators/handoff/handoffInitiatorValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { HandoffInitiateRequest, HandoffStatus } from "../../models/handoff.model"; // Asegúrate de crear/importar
import { ConversationStatus } from "../../models/conversation.model";

export class HandoffInitiatorValidator {
    private storageService: StorageService;
    private logger: Logger;

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.logger = logger || createLogger();
    }

    async validate(data: HandoffInitiateRequest, requestorId: string): Promise<ValidationResult> {
        const errors: string[] = [];

        if (!data.conversationId) {
            errors.push("Se requiere el ID de la conversación (conversationId).");
        }
        if (!data.agentId) {
            errors.push("Se requiere el ID del agente (agentId).");
        }
        if (data.reason && data.reason.length > 500) {
            errors.push("La razón del handoff no puede exceder los 500 caracteres.");
        }

        // Si faltan IDs, no podemos continuar con las verificaciones de DB
        if (errors.length > 0) {
            return { isValid: false, errors };
        }

        // Verificar que la conversación existe, pertenece al agente y está activa
        try {
            const conversationTable = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
            const conversation = await conversationTable.getEntity(data.agentId, data.conversationId);

            if (conversation.status !== ConversationStatus.ACTIVE) {
                 errors.push("La conversación no está activa y no puede ser transferida.");
            }
            // Aquí podrías añadir una verificación de si el requestorId tiene permiso
            // para iniciar un handoff en esta conversación/agente si es necesario.

        } catch (error: any) {
            if (error.statusCode === 404) {
                errors.push(`La conversación ${data.conversationId} no fue encontrada para el agente ${data.agentId}.`);
            } else {
                this.logger.error(`Error verificando conversación ${data.conversationId}:`, error);
                errors.push("Error al verificar la conversación.");
            }
        }

         // Verificar si ya existe un handoff pendiente o activo
         try {
             const handoffTable = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
             const filter = `conversationId eq '${data.conversationId}' and (status eq '${HandoffStatus.PENDING}' or status eq '${HandoffStatus.ACTIVE}') and isActive eq true`;
             const existingHandoffs = handoffTable.listEntities({ queryOptions: { filter } });
             for await (const existing of existingHandoffs) {
                  errors.push("Ya existe un handoff pendiente o activo para esta conversación.");
                  break; // Solo necesitamos encontrar uno
             }
         } catch (error) {
              this.logger.error(`Error verificando handoffs existentes para conv ${data.conversationId}:`, error);
              errors.push("Error al verificar handoffs existentes.");
         }


        return {
            isValid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined
        };
    }
}