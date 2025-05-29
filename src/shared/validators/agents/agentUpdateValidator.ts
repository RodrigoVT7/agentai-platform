// src/shared/validators/agents/agentUpdateValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { AgentHandoffConfig, HandoffMethod } from "../../models/agent.model";

export class AgentUpdateValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async validate(agentId: string, userId: string, data: Record<string, any>): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Verificar si el agente existe y pertenece al usuario
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      const agent = await tableClient.getEntity('agent', agentId);
      
      if (agent.userId !== userId) {
        errors.push("No tienes permiso para modificar este agente");
      }
    } catch (error: any) {
      errors.push("Agente no encontrado");
      return { isValid: false, errors };
    }
    
    // Validar nombre (si se proporciona)
    if (data.name !== undefined) {
      if (!data.name) {
        errors.push("Nombre del agente requerido");
      } else if (data.name.length < 3) {
        errors.push("El nombre debe tener al menos 3 caracteres");
      } else if (data.name.length > 50) {
        errors.push("El nombre no puede exceder los 50 caracteres");
      }
    }
    
    // Validar description (opcional)
    if (data.description !== undefined && data.description.length > 500) {
      errors.push("La descripción no puede exceder los 500 caracteres");
    }
    
    // Validar modelType
    if (data.modelType !== undefined) {
      const validModels = ['gpt-4o', 'gpt-4', 'o4-mini'];
      if (!validModels.includes(data.modelType)) {
        errors.push(`Tipo de modelo no válido. Valores permitidos: ${validModels.join(', ')}`);
      }
    }
    
    // Validar temperature
    if (data.temperature !== undefined) {
      if (typeof data.temperature !== 'number' || data.temperature < 0 || data.temperature > 1) {
        errors.push("La temperatura debe ser un número entre 0 y 1");
      }
    }
    
    // Validar systemInstructions (opcional)
    if (data.systemInstructions !== undefined && data.systemInstructions.length > 4000) {
      errors.push("Las instrucciones del sistema no pueden exceder los 4000 caracteres");
    }

    if (data.handoffConfig !== undefined) {
      if (typeof data.handoffConfig !== 'object' || data.handoffConfig === null) {
        errors.push("handoffConfig debe ser un objeto.");
      } else {
        const config = data.handoffConfig as AgentHandoffConfig;
        if (!config.type || !Object.values(HandoffMethod).includes(config.type)) {
          errors.push(`handoffConfig.type inválido. Valores permitidos: ${Object.values(HandoffMethod).join(', ')}`);
        }
        if (config.type === HandoffMethod.WHATSAPP || config.type === HandoffMethod.BOTH) {
          if (!config.notificationTargets || !Array.isArray(config.notificationTargets) || config.notificationTargets.length === 0) {
            errors.push("handoffConfig.notificationTargets es requerido y debe ser un array de números para el método WhatsApp.");
          } else {
            for (const num of config.notificationTargets) {
              if (typeof num !== 'string' || !/^\+?[1-9]\d{1,14}$/.test(num)) {
                errors.push(`Número de WhatsApp inválido en notificationTargets: ${num}`);
              }
            }
          }
        }
      }
    }

    if (data.organizationName !== undefined && (typeof data.organizationName !== 'string' || data.organizationName.trim().length === 0 || data.organizationName.length > 100)) {
        errors.push("El nombre de la organización debe ser un string entre 1 y 100 caracteres.");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}