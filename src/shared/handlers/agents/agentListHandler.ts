// src/shared/handlers/agents/agentListHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Agent } from "../../models/agent.model";

interface ListOptions {
  limit: number;
  skip: number;
  search?: string;
  status?: string;
}

export class AgentListHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async execute(userId: string, options: ListOptions): Promise<any> {
    try {
      const { limit, skip, search, status } = options;
      
      // Crear filtro base
      let filter = `userId eq '${userId}'`;
      
      // Añadir filtro de estado si se proporciona
      if (status === 'active') {
        filter += ` and isActive eq true`;
      } else if (status === 'inactive') {
        filter += ` and isActive eq false`;
      }
      
      // No podemos filtrar por nombre directamente en el query de Table Storage,
      // así que recuperamos todos y filtramos en la aplicación
      
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      const agents = tableClient.listEntities({
        queryOptions: { filter }
      });
      
      // Procesar resultados
      const allAgents: Agent[] = [];
      for await (const agent of agents) {
        // Convertir a tipo Agent
        const agentItem: Agent = {
          id: agent.id as string,
          userId: agent.userId as string,
          code: agent.code as string,
          name: agent.name as string,
          description: agent.description as string,
          modelType: agent.modelType as string,
          modelConfig: agent.modelConfig || {},
          handoffEnabled: agent.handoffEnabled as boolean,
          systemInstructions: agent.systemInstructions as string,
          temperature: agent.temperature as number,
          isActive: agent.isActive as boolean,
          operatingHours: agent.operatingHours || null,
          createdAt: agent.createdAt as number
        };
        
        allAgents.push(agentItem);
      }
      
      // Filtrar por búsqueda si se proporciona
      let filteredAgents = allAgents;
      if (search) {
        const searchLower = search.toLowerCase();
        filteredAgents = allAgents.filter(agent => 
          agent.name.toLowerCase().includes(searchLower) ||
          agent.description.toLowerCase().includes(searchLower) ||
          agent.code.toLowerCase().includes(searchLower)
        );
      }
      
      // Ordenar por fecha de creación (más reciente primero)
      filteredAgents.sort((a, b) => b.createdAt - a.createdAt);
      
      // Aplicar paginación
      const paginatedAgents = filteredAgents.slice(skip, skip + limit);
      
      // Obtener bases de conocimiento para cada agente
      const agentsWithKBs = await this.enrichAgentsWithKnowledgeBases(paginatedAgents);
      
      return {
        agents: agentsWithKBs,
        total: filteredAgents.length,
        limit,
        skip
      };
    } catch (error: unknown) {
      this.logger.error('Error al listar agentes:', error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al listar agentes');
    }
  }
  
  private async enrichAgentsWithKnowledgeBases(agents: Agent[]): Promise<any[]> {
    if (agents.length === 0) return [];
    
    const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
    const enrichedAgents: any[] = [];
    
    for (const agent of agents) {
      try {
        // Obtener bases de conocimiento para este agente
        const knowledgeBases: any[] = [];
        const kbEntities = tableClient.listEntities({
          queryOptions: { filter: `partitionKey eq '${agent.id}' and isActive eq true` }
        });
        
        for await (const kb of kbEntities) {
          knowledgeBases.push({
            id: kb.id,
            name: kb.name,
            description: kb.description,
            createdAt: kb.createdAt
          });
        }
        
        // Enriquecer agente con sus bases de conocimiento
        enrichedAgents.push({
          ...agent,
          knowledgeBases
        });
      } catch (error) {
        this.logger.warn(`Error al obtener bases de conocimiento para el agente ${agent.id}:`, error);
        // Incluir el agente sin bases de conocimiento
        enrichedAgents.push({
          ...agent,
          knowledgeBases: []
        });
      }
    }
    
    return enrichedAgents;
  }
}