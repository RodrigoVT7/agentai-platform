// src/shared/handlers/agents/agentCreateHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { NotificationService } from "../../services/notification.service";
import { Agent, HandoffMethod, AgentHandoffConfig } from "../../models/agent.model";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";

export class AgentCreateHandler {
  private storageService: StorageService;
  private notificationService: NotificationService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.notificationService = new NotificationService();
    this.logger = logger || createLogger();
  }
  
  async execute(agentData: any): Promise<any> {
    try {
       const {
            userId, name, description, modelType, systemInstructions,
            temperature, handoffEnabled,
            handoffConfig, // Se espera un objeto AgentHandoffConfig
            organizationName
        } = agentData;

      // Generar código único para el agente (para URLs amigables y referencias)
      const code = this.generateAgentCode(name);
      
      // Verificar si ya existe un agente con ese código para el usuario
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      const existingAgents = await tableClient.listEntities({
        queryOptions: { filter: `userId eq '${userId}' and code eq '${code}'` }
      });
      
      for await (const agent of existingAgents) {
        if (agent.code === code) {
          throw createAppError(409, `Ya existe un agente con un nombre similar. Por favor elige otro nombre.`);
        }
      }
      
      // Verificar límite de agentes según plan
      // En una implementación real, verificaríamos la suscripción del usuario
      const agentCount = await this.countUserAgents(userId);
      const maxAgents = 5; // Ejemplo: límite de 5 agentes en plan básico
      
      if (agentCount >= maxAgents) {
        throw createAppError(403, `Has alcanzado el límite de ${maxAgents} agentes en tu plan actual.`);
      }
      
      // Crear nuevo agente
      const agentId = uuidv4();
      const now = Date.now();
      
      const newAgent: Agent = {
        id: agentId,
        userId: userId,
        code: code,
        name: name,
        description: description || '',
        modelType: modelType || 'gpt-4o',
        // Serializar modelConfig como string
        modelConfig: typeof agentData.modelConfig === 'object' ? 
          JSON.stringify(agentData.modelConfig) : agentData.modelConfig || '{}',
        handoffEnabled: handoffEnabled !== undefined ? handoffEnabled : false,
        systemInstructions: systemInstructions || '',
        temperature: temperature !== undefined ? temperature : 0.7,
        isActive: true,
        // Serializar operatingHours como string
        operatingHours: agentData.operatingHours ? 
          JSON.stringify(agentData.operatingHours) : null,
        createdAt: now,
        organizationName: organizationName || 'Organización Desconocida', // Nuevo
        handoffConfig: handoffConfig ? JSON.stringify(handoffConfig) : JSON.stringify({ type: HandoffMethod.PLATFORM, notificationTargets: [] })
        };
      
      // Guardar en Table Storage
      await tableClient.createEntity({
        partitionKey: 'agent',
        rowKey: agentId,
        ...newAgent,
      });
      
      // Crear base de conocimiento por defecto
      const kbId = await this.createDefaultKnowledgeBase(agentId, userId);
      
      // Crear respuesta
       const response = {
            id: agentId,
            code: code,
            name: name,
            description: description || '',
            knowledgeBaseId: kbId, // kbId debe estar definida
            createdAt: now,
            organizationName: newAgent.organizationName,
            handoffConfig: handoffConfig || { type: HandoffMethod.PLATFORM, notificationTargets: [] },
            message: "Agente creado con éxito"
        };

      return response;
    } catch (error: unknown) {
      this.logger.error('Error al crear agente:', error);
      
      // Re-lanzar el error si ya es un AppError
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al crear agente');
    }
  }
  
  private async countUserAgents(userId: string): Promise<number> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      let count = 0;
      const agents = await tableClient.listEntities({
        queryOptions: { filter: `userId eq '${userId}' and isActive eq true` }
      });
      
      for await (const agent of agents) {
        count++;
      }
      
      return count;
    } catch (error) {
      this.logger.error(`Error al contar agentes del usuario ${userId}:`, error);
      return 0;
    }
  }
  
  private async createDefaultKnowledgeBase(agentId: string, userId: string): Promise<string> {
    try {
      const kbId = uuidv4();
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      // Añadir el campo type que está faltando y asegurar que no hay objetos complejos
      await tableClient.createEntity({
        partitionKey: agentId,
        rowKey: kbId,
        id: kbId,
        agentId: agentId,
        name: "Base de conocimiento predeterminada",
        description: "Base de conocimiento creada automáticamente",
        type: "vector", // Añadir este campo
        vectorConfig: "{}", // Configuración vacía pero serializada
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isActive: true
      });
      
      return kbId;
    } catch (error) {
      this.logger.error(`Error al crear base de conocimiento predeterminada:`, error);
      throw createAppError(500, 'Error al crear base de conocimiento predeterminada');
    }
  }
  
  private generateAgentCode(name: string): string {
    // Convertir nombre a slug y añadir timestamp para unicidad
    const baseCode = name
      .toLowerCase()
      .replace(/[^\w\s-]/g, '') // Quitar caracteres especiales
      .replace(/\s+/g, '-') // Reemplazar espacios con guiones
      .substring(0, 30); // Limitar longitud
    
    // Añadir timestamp en base36 para asegurar unicidad
    const timestamp = Date.now().toString(36).substring(0, 6);
    
    return `${baseCode}-${timestamp}`;
  }
}