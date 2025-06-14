// src/shared/handlers/conversation/conversationHistoryHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Message } from "../../models/conversation.model";

interface HistoryOptions {
  limit: number;
  before?: number;
}

export class ConversationHistoryHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async execute(conversationId: string, userId: string, agentId?: string, options: HistoryOptions = { limit: 50 }): Promise<any> {
    try {
      // 1. Verificar acceso a la conversación
      const hasAccess = await this.verifyConversationAccess(conversationId, userId, agentId);
      
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para acceder a esta conversación");
      }
      
      // 2. Obtener detalles de la conversación
      const conversation = await this.getConversationDetails(conversationId);
      
      if (!conversation) {
        throw createAppError(404, "Conversación no encontrada");
      }
      
      // 3. Obtener mensajes
      const messages = await this.getConversationMessages(conversationId, options);
      
      // 4. Devolver resultado
      return {
        conversation: {
          id: conversation.id,
          agentId: conversation.agentId,
          code: conversation.code,
          startDate: conversation.startDate,
          endDate: conversation.endDate,
          status: conversation.status,
          sourceChannel: conversation.sourceChannel
        },
        messages,
        pagination: {
          limit: options.limit,
          hasMore: messages.length === options.limit
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener historial de conversación ${conversationId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al obtener historial de conversación');
    }
  }
  
  private async verifyConversationAccess(conversationId: string, userId: string, agentId?: string): Promise<boolean> {
    try {
      // Obtener la conversación
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
      
      const conversations = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${conversationId}'` }
      });
      
      let conversation: any = null;
      
      for await (const entity of conversations) {
        conversation = entity;
        break;
      }
      
      if (!conversation) {
        return false;
      }
      
      // Verificar si el usuario es propietario de la conversación
      if (conversation.userId === userId) {
        return true;
      }
      
      // Si se proporciona un agentId, verificar que coincida con el de la conversación
      if (agentId && conversation.agentId !== agentId) {
        return false;
      }
      
      // Verificar si el usuario tiene acceso al agente
      return await this.verifyAgentAccess(conversation.agentId, userId);
    } catch (error) {
      this.logger.error(`Error al verificar acceso a conversación ${conversationId}:`, error);
      return false;
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
  
  private async getConversationDetails(conversationId: string): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
      
      const conversations = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${conversationId}'` }
      });
      
      for await (const conversation of conversations) {
        return conversation;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Error al obtener detalles de conversación ${conversationId}:`, error);
      return null;
    }
  }
  
  private async getConversationMessages(conversationId: string, options: HistoryOptions): Promise<Message[]> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
      
      // Construir filtro
      let filter = `PartitionKey eq '${conversationId}'`;
      
      if (options.before) {
        filter += ` and timestamp lt ${options.before}`;
      }
      
      const messages: Message[] = [];
      const messagesEntities = await tableClient.listEntities({
        queryOptions: { filter }
      });
      
      for await (const entity of messagesEntities) {
        messages.push(entity as unknown as Message);
      }
      
      // Ordenar por timestamp descendente y limitar
      return messages
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, options.limit);
      
    } catch (error) {
      this.logger.error(`Error al obtener mensajes de conversación ${conversationId}:`, error);
      return [];
    }
  }
}