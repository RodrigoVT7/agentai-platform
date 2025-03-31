// src/shared/handlers/agents/agentUpdateHandler.ts (corregido)
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Agent } from "../../models/agent.model";
import { TableEntity } from "@azure/data-tables";

export class AgentUpdateHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async execute(agentId: string, userId: string, updateData: Record<string, any>): Promise<any> {
    try {
      // Verificar si el agente existe y pertenece al usuario
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      let agent: Agent;
      
      try {
        agent = await tableClient.getEntity('agent', agentId) as unknown as Agent;
        
        if (agent.userId !== userId) {
          throw createAppError(403, 'No tienes permiso para modificar este agente');
        }
      } catch (error: any) {
        if (error.statusCode === 403) throw error;
        throw createAppError(404, 'Agente no encontrado');
      }
      
      // Campos que no se pueden modificar
      const immutableFields = ['id', 'userId', 'code', 'createdAt'];
      
      // Preparar datos de actualización como TableEntity
      const updateEntity: TableEntity = {
        partitionKey: 'agent',
        rowKey: agentId
      };
      
      // Añadir campos a actualizar
      for (const [key, value] of Object.entries(updateData)) {
        if (!immutableFields.includes(key)) {
          updateEntity[key] = value;
        }
      }
      
      // Añadir timestamp de actualización
      updateEntity.updatedAt = Date.now();
      
      // Actualizar entidad
      await tableClient.updateEntity(updateEntity, "Merge");
      
      // Obtener el agente actualizado
      const updatedAgent = await tableClient.getEntity('agent', agentId);
      
      // Devolver respuesta
      return {
        id: updatedAgent.id,
        name: updatedAgent.name,
        description: updatedAgent.description,
        modelType: updatedAgent.modelType,
        temperature: updatedAgent.temperature,
        handoffEnabled: updatedAgent.handoffEnabled,
        systemInstructions: updatedAgent.systemInstructions,
        updatedAt: updatedAgent.updatedAt,
        message: "Agente actualizado con éxito"
      };
    } catch (error: unknown) {
      this.logger.error(`Error al actualizar agente ${agentId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al actualizar agente');
    }
  }
}