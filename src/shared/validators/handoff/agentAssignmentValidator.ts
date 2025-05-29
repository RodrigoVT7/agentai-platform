// src/shared/validators/handoff/agentAssignmentValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { HandoffStatus, AgentStatus } from "../../models/handoff.model"; // Asegúrate de crear/importar

interface AssignmentData {
    handoffId: string;
}

export class AgentAssignmentValidator {
    private storageService: StorageService;
    private logger: Logger;
    private agentStatusTable: string = STORAGE_TABLES.AGENT_STATUS;

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.logger = logger || createLogger();
    }

    async validate(data: AssignmentData, agentUserId: string): Promise<ValidationResult> {
        const errors: string[] = [];

        if (!data.handoffId) {
            errors.push("Se requiere el ID del handoff (handoffId).");
            return { isValid: false, errors }; // Salir si falta el ID
        }

        // Verificar que el handoff existe y está pendiente
        try {
            const handoffTable = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
            let handoffFound = false;
            const handoffs = handoffTable.listEntities({ queryOptions: { filter: `RowKey eq '${data.handoffId}' and isActive eq true` } });
            for await (const handoff of handoffs) {
                 handoffFound = true;
                 if (handoff.status !== HandoffStatus.PENDING) {
                     errors.push(`El handoff ${data.handoffId} no está pendiente (estado actual: ${handoff.status}).`);
                 }
                 // Verificar si el agente que intenta tomarlo pertenece al mismo grupo/skill (si aplica)
                 // if (handoff.requiredSkill && !(await agentHasSkill(agentUserId, handoff.requiredSkill))) {
                 //    errors.push("El agente no tiene la habilidad requerida para este handoff.");
                 // }
                 break; // Asumimos ID único
            }
            if (!handoffFound) {
                 errors.push(`Handoff con ID ${data.handoffId} no encontrado o inactivo.`);
            }

        } catch (error) {
            this.logger.error(`Error verificando handoff ${data.handoffId}:`, error);
            errors.push("Error al verificar el handoff.");
        }

        // Verificar que el agente humano está disponible
        try {
            const statusTable = this.storageService.getTableClient(this.agentStatusTable);
            const agentStatusEntity = await statusTable.getEntity(agentUserId, 'current'); // Asume PK=userId, RK='current'
            const agentStatus = agentStatusEntity.status as AgentStatus;
            // Definir qué estados permiten tomar una conversación
            const availableStatuses = [AgentStatus.ONLINE, AgentStatus.AVAILABLE];
            if (!availableStatuses.includes(agentStatus)) {
                 errors.push(`No puedes tomar la conversación porque tu estado es ${agentStatus}. Cambia tu estado a ${availableStatuses.join(' o ')}.`);
            }
        } catch (error: any) {
            if (error.statusCode === 404) {
                errors.push(`No se encontró tu estado actual. Por favor, actualiza tu estado a disponible.`);
            } else {
                this.logger.error(`Error verificando estado del agente ${agentUserId}:`, error);
                errors.push("Error al verificar tu estado de disponibilidad.");
            }
        }

        return {
            isValid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined
        };
    }

    // async agentHasSkill(agentUserId: string, skill: string): Promise<boolean> {
    //    // Implementar lógica para verificar skills del agente si es necesario
    //    return true;
    // }
}