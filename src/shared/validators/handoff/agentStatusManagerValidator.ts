// src/shared/validators/handoff/agentStatusManagerValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { Logger, createLogger } from "../../utils/logger";
import { AgentStatus, AgentStatusUpdateRequest } from "../../models/handoff.model"; // Asegúrate de crear/importar

export class AgentStatusManagerValidator {
    private logger: Logger;

    constructor(logger?: Logger) {
        this.logger = logger || createLogger();
    }

    validate(data: AgentStatusUpdateRequest): ValidationResult {
        const errors: string[] = [];

        if (!data.status) {
            errors.push("Se requiere el nuevo estado (status).");
        } else if (!Object.values(AgentStatus).includes(data.status)) {
            // Asegura que el estado proporcionado es uno de los definidos en el enum
            errors.push(`Estado inválido: ${data.status}. Valores permitidos: ${Object.values(AgentStatus).join(', ')}`);
        }

        if (data.message && data.message.length > 200) {
            errors.push("El mensaje de estado no puede exceder los 200 caracteres.");
        }

        return {
            isValid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined
        };
    }
}