// src/shared/validators/handoff/handoffCompletionValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { HandoffStatus, HandoffCompleteRequest } from "../../models/handoff.model"; // Asegúrate de crear/importar

export class HandoffCompletionValidator {
    private storageService: StorageService;
    private logger: Logger;

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.logger = logger || createLogger();
    }

    async validate(data: HandoffCompleteRequest, agentUserId: string): Promise<ValidationResult> {
        const errors: string[] = [];

        if (!data.handoffId) {
            errors.push("Se requiere el ID del handoff (handoffId).");
        }
        if (data.summary && data.summary.length > 1000) {
            errors.push("El resumen no puede exceder los 1000 caracteres.");
        }
        if (data.resolution && data.resolution.length > 1000) {
            errors.push("La resolución no puede exceder los 1000 caracteres.");
        }
         if (data.returnToBot !== undefined && typeof data.returnToBot !== 'boolean') {
             errors.push("El campo 'returnToBot' debe ser booleano.");
         }


        if (errors.length > 0) {
            return { isValid: false, errors };
        }

        // Verificar que el handoff existe, está activo y asignado a este agente
        try {
            const handoffTable = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
            let handoffFound = false;
            const handoffs = handoffTable.listEntities({ queryOptions: { filter: `RowKey eq '${data.handoffId}' and isActive eq true` } });
            for await (const handoff of handoffs) {
                 handoffFound = true;
                 if (handoff.status !== HandoffStatus.ACTIVE) {
                     errors.push(`El handoff ${data.handoffId} no está activo (estado actual: ${handoff.status}).`);
                 }
                 if (handoff.assignedAgentId !== agentUserId) {
                     errors.push("No puedes completar un handoff que no está asignado a ti.");
                 }
                 break;
            }
            if (!handoffFound) {
                 errors.push(`Handoff con ID ${data.handoffId} no encontrado o inactivo.`);
            }
        } catch (error) {
            this.logger.error(`Error verificando handoff ${data.handoffId} para completar:`, error);
            errors.push("Error al verificar el handoff.");
        }

        return {
            isValid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined
        };
    }
}