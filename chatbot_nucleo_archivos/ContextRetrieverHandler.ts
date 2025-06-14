// src/shared/handlers/conversation/contextRetrieverHandler.ts
import { StorageService } from "../../services/storage.service";
import { OpenAIService } from "../../services/openai.service";
import { STORAGE_TABLES, STORAGE_QUEUES, AI_CONFIG } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { 
  Message, 
  MessageRole, 
  ContextResult,
  MessageStatus,
  MessageType,
  IntegrationInfo,
  TempUserInfo,
  Conversation,
  UserContext
} from "../../models/conversation.model";
import { SearchQuery } from "../../models/search.model";
import {IntegrationStatus } from "../../models/integration.model";
import { DocumentSearchHandler } from "../knowledge/documentSearchHandler"; 

interface QueueMessage {
  messageId: string;
  conversationId: string;
  agentId: string;
  userId: string;
}

export class ContextRetrieverHandler {
  private storageService: StorageService;
  private openaiService: OpenAIService;
  private logger: Logger;
  private documentSearchHandler: DocumentSearchHandler;

  private maxContextMessages = 10;
  private maxRelevantChunks = 5;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.openaiService = new OpenAIService(logger);
    this.logger = logger || createLogger();
    this.documentSearchHandler = new DocumentSearchHandler(this.logger);
  }
  
  async execute(message: QueueMessage): Promise<void> {
    const { messageId, conversationId, agentId, userId } = message;
    
    try {
      const currentMessage = await this.getCurrentMessage(conversationId, messageId);
      if (!currentMessage) {
        throw createAppError(404, `Mensaje ${messageId} no encontrado`);
      }
      
      const conversationHistory = await this.getConversationHistory(conversationId);
      const systemInstructions = await this.getAgentSystemInstructions(agentId);
      const relevantChunks = await this.searchRelevantContent(agentId, currentMessage.content);
      const activeIntegrations = await this.getActiveIntegrations(agentId);
      
      // NUEVO: Extraer contexto de usuario desde WhatsApp
      const userContext = await this.extractUserContext(conversationId, agentId, currentMessage);
      
      const context: ContextResult = {
        relevantChunks,
        conversationContext: this.formatConversationContext(conversationHistory),
        systemInstructions,
        activeIntegrations,
        userContext // NUEVO
      };

      await this.queueForCompletion(context, messageId, conversationId, agentId, userId);

    } catch (error) {
      this.logger.error(`Error al procesar contexto para mensaje ${messageId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, `Error al procesar contexto: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // NUEVO: Extraer contexto de usuario desde WhatsApp
  private async extractUserContext(conversationId: string, agentId: string, currentMessage: Message): Promise<UserContext | undefined> {
    try {
        const conversation = await this.getConversation(conversationId, agentId);
        let userContext: UserContext | undefined;

        // Si el mensaje viene de WhatsApp
        if (currentMessage.metadata?.whatsapp) {
            const whatsappMeta = currentMessage.metadata.whatsapp;
            
            userContext = {
                whatsappNumber: whatsappMeta.from,
                // CAMBIO: NUNCA usar email/nombre persistido
                providedEmail: undefined, // Siempre undefined
                providedName: whatsappMeta.fromName, // Solo el nombre del perfil de WhatsApp
                sourceChannel: 'whatsapp',
                conversationId: conversationId
            };

            this.logger.info(`Contexto de usuario extraído: WhatsApp ${userContext.whatsappNumber}, Email: SIEMPRE_PREGUNTAR`);
        }

        return userContext;
    } catch (error) {
        this.logger.error(`Error extrayendo contexto de usuario:`, error);
        return undefined;
    }
  }

  private async getConversation(conversationId: string, agentId: string): Promise<Conversation | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
      const conversation = await tableClient.getEntity(agentId, conversationId);
      
      let tempUserInfo: TempUserInfo | undefined;
      if (conversation.tempUserInfo && typeof conversation.tempUserInfo === 'string') {
        try {
          tempUserInfo = JSON.parse(conversation.tempUserInfo);
        } catch (e) {
          this.logger.warn(`Error parseando tempUserInfo para conversación ${conversationId}:`, e);
        }
      }

      return {
        ...conversation,
        tempUserInfo
      } as unknown as Conversation;
    } catch (error) {
      this.logger.error(`Error al obtener conversación ${conversationId}:`, error);
      return null;
    }
  }

  private async getActiveIntegrations(agentId: string): Promise<IntegrationInfo[]> {
    const activeIntegrations: IntegrationInfo[] = [];
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      const integrations = tableClient.listEntities({
        queryOptions: {
          filter: `PartitionKey eq '${agentId}' and status eq '${IntegrationStatus.ACTIVE}' and isActive eq true`
        }
      });

      for await (const integration of integrations) {
        activeIntegrations.push({
          id: integration.id as string,
          name: integration.name as string,
          type: integration.type as string,
          provider: integration.provider as string,
        });
      }
      this.logger.debug(`Encontradas ${activeIntegrations.length} integraciones activas para el agente ${agentId}`);
    } catch (error) {
      this.logger.error(`Error al obtener integraciones activas para el agente ${agentId}:`, error);
    }
    return activeIntegrations;
  }
  
  private async getCurrentMessage(conversationId: string, messageId: string): Promise<Message | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
      const message = await tableClient.getEntity(conversationId, messageId);
      
      return message as unknown as Message;
    } catch (error) {
      this.logger.error(`Error al obtener mensaje ${messageId}:`, error);
      return null;
    }
  }
  
  private async getConversationHistory(conversationId: string): Promise<Message[]> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
      
      const messages: Message[] = [];
      const messagesEntities = await tableClient.listEntities({
        queryOptions: { 
          filter: `PartitionKey eq '${conversationId}' and status ne 'failed'`
        }
      });
      
      for await (const entity of messagesEntities) {
        const message: Message = {
          id: entity.id as string,
          conversationId: entity.conversationId as string,
          content: entity.content as string,
          role: entity.role as MessageRole,
          senderId: entity.senderId as string,
          timestamp: this.getNumberValue(entity.timestamp),
          responseTime: entity.responseTime as number,
          status: entity.status as MessageStatus,
          messageType: entity.messageType as MessageType,
          contentType: entity.contentType as string,
          attachments: entity.attachments as Record<string, any>,
          metadata: entity.metadata as Record<string, any>,
          createdAt: this.getNumberValue(entity.createdAt)
        };
        
        messages.push(message);
      }
      
      const sortedMessages = messages
        .sort((a, b) => {
          if (a.createdAt !== b.createdAt) {
            return a.createdAt - b.createdAt;
          }
          return a.timestamp - b.timestamp;
        })
        .slice(-this.maxContextMessages);
      
      this.logger.debug(`Recuperados ${sortedMessages.length} mensajes para conversación ${conversationId}`);
      
      return sortedMessages;
    } catch (error) {
      this.logger.error(`Error al obtener historial de conversación ${conversationId}:`, error);
      return [];
    }
  }
  
  private getNumberValue(value: unknown): number {
    if (typeof value === 'number') {
      return value;
    } else if (typeof value === 'string') {
      const num = parseInt(value, 10);
      return isNaN(num) ? Date.now() : num;
    } else if (value instanceof Date) {
      return value.getTime();
    }
    return Date.now();
  }
  
  private async getAgentSystemInstructions(agentId: string): Promise<string> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      const agent = await tableClient.getEntity('agent', agentId);
      
      return agent.systemInstructions as string || "";
    } catch (error) {
      this.logger.error(`Error al obtener instrucciones del agente ${agentId}:`, error);
      return "";
    }
  }
  
