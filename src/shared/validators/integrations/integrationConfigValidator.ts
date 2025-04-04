// src/shared/validators/integrations/integrationConfigValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { IntegrationType } from "../../models/integration.model";

export class IntegrationConfigValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async validateCreate(data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar campos requeridos
    if (!data.agentId) {
      errors.push("ID del agente es requerido");
    }
    
    if (!data.name) {
      errors.push("Nombre de la integración es requerido");
    } else if (data.name.length < 3) {
      errors.push("El nombre debe tener al menos 3 caracteres");
    } else if (data.name.length > 50) {
      errors.push("El nombre no puede exceder los 50 caracteres");
    }
    
    if (!data.type) {
      errors.push("Tipo de integración es requerido");
    } else {
      const validTypes = Object.values(IntegrationType);
      if (!validTypes.includes(data.type)) {
        errors.push(`Tipo no válido. Valores permitidos: ${validTypes.join(', ')}`);
      }
    }
    
    if (!data.provider) {
      errors.push("Proveedor de la integración es requerido");
    }
    
    // Verificar acceso al agente si no hay errores
    if (errors.length === 0 && data.agentId) {
      const hasAccess = await this.verifyAgentAccess(data.agentId, userId);
      if (!hasAccess) {
        errors.push("No tienes permiso para configurar este agente");
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  async validateUpdate(integrationId: string, data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar que la integración existe
    const integration = await this.getIntegration(integrationId);
    
    if (!integration) {
      errors.push("Integración no encontrada");
      return { isValid: false, errors };
    }
    
    // Verificar acceso al agente
    const hasAccess = await this.verifyAgentAccess(integration.agentId, userId);
    if (!hasAccess) {
      errors.push("No tienes permiso para modificar esta integración");
      return { isValid: false, errors };
    }
    
    // Validar campos si se proporcionan
    if (data.name !== undefined) {
      if (!data.name) {
        errors.push("Nombre de la integración no puede estar vacío");
      } else if (data.name.length < 3) {
        errors.push("El nombre debe tener al menos 3 caracteres");
      } else if (data.name.length > 50) {
        errors.push("El nombre no puede exceder los 50 caracteres");
      }
    }
    
    // No permitir cambiar el tipo o proveedor
    if (data.type !== undefined && data.type !== integration.type) {
      errors.push("No se puede cambiar el tipo de integración");
    }
    
    if (data.provider !== undefined && data.provider !== integration.provider) {
      errors.push("No se puede cambiar el proveedor de integración");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  private async getIntegration(integrationId: string): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      // Buscar en todas las particiones
      const integrations = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${integrationId}'` }
      });
      
      for await (const integration of integrations) {
        return integration;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Error al obtener integración ${integrationId}:`, error);
      return null;
    }
  }
  
  private async verifyAgentAccess(agentId: string, userId: string): Promise<boolean> {
    try {
      // Verificar si el usuario es propietario del agente
      const agentsTable = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      try {
        const agent = await agentsTable.getEntity('agent', agentId);
        
        if (agent.userId === userId) {
          return true;
        }
      } catch (error) {
        return false;
      }
      
      // Verificar si el usuario tiene algún rol en el agente
      const rolesTable = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      const roles = rolesTable.listEntities({
        queryOptions: { filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true` }
      });
      
      for await (const role of roles) {
        return true;
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Error al verificar acceso al agente ${agentId}:`, error);
      return false;
    }
  }
}