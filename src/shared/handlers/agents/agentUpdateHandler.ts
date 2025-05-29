// src/shared/handlers/agents/agentUpdateHandler.ts (corregido)
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Agent, HandoffMethod, AgentHandoffConfig  } from "../../models/agent.model";
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
      
      // Preparar datos de actualización como TableEntity
      const updateEntity: TableEntity = {
        partitionKey: 'agent',
        rowKey: agentId,
        updatedAt: Date.now()
      };

      const immutableFields = ['id', 'userId', 'code', 'createdAt'];
      for (const [key, value] of Object.entries(updateData)) {
          if (!immutableFields.includes(key)) {
              if (key === 'handoffConfig') {
                  // Asegurar que handoffConfig se guarda como string JSON
                  updateEntity[key] = typeof value === 'object' ? JSON.stringify(value) : value;
              } else if (key === 'handoffWhatsappNumbers' && Array.isArray(value)) {
                  // Si aún se usa handoffWhatsappNumbers directamente (aunque es mejor dentro de handoffConfig)
                  updateEntity[key] = JSON.stringify(value);
              }
              else {
                  updateEntity[key] = value;
              }
          }
      }

      if (updateData.organizationName !== undefined) {
          updateEntity.organizationName = updateData.organizationName;
      }
        
      
        await tableClient.updateEntity(updateEntity, "Merge");
        const updatedAgent = await tableClient.getEntity('agent', agentId); // Recuperar la entidad completa

        // Parsear handoffConfig para devolverlo como objeto
        let parsedHandoffConfig: AgentHandoffConfig | undefined;
        if (updatedAgent.handoffConfig && typeof updatedAgent.handoffConfig === 'string') {
            try {
                parsedHandoffConfig = JSON.parse(updatedAgent.handoffConfig);
            } catch (e) {
                this.logger.error(`Error al parsear handoffConfig para agente actualizado ${agentId}: ${e}`);
                parsedHandoffConfig = { type: HandoffMethod.PLATFORM, notificationTargets: [] }; // Fallback
            }
        }
      // Devolver respuesta
      return {
        id: updatedAgent.id,
        name: updatedAgent.name,
        description: updatedAgent.description,
        modelType: updatedAgent.modelType,
        temperature: updatedAgent.temperature,
        handoffEnabled: updatedAgent.handoffEnabled,
        systemInstructions: updatedAgent.systemInstructions,
        organizationName: updatedAgent.organizationName,
        handoffConfig: parsedHandoffConfig,
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