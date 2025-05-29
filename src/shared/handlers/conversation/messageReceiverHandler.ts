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
import { User } from "../../models/user.model"; // Importar modelo User si es necesario

export class MessageReceiverHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async execute(messageData: MessageRequest, requestorUserId: string): Promise<MessageResponse> {
    try {
      const { agentId, conversationId, content, messageType, contentType, attachments, metadata, sourceChannel } = messageData; // sourceChannel ahora existe

      let endUserId: string;
      let conversationToUseId: string | undefined = conversationId;
      let existingConversation: Conversation | null = null;

      // --- Identificar/Crear Usuario Final y Conversación ---
      if (sourceChannel === 'whatsapp' && metadata?.whatsapp?.from) {
          const whatsappNumber = metadata.whatsapp.from;
          endUserId = await this.findOrCreateEndUser(`whatsapp:${whatsappNumber}`, metadata.whatsapp.fromName);

          if (!conversationToUseId) {
               existingConversation = await this.findActiveConversation(agentId, endUserId, sourceChannel);
               if (existingConversation) {
                   conversationToUseId = existingConversation.id;
                   this.logger.info(`Reanudando conversación existente ${conversationToUseId} para ${whatsappNumber}`);
               }
          }
      } else {
          // Para otros canales, usar el requestorUserId o lógica específica
          endUserId = requestorUserId;
          // --- CORRECCIÓN: Mover la verificación de acceso aquí ---
          // Solo verificar el acceso si el mensaje NO viene de WhatsApp
          // (o de otros canales externos donde el 'requestor' no es el 'endUser')
          const hasAccess = await this.verifyAgentAccess(agentId, requestorUserId);
          if (!hasAccess) {
             throw createAppError(403, "No tienes permiso para enviar mensajes a este agente");
          }
      }


      // --- Obtener o Crear Conversación ---
      if (!conversationToUseId) {
        // ... (lógica de creación de conversación como antes, usando endUserId)
         conversationToUseId = await this.createNewConversation(agentId, endUserId, sourceChannel || 'unknown', metadata);
      } else if (!existingConversation) {
         // ... (lógica de verificación de conversación existente como antes)
          existingConversation = await this.findConversationById(conversationToUseId);
          if (!existingConversation || existingConversation.status !== ConversationStatus.ACTIVE) {
              throw createAppError(400, `La conversación ${conversationToUseId} no existe o no está activa.`);
          }
          if (existingConversation.endUserId && existingConversation.endUserId !== endUserId) {
               this.logger.warn(`Intento de añadir mensaje a conversación ${conversationToUseId} de otro usuario (${existingConversation.endUserId} vs ${endUserId})`);
               throw createAppError(403, "Conflicto de usuario en la conversación.");
          }
      }


       // --- Crear y Guardar Mensaje ---
       // ... (lógica para crear y guardar mensaje como antes, usando endUserId como senderId)
      const messageId = uuidv4();
      const now = Date.now();

      const newMessage: Message = {
        id: messageId,
        conversationId: conversationToUseId,
        content,
        role: MessageRole.USER,
        senderId: endUserId, // ID del usuario final
        timestamp: metadata?.whatsapp?.timestamp || now,
        status: MessageStatus.SENT,
        messageType: messageType || MessageType.TEXT,
        contentType: contentType,
        attachments,
        metadata,
        createdAt: now
      };

      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
      await tableClient.createEntity({
        partitionKey: conversationToUseId,
        rowKey: messageId,
        ...newMessage,
        attachments: attachments ? JSON.stringify(attachments) : undefined,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
      });


      // --- Actualizar Timestamp y Encolar ---
      // ... (lógica para actualizar timestamp y encolar como antes)
      await this.updateConversationTimestamp(conversationToUseId!, agentId);

      const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.CONVERSATION);
      const queuePayload = {
        messageId,
        conversationId: conversationToUseId!,
        agentId,
        userId: endUserId // Usar el ID del usuario final para el contexto
      };

      // MODIFICADO: Log ANTES de encolar
      this.logger.info(`MessageReceiverHandler: PREPARANDO para encolar en '${STORAGE_QUEUES.CONVERSATION}'. Payload: ${JSON.stringify(queuePayload)}`);

      try {
        await queueClient.sendMessage(Buffer.from(JSON.stringify(queuePayload)).toString('base64'));
        // NUEVO LOG: Log DESPUÉS y en caso de ÉXITO
        this.logger.info(`MessageReceiverHandler: ÉXITO al encolar en '${STORAGE_QUEUES.CONVERSATION}'. MessageId encolado: ${messageId}`);
      } catch (enqueueError) {
        // NUEVO LOG: Log en caso de FALLO al encolar
        this.logger.error(`MessageReceiverHandler: FALLO AL ENCOLAR en '${STORAGE_QUEUES.CONVERSATION}'. MessageId: ${messageId}. Error:`, enqueueError);
        // CRÍTICO: Re-lanzar el error para que sea visible y la función HTTP falle,
        // lo que podría permitir a Meta reintentar el webhook.
        throw createAppError(500, `Fallo al encolar mensaje para procesamiento: ${(enqueueError as Error).message}`, enqueueError);
      }

      // ESTE LOG ORIGINAL AHORA ES REDUNDANTE SI EL DE "ÉXITO AL ENCOLAR" FUNCIONA, PERO PUEDES DEJARLO SI QUIERES
      this.logger.info(`MessageReceiverHandler: Mensaje ${messageId} (origen: ${sourceChannel}) procesado y encolado (según lógica previa).`);

