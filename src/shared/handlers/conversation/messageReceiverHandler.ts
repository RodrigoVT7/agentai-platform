// src/shared/handlers/conversation/messageReceiverHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { 
  MessageRequest, 
  MessageResponse, 
  Message, 
  Conversation, 
  ConversationStatus, 
  MessageRole, 
  MessageStatus, 
  MessageType 
} from "../../models/conversation.model";

export class MessageReceiverHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async execute(messageData: MessageRequest, userId: string): Promise<MessageResponse> {
    try {
      const { agentId, conversationId, content, messageType, contentType, attachments, metadata } = messageData;
      
      // Verificar acceso al agente
      const hasAccess = await this.verifyAgentAccess(agentId, userId);
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para enviar mensajes a este agente");
      }
      
      // Obtener o crear conversación
      let activeConversationId = conversationId;
      if (!activeConversationId) {
        activeConversationId = await this.createNewConversation(agentId, userId, metadata);
      } else {
        // Verificar que la conversación esté activa
        const isActive = await this.isConversationActive(activeConversationId);
        if (!isActive) {
          throw createAppError(400, "No se puede enviar mensaje a una conversación finalizada");
        }
      }
      
      // Crear mensaje
      const messageId = uuidv4();
      const now = Date.now();
      
      const newMessage: Message = {
        id: messageId,
        conversationId: activeConversationId,
        content,
        role: MessageRole.USER,
        senderId: userId,
        timestamp: now,
        status: MessageStatus.SENT,
        messageType: messageType || MessageType.TEXT,
        contentType: contentType,
        attachments,
        metadata,
        createdAt: now
      };
      
      // Guardar mensaje en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
      await tableClient.createEntity({
        partitionKey: activeConversationId,
        rowKey: messageId,
        ...newMessage
      });
      
      // Actualizar timestamp de la conversación
      await this.updateConversationTimestamp(activeConversationId);
      
      // Encolar mensaje para procesamiento
      const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.CONVERSATION);
      await queueClient.sendMessage(Buffer.from(JSON.stringify({
        messageId,
        conversationId: activeConversationId,
        agentId,
        userId
      })).toString('base64'));
      
      this.logger.info(`Mensaje ${messageId} recibido y encolado para procesamiento`);
      
      return {
        messageId,
        conversationId: activeConversationId,
        status: MessageStatus.SENT,
        timestamp: now
      };
    } catch (error) {
      this.logger.error(`Error al procesar mensaje:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al procesar mensaje');
    }
  }
  
  private async verifyAgentAccess(agentId: string, userId: string): Promise<boolean> {
    try {
      // Verificar si es propietario
      const agentsTable = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      try {
        const agent = await agentsTable.getEntity('agent', agentId);
        
        if (agent.userId === userId) {
          return true;
        }
      } catch (error) {
        this.logger.warn(`Agente ${agentId} no encontrado:`, error);
        return false;
      }
      
      // Verificar roles
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
  
  private async createNewConversation(agentId: string, userId: string, metadata?: Record<string, any>): Promise<string> {
    try {
      const conversationId = uuidv4();
      const now = Date.now();
      
      // Generar código único para la conversación
      const code = `conv-${now.toString(36)}-${Math.random().toString(36).substr(2, 4)}`;
      
      const newConversation: Conversation = {
        id: conversationId,
        agentId,
        userId,
        code,
        startDate: now,
        status: ConversationStatus.ACTIVE,
        sourceChannel: 'web', // Default value, can be customized
        metadata,
        createdAt: now,
        updatedAt: now
      };
      
      // Guardar en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
      await tableClient.createEntity({
        partitionKey: agentId,
        rowKey: conversationId,
        ...newConversation
      });
      
      this.logger.info(`Nueva conversación creada: ${conversationId}`);
      
      return conversationId;
    } catch (error) {
      this.logger.error(`Error al crear nueva conversación:`, error);
      throw createAppError(500, 'Error al crear nueva conversación');
    }
  }
  
  private async isConversationActive(conversationId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
      
      // Buscar la conversación en todas las particiones ya que no sabemos el agentId
      const conversations = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${conversationId}'` }
      });
      
      for await (const conversation of conversations) {
        return conversation.status === ConversationStatus.ACTIVE;
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Error al verificar estado de conversación ${conversationId}:`, error);
      return false;
    }
  }
  
  private async updateConversationTimestamp(conversationId: string): Promise<void> {
    try {
      // Buscar primero para obtener la partitionKey
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
      
      const conversations = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${conversationId}'` }
      });
      
      for await (const conversation of conversations) {
        if (conversation && conversation.partitionKey) {
          await tableClient.updateEntity({
            partitionKey: conversation.partitionKey as string,
            rowKey: conversationId,
            updatedAt: Date.now()
          }, "Merge");
          break;
        }
      }
    } catch (error) {
      this.logger.warn(`Error al actualizar timestamp de conversación ${conversationId}:`, error);
      // No propagar el error para no interrumpir el flujo principal
    }
  }
}