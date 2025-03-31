// src/shared/handlers/conversation/chatCompletionHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { OpenAIService } from "../../services/openai.service";
import { STORAGE_TABLES, AI_CONFIG } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { 
  Message,
  MessageRole,
  MessageStatus,
  MessageType,
  ContextResult
} from "../../models/conversation.model";

interface CompletionRequest {
  messageId: string;
  conversationId: string;
  agentId: string;
  userId: string;
  context: ContextResult;
}

export class ChatCompletionHandler {
  private storageService: StorageService;
  private openaiService: OpenAIService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.openaiService = new OpenAIService(logger);
    this.logger = logger || createLogger();
  }
  
  async execute(request: CompletionRequest): Promise<void> {
    const { messageId, conversationId, agentId, userId, context } = request;
    
    try {
      // 1. Obtener la configuración del agente
      const agentConfig = await this.getAgentConfig(agentId);
      
      // 2. Preparar mensajes para OpenAI
      const messages = this.prepareCompletionMessages(context);
      
      // 3. Medir tiempo de inicio para calcular tiempo de respuesta
      const startTime = Date.now();
      
      // 4. Llamar a OpenAI para generar respuesta
      const response = await this.openaiService.getChatCompletion(
        messages,
        agentConfig.temperature || AI_CONFIG.TEMPERATURE,
        agentConfig.maxTokens || AI_CONFIG.MAX_TOKENS
      );
      
      // 5. Calcular tiempo de respuesta
      const responseTime = Date.now() - startTime;
      
      // 6. Guardar respuesta como nuevo mensaje
      await this.saveAssistantMessage(
        conversationId, 
        agentId, 
        response, 
        responseTime
      );
      
      // 7. Actualizar mensaje original a DELIVERED
      await this.updateMessageStatus(conversationId, messageId, MessageStatus.DELIVERED);
      
      // 8. Actualizar estadísticas de uso
      await this.updateUsageStats(agentId, userId, messages.length, response.length);
      
      return;
    } catch (error) {
      this.logger.error(`Error al generar respuesta para mensaje ${messageId}:`, error);
      
      // Actualizar estado del mensaje a FAILED
      await this.updateMessageStatus(conversationId, messageId, MessageStatus.FAILED);
      
      // Si es un error de nuestra aplicación, rethrow
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      // En otro caso, crear un AppError genérico
      throw createAppError(500, `Error al generar respuesta: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  private async getAgentConfig(agentId: string): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      const agent = await tableClient.getEntity('agent', agentId);
      
      return {
        temperature: agent.temperature as number,
        maxTokens: agent.maxTokens as number,
        modelType: agent.modelType as string,
        modelConfig: agent.modelConfig || {}
      };
    } catch (error) {
      this.logger.error(`Error al obtener configuración del agente ${agentId}:`, error);
      return {
        temperature: AI_CONFIG.TEMPERATURE,
        maxTokens: AI_CONFIG.MAX_TOKENS,
        modelType: AI_CONFIG.CHAT_MODEL
      };
    }
  }
  
  private prepareCompletionMessages(context: ContextResult): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    
    // 1. Añadir instrucciones del sistema
    if (context.systemInstructions) {
      let systemContent = context.systemInstructions;
      
      // Añadir información del conocimiento relevante si existe
      if (context.relevantChunks && context.relevantChunks.length > 0) {
        systemContent += "\n\nA continuación hay información relevante que puedes usar para responder:\n\n";
        context.relevantChunks.forEach((chunk, index) => {
          systemContent += `[DOCUMENTO ${index + 1}]\n${chunk.content}\n\n`;
        });
      }
      
      messages.push({
        role: 'system',
        content: systemContent
      });
    }
    
    // 2. Añadir contexto de la conversación
    if (context.conversationContext && context.conversationContext.length > 0) {
      context.conversationContext.forEach(msg => {
        messages.push({
          // Convertir roles internos a los que espera OpenAI
          role: this.mapRoleToOpenAI(msg.role), 
          content: msg.content
        });
      });
    }
    
    return messages;
  }
  
  private mapRoleToOpenAI(role: MessageRole): "system" | "user" | "assistant" {
    switch (role) {
      case MessageRole.SYSTEM:
        return 'system';
      case MessageRole.ASSISTANT:
        return 'assistant';
      case MessageRole.USER:
      case MessageRole.HUMAN_AGENT:
        return 'user'; // Los mensajes de agentes humanos se muestran como usuarios a OpenAI
      default:
        return 'user';
    }
  }
  
  private async saveAssistantMessage(
    conversationId: string, 
    agentId: string, 
    content: string, 
    responseTime: number
  ): Promise<void> {
    try {
      const messageId = uuidv4();
      const now = Date.now();
      
      const newMessage: Message = {
        id: messageId,
        conversationId,
        content,
        role: MessageRole.ASSISTANT,
        senderId: agentId, // El remitente es el agente
        timestamp: now,
        responseTime,
        status: MessageStatus.SENT,
        messageType: MessageType.TEXT,
        createdAt: now
      };
      
      // Guardar en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
      await tableClient.createEntity({
        partitionKey: conversationId,
        rowKey: messageId,
        ...newMessage
      });
      
      this.logger.debug(`Respuesta guardada como mensaje ${messageId}`);
    } catch (error) {
      this.logger.error(`Error al guardar mensaje de asistente:`, error);
      throw createAppError(500, "Error al guardar respuesta");
    }
  }
  
  private async updateMessageStatus(conversationId: string, messageId: string, status: MessageStatus): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
      
      await tableClient.updateEntity({
        partitionKey: conversationId,
        rowKey: messageId,
        status
      }, "Merge");
      
      this.logger.debug(`Estado del mensaje ${messageId} actualizado a ${status}`);
    } catch (error) {
      this.logger.warn(`Error al actualizar estado del mensaje ${messageId}:`, error);
      // No propagar error para no interrumpir flujo principal
    }
  }
  
  private async updateUsageStats(agentId: string, userId: string, inputTokens: number, outputLength: number): Promise<void> {
    try {
      // Estimación aproximada de tokens
      const outputTokens = Math.ceil(outputLength / 4); // ~4 caracteres por token
      
      // Generar clave para el registro de estadísticas (por día)
      const today = new Date();
      const yearMonth = `${today.getFullYear()}${(today.getMonth() + 1).toString().padStart(2, '0')}`;
      const day = today.getDate().toString().padStart(2, '0');
      const statId = `${yearMonth}${day}`;
      
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USAGE_STATS);
      
      // Intentar actualizar estadística existente
      try {
        // Primero intentamos obtener para ver si existe
        const existingStat = await tableClient.getEntity(userId, `${agentId}_${statId}`);
        
        // Si existe, actualizamos con conversión explícita de tipos
        await tableClient.updateEntity({
          partitionKey: userId,
          rowKey: `${agentId}_${statId}`,
          inputTokens: ((existingStat.inputTokens as number) || 0) + inputTokens,
          outputTokens: ((existingStat.outputTokens as number) || 0) + outputTokens,
          processedMessages: ((existingStat.processedMessages as number) || 0) + 1,
          updatedAt: Date.now()
        }, "Merge");
      } catch (error) {
        // Si no existe, creamos nueva estadística
        await tableClient.createEntity({
          partitionKey: userId,
          rowKey: `${agentId}_${statId}`,
          userId,
          agentId,
          period: 'daily',
          startDate: new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime(),
          endDate: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime() - 1,
          inputTokens: inputTokens,
          outputTokens: outputTokens,
          processedMessages: 1,
          createdAt: Date.now()
        });
      }
    } catch (error) {
      this.logger.warn(`Error al actualizar estadísticas de uso:`, error);
      // No propagar error para no interrumpir flujo principal
    }
  }
}