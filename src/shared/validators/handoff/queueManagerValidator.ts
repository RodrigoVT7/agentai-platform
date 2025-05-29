// src/shared/validators/handoff/queueManagerValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { Logger, createLogger } from "../../utils/logger";
import { HandoffStatus } from "../../models/handoff.model"; // Asegúrate de crear/importar

interface QueueFilters {
    agentId?: string | null;
    status?: string | null;
    limit?: number | null;
    skip?: number | null;
}

export class QueueManagerValidator {
    private logger: Logger;

    constructor(logger?: Logger) {
        this.logger = logger || createLogger();
    }

    validate(filters: QueueFilters): ValidationResult {
        const errors: string[] = [];

        // Validar 'status' si se proporciona
        if (filters.status && !Object.values(HandoffStatus).includes(filters.status as HandoffStatus)) {
            errors.push(`Estado inválido: ${filters.status}. Valores permitidos: ${Object.values(HandoffStatus).join(', ')}`);
        }

        // Validar 'limit'
        if (filters.limit !== undefined && filters.limit !== null) {
            if (typeof filters.limit !== 'number' || !Number.isInteger(filters.limit) || filters.limit < 1) {
                errors.push("El parámetro 'limit' debe ser un entero positivo.");
            } else if (filters.limit > 100) { // Poner un límite razonable
                errors.push("El parámetro 'limit' no puede ser mayor que 100.");
            }
        }

        // Validar 'skip'
        if (filters.skip !== undefined && filters.skip !== null) {
             if (typeof filters.skip !== 'number' || !Number.isInteger(filters.skip) || filters.skip < 0) {
                errors.push("El parámetro 'skip' debe ser un entero no negativo.");
            }
        }

        return {
            isValid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined
        };
    }
}