      // --- Devolver respuesta ---
       return {
        messageId,
        conversationId: conversationToUseId!,
        status: MessageStatus.SENT,
        timestamp: newMessage.timestamp
      };

    } catch (error) {
      this.logger.error(`Error al procesar mensaje:`, error);
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      throw createAppError(500, 'Error al procesar mensaje');
    }
  }

  /**
   * Busca o crea un usuario final basado en su identificador de canal (ej. "whatsapp:123456").
   * Necesitarás una tabla para usuarios finales o adaptar la tabla 'users'.
   */
  private async findOrCreateEndUser(endUserIdentifier: string, profileName?: string): Promise<string> {
    const usersTableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS); // O una tabla END_USERS
    const partitionKey = 'endUser'; // O una clave adecuada

    try {
        // Intentar buscar por RowKey (el identificador único)
        const existingUser = await usersTableClient.getEntity(partitionKey, endUserIdentifier);
        this.logger.debug(`Usuario final encontrado: ${existingUser.rowKey}`);
        // Opcional: Actualizar nombre si ha cambiado
        if (profileName && existingUser.firstName !== profileName) {
            await usersTableClient.updateEntity({ partitionKey, rowKey: endUserIdentifier, firstName: profileName }, "Merge");
        }
        return existingUser.rowKey as string;
    } catch (error: any) {
        if (error.statusCode === 404) {
            // No encontrado, crear nuevo usuario final
            this.logger.info(`Creando nuevo usuario final para ${endUserIdentifier}`);
            const newUserId = endUserIdentifier; // Usar el identificador como ID
            const newUser = {
                partitionKey: partitionKey,
                rowKey: newUserId,
                id: newUserId, // Puede ser redundante pero útil
                channelId: endUserIdentifier, // Guardar el identificador completo
                firstName: profileName || 'Usuario', // Nombre de perfil o genérico
                sourceChannel: endUserIdentifier.split(':')[0], // 'whatsapp'
                createdAt: Date.now(),
                isActive: true
            };
            await usersTableClient.createEntity(newUser);
            return newUserId;
        } else {
            this.logger.error(`Error al buscar/crear usuario final ${endUserIdentifier}:`, error);
            throw error; // Relanzar otros errores
        }
    }
}

/**
 * Busca una conversación activa existente para un agente y usuario final específicos.
 */
 private async findActiveConversation(agentId: string, endUserId: string, sourceChannel: string): Promise<Conversation | null> {
     try {
         const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
         const filter = `PartitionKey eq '${agentId}' and userId eq '${endUserId}' and status eq '${ConversationStatus.ACTIVE}' and sourceChannel eq '${sourceChannel}'`;
         const conversations = tableClient.listEntities({ queryOptions: { filter } });

         let latestConversation: Conversation | null = null;
         for await (const conv of conversations) {
             // Quedarse con la más reciente si hay varias activas (debería evitarse)
             if (!latestConversation || (conv.createdAt as number) > (latestConversation.createdAt as number)) {
                  latestConversation = conv as unknown as Conversation;
             }
         }
         return latestConversation;
     } catch (error) {
         this.logger.error(`Error buscando conversación activa para agente ${agentId} y usuario ${endUserId}:`, error);
         return null;
     }
 }

 /**
 * Busca una conversación por su ID.
 */
private async findConversationById(conversationId: string): Promise<Conversation | null> {
      try {
          const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
          const conversations = await tableClient.listEntities({ queryOptions: { filter: `RowKey eq '${conversationId}'` } });
          for await (const conv of conversations) {
               return conv as unknown as Conversation; // Devuelve la primera encontrada
          }
          return null;
      } catch (error) {
          this.logger.error(`Error buscando conversación por ID ${conversationId}:`, error);
          return null;
      }
  }

  /**
   * Crea una nueva conversación.
   */
  private async createNewConversation(agentId: string, endUserId: string, sourceChannel: string, metadata?: Record<string, any>): Promise<string> {
      try {
          const conversationId = uuidv4();
          const now = Date.now();
          const code = `conv-${now.toString(36)}-${Math.random().toString(36).substr(2, 4)}`;

          const newConversation: Conversation = {
              id: conversationId,
              agentId,
              userId: endUserId, // Asociar con el usuario final
              endUserId: endUserId, // Guardar explícitamente el ID del usuario final
              code,
              startDate: now,
              status: ConversationStatus.ACTIVE,
              sourceChannel: sourceChannel,
              metadata,
              createdAt: now,
              updatedAt: now
          };

          const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
          await tableClient.createEntity({
              partitionKey: agentId, // Usar agentId como clave de partición
              rowKey: conversationId,
              ...newConversation,
               // Serializar metadata
               metadata: metadata ? JSON.stringify(metadata) : undefined,
          });

          this.logger.info(`Nueva conversación ${conversationId} creada para agente ${agentId} y usuario final ${endUserId}`);
          return conversationId;
      } catch (error) {
          this.logger.error(`Error al crear nueva conversación para agente ${agentId}:`, error);
          throw createAppError(500, 'Error al crear nueva conversación');
      }
  }


// Modificar para aceptar agentId como PartitionKey
private async updateConversationTimestamp(conversationId: string, agentId: string): Promise<void> {
  try {
    const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
    await tableClient.updateEntity({
      partitionKey: agentId, // Usar agentId
      rowKey: conversationId,
      updatedAt: Date.now()
    }, "Merge");
  } catch (error: any) {
     if (error.statusCode !== 404) { // Ignorar si la conversación no se encuentra (podría ser un mensaje inicial)
         this.logger.warn(`Error al actualizar timestamp de conversación ${conversationId} (agente ${agentId}):`, error);
     }
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
  

}