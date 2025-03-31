import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";

export class KnowledgeBaseValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  /**
   * Validar datos para creación de base de conocimiento
   */
  async validateCreate(data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar que se proporciona un agentId
    if (!data.agentId) {
      errors.push("Se requiere ID del agente");
    }
    
    // Validar nombre
    if (!data.name) {
      errors.push("Se requiere nombre para la base de conocimiento");
    } else if (data.name.length < 3) {
      errors.push("El nombre debe tener al menos 3 caracteres");
    } else if (data.name.length > 100) {
      errors.push("El nombre no puede exceder los 100 caracteres");
    }
    
    // Validar descripción (opcional)
    if (data.description && data.description.length > 500) {
      errors.push("La descripción no puede exceder los 500 caracteres");
    }
    
    // Verificar acceso al agente
    if (data.agentId && errors.length === 0) {
      const hasAccess = await this.verifyAgentAccess(data.agentId, userId);
      if (!hasAccess) {
        errors.push("No tienes permiso para crear una base de conocimiento para este agente");
      }
    }
    
    // Verificar límite de bases de conocimiento para el agente
    if (data.agentId && errors.length === 0) {
      const count = await this.countKnowledgeBases(data.agentId);
      
      // Por ejemplo, limitar a 5 bases de conocimiento por agente
      const maxKBs = 5;
      if (count >= maxKBs) {
        errors.push(`No se pueden crear más de ${maxKBs} bases de conocimiento para un agente`);
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  /**
   * Validar datos para actualización de base de conocimiento
   */
  async validateUpdate(knowledgeBaseId: string, data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Verificar que la base de conocimiento existe
    const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
    
    let knowledgeBase;
    const kbs = await tableClient.listEntities({
      queryOptions: { filter: `RowKey eq '${knowledgeBaseId}'` }
    });
    
    for await (const kb of kbs) {
      knowledgeBase = kb;
      break;
    }
    
    if (!knowledgeBase) {
      errors.push("Base de conocimiento no encontrada");
      return { isValid: false, errors };
    }
    
    // Verificar acceso al agente asociado
    const agentId = knowledgeBase.agentId as string;
    const hasAccess = await this.verifyAgentAccess(agentId, userId);
    
    if (!hasAccess) {
      errors.push("No tienes permiso para modificar esta base de conocimiento");
      return { isValid: false, errors };
    }
    
    // Validar nombre si se proporciona
    if (data.name !== undefined) {
      if (!data.name) {
        errors.push("El nombre no puede estar vacío");
      } else if (data.name.length < 3) {
        errors.push("El nombre debe tener al menos 3 caracteres");
      } else if (data.name.length > 100) {
        errors.push("El nombre no puede exceder los 100 caracteres");
      }
    }
    
    // Validar descripción si se proporciona
    if (data.description !== undefined && data.description.length > 500) {
      errors.push("La descripción no puede exceder los 500 caracteres");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  /**
   * Verificar si un usuario tiene acceso a un agente
   */
  private async verifyAgentAccess(agentId: string, userId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      try {
        const agent = await tableClient.getEntity('agent', agentId);
        
        // Si el usuario es propietario, tiene acceso
        if (agent.userId === userId) {
          return true;
        }
      } catch (error) {
        this.logger.warn(`Agente ${agentId} no encontrado:`, error);
        return false;
      }
      
      // Si no es propietario, verificar si tiene algún rol
      const rolesTable = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      const roles = await rolesTable.listEntities({
        queryOptions: { filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true` }
      });
      
      for await (const role of roles) {
        return true;
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Error al verificar acceso del usuario ${userId} al agente ${agentId}:`, error);
      return false;
    }
  }
  
  /**
   * Contar bases de conocimiento de un agente
   */
  private async countKnowledgeBases(agentId: string): Promise<number> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      let count = 0;
      const kbs = await tableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${agentId}' and isActive eq true` }
      });
      
      for await (const kb of kbs) {
        count++;
      }
      
      return count;
    } catch (error) {
      this.logger.warn(`Error al contar bases de conocimiento para agente ${agentId}:`, error);
      return 0;
    }
  }
}