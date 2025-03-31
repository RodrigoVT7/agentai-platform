// src/shared/handlers/agents/agentDetailsHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";

export class AgentDetailsHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async execute(agentId: string, userId: string): Promise<any> {
    try {
      // Verificar si el agente existe y pertenece al usuario o si tiene acceso
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      let agent;
      try {
        agent = await tableClient.getEntity('agent', agentId);
        
        if (agent.userId !== userId) {
          // Si no es propietario, verificar si tiene algún rol
          const hasAccess = await this.verifyAgentAccess(agentId, userId);
          if (!hasAccess) {
            throw createAppError(403, 'No tienes permiso para acceder a este agente');
          }
        }
      } catch (error: any) {
        if (error.statusCode === 403) throw error;
        throw createAppError(404, 'Agente no encontrado');
      }
      
      // Obtener bases de conocimiento del agente
      const knowledgeBases = await this.getAgentKnowledgeBases(agentId);
      
      // Procesar modelConfig y operatingHours que están almacenados como strings JSON
      let modelConfig = {};
      if (typeof agent.modelConfig === 'string' && agent.modelConfig) {
        try {
          modelConfig = JSON.parse(agent.modelConfig);
        } catch (e) {
          this.logger.warn(`Error al parsear modelConfig para agente ${agentId}:`, e);
        }
      }
      
      let operatingHours = null;
      if (typeof agent.operatingHours === 'string' && agent.operatingHours) {
        try {
          operatingHours = JSON.parse(agent.operatingHours);
        } catch (e) {
          this.logger.warn(`Error al parsear operatingHours para agente ${agentId}:`, e);
        }
      }
      
      // Devolver datos del agente
      return {
        id: agent.id,
        userId: agent.userId,
        code: agent.code,
        name: agent.name,
        description: agent.description,
        modelType: agent.modelType,
        modelConfig,
        handoffEnabled: agent.handoffEnabled,
        systemInstructions: agent.systemInstructions,
        temperature: agent.temperature,
        operatingHours,
        createdAt: agent.createdAt,
        knowledgeBases
      };
    } catch (error) {
      this.logger.error(`Error al obtener detalles del agente ${agentId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al obtener detalles del agente');
    }
  }
  
  private async verifyAgentAccess(agentId: string, userId: string): Promise<boolean> {
    try {
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
  
  private async getAgentKnowledgeBases(agentId: string): Promise<any[]> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      const knowledgeBases: any[] = [];
      const kbEntities = tableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${agentId}' and isActive eq true` }
      });
      
      for await (const kb of kbEntities) {
        knowledgeBases.push({
          id: kb.id,
          name: kb.name,
          description: kb.description,
          type: kb.type,
          createdAt: kb.createdAt,
          updatedAt: kb.updatedAt
        });
      }
      
      return knowledgeBases;
    } catch (error) {
      this.logger.warn(`Error al obtener bases de conocimiento para el agente ${agentId}:`, error);
      return [];
    }
  }
}