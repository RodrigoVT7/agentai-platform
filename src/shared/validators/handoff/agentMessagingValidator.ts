// src/shared/validators/handoff/agentMessagingValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { HandoffStatus } from "../../models/handoff.model"; // Asegúrate de crear/importar
import { MessageType } from "../../models/conversation.model";

interface AgentMessageData {
    handoffId: string;
    content: string;
    messageType?: string; // Opcional, por defecto TEXT
    attachments?: any; // Podría ser más específico
}

export class AgentMessagingValidator {
    private storageService: StorageService;
    private logger: Logger;

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.logger = logger || createLogger();
    }

    async validate(data: AgentMessageData, agentUserId: string): Promise<ValidationResult> {
        const errors: string[] = [];

        if (!data.handoffId) {
            errors.push("Se requiere el ID del handoff (handoffId).");
        }
        if (!data.content || data.content.trim() === "") {
            errors.push("El contenido del mensaje no puede estar vacío.");
        } else if (data.content.length > 5000) { // Límite de ejemplo
            errors.push("El contenido del mensaje excede el límite de caracteres.");
        }

        if (data.messageType && !Object.values(MessageType).includes(data.messageType as MessageType)) {
            errors.push(`Tipo de mensaje inválido: ${data.messageType}`);
        }

        // TODO: Validar estructura de 'attachments' si se proporcionan

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
                     errors.push("No estás asignado a este handoff y no puedes enviar mensajes.");
                 }
                 break;
            }
             if (!handoffFound) {
                 errors.push(`Handoff con ID ${data.handoffId} no encontrado o inactivo.`);
             }
        } catch (error) {
            this.logger.error(`Error verificando handoff ${data.handoffId} para enviar mensaje:`, error);
            errors.push("Error al verificar el handoff.");
        }

        return {
            isValid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined
        };
    }
}