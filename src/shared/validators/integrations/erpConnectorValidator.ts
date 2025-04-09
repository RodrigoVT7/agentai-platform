// src/shared/validators/integrations/erpConnectorValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";

export class ERPConnectorValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async validate(data: any): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar campos requeridos
    if (!data.agentId) {
      errors.push("ID del agente es requerido");
    }
    
    if (!data.type) {
      errors.push("Tipo de ERP es requerido");
    }
    
    if (!data.url) {
      errors.push("URL del ERP es requerido");
    }
    
    // Validar credenciales (debe tener al menos una forma de autenticación)
    if (!data.apiKey && (!data.username || !data.password)) {
      errors.push("Se requiere API Key o credenciales (usuario/contraseña)");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  async validateIntegration(data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar campos básicos
    if (!data.agentId) {
      errors.push("ID del agente es requerido");
    }
    
    if (!data.name) {
      errors.push("Nombre de la integración es requerido");
    }
    
    // Validar campos específicos de ERP
    if (!data.url) {
      errors.push("URL del ERP es requerido");
    }
    
    // Validar credenciales
    if (!data.apiKey && (!data.username || !data.password)) {
      errors.push("Se requiere API Key o credenciales (usuario/contraseña)");
    }
    
    // Verificar acceso al agente si no hay errores en validación básica
    if (errors.length === 0 && data.agentId) {
      const hasAccess = await this.verifyAgentAccess(data.agentId, userId);
      if (!hasAccess) {
        errors.push("No tienes permiso para acceder a este agente");
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  async validateEntityData(integrationId: string, entity: string, data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    
    if (!data) {
      errors.push("Los datos de la entidad son requeridos");
    }
    
    // Aquí se podría implementar validación específica según el esquema de la entidad
    // Para simplificar, solo verificamos que el objeto de datos no esté vacío
    if (data && Object.keys(data).length === 0) {
      errors.push("Los datos de la entidad no pueden estar vacíos");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  async validateQuery(queryData: any): Promise<ValidationResult> {
    const errors: string[] = [];
    
    if (!queryData) {
      errors.push("Los datos de consulta son requeridos");
    }
    
    if (!queryData.query && !queryData.sql) {
      errors.push("Se requiere una consulta (query o sql)");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  async validateUpdate(updateData: any): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar que hay al menos un campo para actualizar
    if (!updateData || Object.keys(updateData).length === 0) {
      errors.push("No hay datos para actualizar");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
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