private async searchRelevantContent(agentId: string, query: string): Promise<Array<{
    content: string;
    documentId: string;
    chunkId: string;
    similarity: number;
}>> {
    try {
        // 🔥 NUEVO: FILTRAR CONFIRMACIONES Y MENSAJES CORTOS
        const cleanQuery = query.trim();
        
        // Lista de patrones que NO deben buscar en KB
        const skipKBPatterns = [
            /^(si|sí|no|ok|okay|dale|perfecto|correcto|adelante|cambiala|modificala|cancela)$/i,
            /^(yes|no|change it|modify it|cancel it|delete it|update it)$/i,
            /^(👍|👎|✅|❌)$/,
            /^[a-zA-Z\s]{1,5}$/,  // Mensajes muy cortos (1-5 caracteres de letras)
        ];
        
        // Verificar si debe saltarse la búsqueda en KB
        const shouldSkipKB = skipKBPatterns.some(pattern => pattern.test(cleanQuery));
        
        if (shouldSkipKB) {
            this.logger.info(`🚫 Saltando búsqueda en KB para confirmación/mensaje corto: "${cleanQuery}"`);
            return [];
        }
        
        // También saltar si es muy corto y no contiene información útil
        if (cleanQuery.length < 4) {
            this.logger.info(`🚫 Saltando búsqueda en KB para mensaje muy corto: "${cleanQuery}"`);
            return [];
        }

        const kbTableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
        let knowledgeBaseId: string | null = null;
        const kbs = await kbTableClient.listEntities({
            queryOptions: { filter: `PartitionKey eq '${agentId}' and isActive eq true` }
        });
        for await (const kb of kbs) {
            knowledgeBaseId = kb.id as string;
            break;
        }

        if (!knowledgeBaseId) {
            this.logger.warn(`No se encontró base de conocimiento activa para el agente ${agentId}`);
            return [];
        }

        this.logger.info(`🔍 Búsqueda en KB autorizada para: "${cleanQuery}"`);

        const searchParams: SearchQuery = {
            query: cleanQuery, // Usar la query limpia
            knowledgeBaseId,
            agentId,
            limit: this.maxRelevantChunks,
            threshold: 0.7,
            includeContent: true
        };

        const searchResults = await this.documentSearchHandler.execute(searchParams);

        return searchResults.results.map(result => ({
            content: result.content || "",
            documentId: result.documentId,
            chunkId: result.chunkId,
            similarity: result.similarity
        }));

    } catch (error) {
        this.logger.error(`Error al buscar contenido relevante para agente ${agentId} usando AI Search:`, error);
        return [];
    }
}
  
  private formatConversationContext(messages: Message[]): Array<{ role: MessageRole; content: string }> {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  }
  
  private async queueForCompletion(
    context: ContextResult,
    messageId: string,
    conversationId: string,
    agentId: string,
    userId: string
  ): Promise<void> {
    try {
      const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.COMPLETION);
      
      const completionRequest = {
        messageId,
        conversationId,
        agentId,
        userId,
        context
      };
      
      await queueClient.sendMessage(Buffer.from(JSON.stringify(completionRequest)).toString('base64'));
      
      this.logger.debug(`Mensaje ${messageId} encolado para generación de respuesta`);
    } catch (error) {
      this.logger.error(`Error al encolar mensaje ${messageId} para completación:`, error);
      throw createAppError(500, "Error al encolar para completación");
    }
  }

}