// src/shared/services/openai.service.ts
import { OpenAIClient, AzureKeyCredential } from "@azure/openai";
import { Logger, createLogger } from "../utils/logger";
import { createAppError } from "../utils/error.utils";
import { AI_CONFIG } from "../constants";

export class OpenAIService {
  private client: OpenAIClient;
  private logger: Logger;
  private endpoint: string;
  private apiKey: string;
  
  constructor(logger?: Logger) {
    this.logger = logger || createLogger();
    this.endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
    this.apiKey = process.env.AZURE_OPENAI_API_KEY || '';
    
    if (!this.endpoint || !this.apiKey) {
      this.logger.error('Azure OpenAI credentials no configuradas correctamente');
      throw createAppError(500, 'Servicio de IA no configurado correctamente');
    }
    
    this.client = new OpenAIClient(
      this.endpoint,
      new AzureKeyCredential(this.apiKey)
    );
  }
  
  /**
   * Genera un embedding utilizando el modelo de embedding de OpenAI
   * @param text Texto para el cual generar el embedding
   * @returns Vector de embedding
   */
  public async getEmbedding(text: string): Promise<number[]> {
    try {
      // Truncar texto si es demasiado largo
      // La API de OpenAI tiene límites, así que nos aseguramos de no excederlos
      const truncatedText = text.length > 8000 ? text.substring(0, 8000) : text;
      
      const response = await this.client.getEmbeddings(
        AI_CONFIG.EMBEDDING_MODEL,
        [truncatedText]
      );
      
      // Registrar uso de tokens para monitoreo
      const tokensUsed = response.usage?.totalTokens || 0;
      this.logger.debug(`Embedding generado. Tokens usados: ${tokensUsed}`);
      
      if (!response.data || response.data.length === 0) {
        throw createAppError(500, 'No se recibió respuesta de embedding de OpenAI');
      }
      
      // Retornar el vector de embedding
      return response.data[0].embedding;
    } catch (error) {
      this.logger.error('Error al generar embedding con OpenAI:', error);
      
      // Manejar errores específicos de la API
      if (error.statusCode === 429) {
        throw createAppError(429, 'Límite de cuota excedido en Azure OpenAI');
      }
      
      throw createAppError(500, `Error al generar embedding: ${error.message}`);
    }
  }
  
  /**
   * Genera una respuesta de chat utilizando el modelo de chat de OpenAI
   * @param messages Mensajes de la conversación
   * @param temperature Temperatura para generación (0-1)
   * @param maxTokens Máximo de tokens a generar
   * @returns Texto de respuesta
   */
  public async getChatCompletion(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    temperature: number = AI_CONFIG.TEMPERATURE,
    maxTokens: number = AI_CONFIG.MAX_TOKENS
  ): Promise<string> {
    try {
      const response = await this.client.getChatCompletions(
        AI_CONFIG.CHAT_MODEL,
        messages,
        { temperature, maxTokens }
      );
      
      // Registrar uso de tokens
      const tokensUsed = response.usage?.totalTokens || 0;
      this.logger.debug(`Chat completion generado. Tokens usados: ${tokensUsed}`);
      
      if (!response.choices || response.choices.length === 0) {
        throw createAppError(500, 'No se recibió respuesta de chat de OpenAI');
      }
      
      return response.choices[0].message?.content || '';
    } catch (error) {
      this.logger.error('Error al generar chat completion con OpenAI:', error);
      
      // Manejar errores específicos de la API
      if (error.statusCode === 429) {
        throw createAppError(429, 'Límite de cuota excedido en Azure OpenAI');
      }
      
      throw createAppError(500, `Error al generar respuesta: ${error.message}`);
    }
  }
}