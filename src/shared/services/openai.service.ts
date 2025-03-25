// src/shared/services/openai.service.ts
// Importar sólo tipos que sabemos que existen, usando any para evitar problemas
import { Logger, createLogger } from "../utils/logger";
import { createAppError } from "../utils/error.utils";
import { AI_CONFIG } from "../constants";

type EmbeddingResponse = {
  data: Array<{
    embedding: number[];
    index: number;
    object: string;
  }>;
  model: string;
  object: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
};

type ChatCompletionResponse = {
  choices: Array<{
    message?: {
      content?: string;
      role: string;
    };
    index: number;
    finish_reason: string;
  }>;
  created: number;
  id: string;
  model: string;
  object: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export class OpenAIService {
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
  }
  
  /**
   * Genera un embedding utilizando el modelo de embedding de OpenAI
   * @param text Texto para el cual generar el embedding
   * @returns Vector de embedding
   */
  public async getEmbedding(text: string): Promise<number[]> {
    try {
      // Truncar texto si es demasiado largo
      const truncatedText = text.length > 8000 ? text.substring(0, 8000) : text;
      
      // Hacer la solicitud HTTP directamente sin usar el cliente
      const response = await fetch(`${this.endpoint}/openai/deployments/${AI_CONFIG.EMBEDDING_MODEL}/embeddings?api-version=2023-05-15`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey
        },
        body: JSON.stringify({
          input: [truncatedText]
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error en API de OpenAI: ${response.status} - ${errorText}`);
      }
      
      const data = await response.json() as EmbeddingResponse;
      
      // Registrar uso de tokens para monitoreo
      const tokensUsed = data.usage?.total_tokens || 0;
      this.logger.debug(`Embedding generado. Tokens usados: ${tokensUsed}`);
      
      if (!data.data || data.data.length === 0) {
        throw createAppError(500, 'No se recibió respuesta de embedding de OpenAI');
      }
      
      // Retornar el vector de embedding
      return data.data[0].embedding;
    } catch (error: unknown) {
      this.logger.error('Error al generar embedding con OpenAI:', error);
      
      // Manejar errores específicos de la API
      if (error && typeof error === 'object' && 'statusCode' in error && 
          (error as { statusCode?: number }).statusCode === 429) {
        throw createAppError(429, 'Límite de cuota excedido en Azure OpenAI');
      }
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al generar embedding: ${errorMessage}`);
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
      // Hacer la solicitud HTTP directamente sin usar el cliente
      const response = await fetch(`${this.endpoint}/openai/deployments/${AI_CONFIG.CHAT_MODEL}/chat/completions?api-version=2023-05-15`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey
        },
        body: JSON.stringify({
          messages: messages,
          temperature: temperature,
          max_tokens: maxTokens,
          n: 1
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error en API de OpenAI: ${response.status} - ${errorText}`);
      }
      
      const data = await response.json() as ChatCompletionResponse;
      
      // Registrar uso de tokens
      const tokensUsed = data.usage?.total_tokens || 0;
      this.logger.debug(`Chat completion generado. Tokens usados: ${tokensUsed}`);
      
      if (!data.choices || data.choices.length === 0) {
        throw createAppError(500, 'No se recibió respuesta de chat de OpenAI');
      }
      
      return data.choices[0].message?.content || '';
    } catch (error: unknown) {
      this.logger.error('Error al generar chat completion con OpenAI:', error);
      
      // Manejar errores específicos de la API
      if (error && typeof error === 'object' && 'statusCode' in error && 
          (error as { statusCode?: number }).statusCode === 429) {
        throw createAppError(429, 'Límite de cuota excedido en Azure OpenAI');
      }
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al generar respuesta: ${errorMessage}`);
    }
  }
}