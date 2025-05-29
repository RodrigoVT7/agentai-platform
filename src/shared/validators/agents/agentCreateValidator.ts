// src/shared/validators/agents/agentCreateValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { AgentHandoffConfig, HandoffMethod } from "../../models/agent.model";

export class AgentCreateValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async validate(data: any): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar userId
    if (!data.userId) {
      errors.push("ID de usuario requerido");
    }
    
    // Validar nombre
    if (!data.name) {
      errors.push("Nombre del agente requerido");
    } else if (data.name.length < 3) {
      errors.push("El nombre debe tener al menos 3 caracteres");
    } else if (data.name.length > 50) {
      errors.push("El nombre no puede exceder los 50 caracteres");
    }
    
    // Validar description (opcional)
    if (data.description && data.description.length > 500) {
      errors.push("La descripción no puede exceder los 500 caracteres");
    }
    
    // Validar modelType
    const validModels = ['gpt-4o', 'gpt-4', 'o4-mini'];
    if (data.modelType && !validModels.includes(data.modelType)) {
      errors.push(`Tipo de modelo no válido. Valores permitidos: ${validModels.join(', ')}`);
    }
    
    // Validar temperature
    if (data.temperature !== undefined) {
      if (typeof data.temperature !== 'number' || data.temperature < 0 || data.temperature > 1) {
        errors.push("La temperatura debe ser un número entre 0 y 1");
      }
    }
    
    // Validar systemInstructions (opcional)
    if (data.systemInstructions && data.systemInstructions.length > 4000) {
      errors.push("Las instrucciones del sistema no pueden exceder los 4000 caracteres");
    }
    
    // Verificar si el usuario existe
    if (data.userId && errors.length === 0) {
      const userExists = await this.checkUserExists(data.userId);
      if (!userExists) {
        errors.push("Usuario no encontrado");
      }
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
  
  private async checkUserExists(userId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      const user = await tableClient.getEntity('user', userId);
      return !!user;
    } catch (error) {
      this.logger.warn(`Error al verificar usuario ${userId}:`, error);
      return false;
    }
  }
}