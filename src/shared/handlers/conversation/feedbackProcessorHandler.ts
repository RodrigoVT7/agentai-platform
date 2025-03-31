// src/shared/handlers/conversation/feedbackProcessorHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Feedback, FeedbackRating, Message, MessageRole } from "../../models/conversation.model";

export class FeedbackProcessorHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async execute(messageId: string, userId: string, feedbackData: any): Promise<any> {
    try {
      // 1. Verificar que el mensaje existe y es de tipo ASSISTANT
      const messageDetails = await this.getMessageDetails(messageId);
      
      if (!messageDetails) {
        throw createAppError(404, "Mensaje no encontrado");
      }
      
      if (messageDetails.role !== MessageRole.ASSISTANT) {
        throw createAppError(400, "Solo se puede proporcionar feedback para mensajes del asistente");
      }
      
      // 2. Verificar acceso a la conversación
      const hasAccess = await this.verifyConversationAccess(messageDetails.conversationId, userId);
      
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para acceder a esta conversación");
      }
      
      // 3. Verificar si ya existe feedback para este mensaje
      const existingFeedback = await this.getExistingFeedback(messageId, userId);
      
      // 4. Crear nuevo feedback o actualizar existente
      const feedbackId = existingFeedback ? existingFeedback.id : uuidv4();
      const now = Date.now();
      
      const feedback: Feedback = {
        id: feedbackId,
        messageId,
        userId,
        rating: feedbackData.rating as FeedbackRating,
        comment: feedbackData.comment,
        category: feedbackData.category,
        isHelpful: feedbackData.isHelpful,
        feedbackDate: now,
        reviewed: false,
        createdAt: existingFeedback ? existingFeedback.createdAt : now,
        updatedAt: now
      };
      
      // 5. Guardar feedback
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.FEEDBACK);
      
      if (existingFeedback) {
        // Actualizar feedback existente
        await tableClient.updateEntity({
          partitionKey: messageId,
          rowKey: userId,
          ...feedback
        }, "Replace");
      } else {
        // Crear nuevo feedback
        await tableClient.createEntity({
          partitionKey: messageId,
          rowKey: userId,
          ...feedback
        });
      }
      
      this.logger.info(`Feedback ${existingFeedback ? 'actualizado' : 'creado'} para mensaje ${messageId}`);
      
      // 6. Retornar resultado
      return {
        id: feedbackId,
        messageId,
        rating: feedback.rating,
        isHelpful: feedback.isHelpful,
        message: `Feedback ${existingFeedback ? 'actualizado' : 'enviado'} con éxito`
      };
    } catch (error) {
      this.logger.error(`Error al procesar feedback para mensaje ${messageId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al procesar feedback');
    }
  }
  
  private async getMessageDetails(messageId: string): Promise<Message | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
      
      // Como no conocemos el conversationId (partitionKey), necesitamos buscar en todas las entidades
      const messages = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${messageId}'` }
      });
      
      for await (const message of messages) {
        return {
          id: message.id as string,
          conversationId: message.conversationId as string,
          content: message.content as string,
          role: message.role as MessageRole,
          senderId: message.senderId as string,
          timestamp: Number(message.timestamp), // Conversión explícita a número
          status: message.status as any,
          messageType: message.messageType as any,
          createdAt: message.createdAt as number
        };
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Error al obtener detalles del mensaje ${messageId}:`, error);
      return null;
    }
  }
  
  private async verifyConversationAccess(conversationId: string, userId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
      
      const conversations = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${conversationId}'` }
      });
      
      for await (const conversation of conversations) {
        // Si el usuario es propietario de la conversación
        if (conversation.userId === userId) {
          return true;
        }
        
        // Verificar acceso al agente
        const agentId = conversation.agentId as string;
        return await this.verifyAgentAccess(agentId, userId);
      }
      
      return false;
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
  
  private async getExistingFeedback(messageId: string, userId: string): Promise<Feedback | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.FEEDBACK);
      
      try {
        const feedback = await tableClient.getEntity(messageId, userId);
        return feedback as unknown as Feedback;
      } catch (error) {
        return null;
      }
    } catch (error) {
      this.logger.error(`Error al buscar feedback existente:`, error);
      return null;
    }
  }
}