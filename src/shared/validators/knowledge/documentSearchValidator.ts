// src/shared/validators/knowledge/documentSearchValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { SearchQuery } from "../../models/search.model";

export class DocumentSearchValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  /**
   * Valida los parámetros de búsqueda
   */
  public validate(params: SearchQuery): ValidationResult {
    const errors: string[] = [];
    
    // Validar query
    if (!params.query || typeof params.query !== 'string' || params.query.trim() === '') {
      errors.push("La consulta de búsqueda es obligatoria");
    } else if (params.query.length < 2) {
      errors.push("La consulta de búsqueda debe tener al menos 2 caracteres");
    } else if (params.query.length > 1000) {
      errors.push("La consulta de búsqueda no puede exceder los 1000 caracteres");
    }
    
    // Validar knowledgeBaseId
    if (!params.knowledgeBaseId || typeof params.knowledgeBaseId !== 'string') {
      errors.push("El ID de la base de conocimiento es obligatorio");
    }
    
    // Validar agentId
    if (!params.agentId || typeof params.agentId !== 'string') {
      errors.push("El ID del agente es obligatorio");
    }
    
    // Validar parámetros opcionales
    if (params.limit !== undefined) {
      if (typeof params.limit !== 'number' || params.limit < 1) {
        errors.push("El límite debe ser un número mayor o igual a 1");
      } else if (params.limit > 100) {
        errors.push("El límite no puede exceder 100 resultados");
      }
    }
    
    if (params.threshold !== undefined) {
      if (typeof params.threshold !== 'number') {
        errors.push("El umbral de similitud debe ser un número");
      } else if (params.threshold < 0 || params.threshold > 1) {
        errors.push("El umbral de similitud debe estar entre 0 y 1");
      }
    }
    
    if (params.includeContent !== undefined && typeof params.includeContent !== 'boolean') {
      errors.push("includeContent debe ser un valor booleano");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  /**
   * Valida si el usuario tiene acceso al agente
   */
  public async validateAgentAccess(userId: string, agentId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      // Buscar el agente
      let hasAccess = false;
      const agents = await tableClient.listEntities({
        queryOptions: { filter: `userId eq '${userId}' and id eq '${agentId}'` }
      });
      
      for await (const agent of agents) {
        if (agent.id === agentId && agent.userId === userId) {
          hasAccess = true;
          break;
        }
      }
      
      // Si no se encuentra directamente, buscar en roles de agente
      if (!hasAccess) {
        const rolesClient = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
        const roles = await rolesClient.listEntities({
          queryOptions: { filter: `userId eq '${userId}' and agentId eq '${agentId}'` }
        });
        
        for await (const role of roles) {
          if (role.isActive) {
            hasAccess = true;
            break;
          }
        }
      }
      
      return hasAccess;
    } catch (error) {
      this.logger.error(`Error al validar acceso del usuario ${userId} al agente ${agentId}:`, error);
      return false;
    }
  }
  
  /**
   * Valida si la base de conocimiento existe y pertenece al agente
   */
  public async validateKnowledgeBase(agentId: string, knowledgeBaseId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      const knowledgeBases = await tableClient.listEntities({
        queryOptions: { filter: `agentId eq '${agentId}' and id eq '${knowledgeBaseId}'` }
      });
      
      for await (const kb of knowledgeBases) {
        if (kb.id === knowledgeBaseId && kb.agentId === agentId) {
          return true;
        }
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Error al validar base de conocimiento ${knowledgeBaseId} del agente ${agentId}:`, error);
      return false;
    }
  }
}