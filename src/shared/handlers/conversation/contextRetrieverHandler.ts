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
  IntegrationInfo
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
  private documentSearchHandler: DocumentSearchHandler

  // Configuración para el contexto de la conversación
  private maxContextMessages = 10; // Últimos N mensajes a incluir
  private maxRelevantChunks = 5; // Máximos fragmentos de conocimiento a incluir
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.openaiService = new OpenAIService(logger);
    this.logger = logger || createLogger();
    this.documentSearchHandler = new DocumentSearchHandler(this.logger);
  }
  
  async execute(message: QueueMessage): Promise<void> {
    const { messageId, conversationId, agentId, userId } = message;
    
    try {
      // 1. Obtener el mensaje actual
      const currentMessage = await this.getCurrentMessage(conversationId, messageId);
      if (!currentMessage) {
        throw createAppError(404, `Mensaje ${messageId} no encontrado`);
      }
      
      // 2. Obtener historial de la conversación
      const conversationHistory = await this.getConversationHistory(conversationId);
      
      // 3. Obtener instrucciones del sistema del agente
      const systemInstructions = await this.getAgentSystemInstructions(agentId);
      
      // 4. Buscar contenido relevante en la base de conocimiento
      const relevantChunks = await this.searchRelevantContent(agentId, currentMessage.content);
      
       // 5. NUEVO: Obtener integraciones activas del agente
       const activeIntegrations = await this.getActiveIntegrations(agentId);

      // 6. Generar contexto completo (incluyendo integraciones)
      const context: ContextResult = {
        relevantChunks,
        conversationContext: this.formatConversationContext(conversationHistory),
        systemInstructions,
        activeIntegrations // <-- Añadido
      };

      // 7. Encolar para generación de respuesta
      await this.queueForCompletion(context, messageId, conversationId, agentId, userId);

      return;
    } catch (error) {
      this.logger.error(`Error al procesar contexto para mensaje ${messageId}:`, error);
      
      // Si es un error de nuestra aplicación, rethrow
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      // En otro caso, crear un AppError genérico
      throw createAppError(500, `Error al procesar contexto: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Obtiene las integraciones activas para un agente específico.
   */
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
      // No lanzar error, simplemente devolver lista vacía
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
      
      // Recuperar solo mensajes no fallidos
      const messages: Message[] = [];
      const messagesEntities = await tableClient.listEntities({
        queryOptions: { 
          filter: `PartitionKey eq '${conversationId}' and status ne 'failed'`
        }
      });
      
      for await (const entity of messagesEntities) {
        // Convertir entity a Message con validación de tipos
        const message: Message = {
          id: entity.id as string,
          conversationId: entity.conversationId as string,
          content: entity.content as string,
          role: entity.role as MessageRole,
          senderId: entity.senderId as string,
          // Asegurar que timestamp sea numérico
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
      
      // Ordenar con lógica mejorada - primero por createdAt, luego por timestamp
      const sortedMessages = messages
        .sort((a, b) => {
          // Si createdAt es diferente, ordenar por createdAt
          if (a.createdAt !== b.createdAt) {
            return a.createdAt - b.createdAt;
          }
          // Si createdAt es igual, ordenar por timestamp
          return a.timestamp - b.timestamp;
        })
        .slice(-this.maxContextMessages);
      
      this.logger.debug(`Recuperados ${sortedMessages.length} mensajes para conversación ${conversationId}`);
      
      // Registrar resumen de los mensajes para debugging
      this.logger.debug(`Secuencia de mensajes: ${sortedMessages.map(msg => 
        `${msg.id.substring(0,6)}(${msg.role})`).join(' -> ')}`);
      
      return sortedMessages;
    } catch (error) {
      this.logger.error(`Error al obtener historial de conversación ${conversationId}:`, error);
      return [];
    }
  }
  
  /**
   * Convierte cualquier valor a número de forma segura
   */
  private getNumberValue(value: unknown): number {
    if (typeof value === 'number') {
      return value;
    } else if (typeof value === 'string') {
      const num = parseInt(value, 10);
      return isNaN(num) ? Date.now() : num; // usar tiempo actual como fallback
    } else if (value instanceof Date) {
      return value.getTime();
    }
    return Date.now(); // valor por defecto si no se puede convertir
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
    similarity: number; // O score, dependiendo de lo que devuelvas
}>> {
    try {
        // 1. Obtener ID de la base de conocimiento activa (como antes)
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

        // 2. Realizar búsqueda usando el DocumentSearchHandler (que ahora usa AI Search)
        const searchParams: SearchQuery = {
            query,
            knowledgeBaseId,
            agentId, // Pasar agentId puede no ser estrictamente necesario si KB ID es único, pero bueno tenerlo
            limit: this.maxRelevantChunks,
            threshold: 0.7, // El threshold real se aplica ahora dentro del handler o post-búsqueda
            includeContent: true
        };

        // Llamar al handler actualizado
        const searchResults = await this.documentSearchHandler.execute(searchParams);

        // 3. Formatear resultados (adaptar si la estructura cambió)
        return searchResults.results.map(result => ({
            content: result.content || "",
            documentId: result.documentId,
            chunkId: result.chunkId,
             // Usa similarity o relevanceScore según lo que devuelva tu handler
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