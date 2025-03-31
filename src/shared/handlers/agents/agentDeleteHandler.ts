// src/shared/handlers/agents/agentDeleteHandler.ts (corregido)
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";

export class AgentDeleteHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async execute(agentId: string, userId: string): Promise<any> {
    try {
      // Verificar si el agente existe y pertenece al usuario
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      let agent;
      
      try {
        agent = await tableClient.getEntity('agent', agentId);
        
        if (agent.userId !== userId) {
          throw createAppError(403, 'No tienes permiso para eliminar este agente');
        }
      } catch (error: any) {
        if (error.statusCode === 403) throw error;
        throw createAppError(404, 'Agente no encontrado');
      }
      
      // Realizar eliminación lógica (no física)
      await tableClient.updateEntity({
        partitionKey: 'agent',
        rowKey: agentId,
        isActive: false,
        deletedAt: Date.now()
      }, "Merge");
      
      // Desactivar bases de conocimiento asociadas
      await this.deactivateKnowledgeBases(agentId);
      
      return {
        id: agentId,
        message: "Agente eliminado con éxito"
      };
    } catch (error: unknown) {
      this.logger.error(`Error al eliminar agente ${agentId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al eliminar agente');
    }
  }
  
  private async deactivateKnowledgeBases(agentId: string): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      // Obtener todas las bases de conocimiento asociadas
      const knowledgeBases = tableClient.listEntities({
        queryOptions: { filter: `partitionKey eq '${agentId}' and isActive eq true` }
      });
      
      for await (const kb of knowledgeBases) {
        if (typeof kb.partitionKey === 'string' && typeof kb.rowKey === 'string') {
          // Desactivar cada base de conocimiento
          await tableClient.updateEntity({
            partitionKey: kb.partitionKey,
            rowKey: kb.rowKey,
            isActive: false,
            deletedAt: Date.now()
          }, "Merge");
        }
      }
    } catch (error) {
      this.logger.error(`Error al desactivar bases de conocimiento para el agente ${agentId}:`, error);
      // No propagamos el error para no interrumpir el flujo principal
    }
  }
}