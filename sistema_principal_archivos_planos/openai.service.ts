// src/shared/services/openai.service.ts
import { Logger, createLogger } from "../utils/logger";
import { createAppError } from "../utils/error.utils";
import { AI_CONFIG } from "../constants";
import fetch from "node-fetch"; // Asegúrate de tener node-fetch instalado o usa el fetch nativo si tu entorno lo soporta

// --- Tipos para la API de OpenAI con Tool Calling ---

// Definición de una herramienta (función) que el modelo puede llamar
export interface OpenAITool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, any>; // JSON Schema para los parámetros
    };
}

// Estructura de una llamada a herramienta solicitada por el modelo
export interface OpenAIToolCall {
    id: string; // ID único para la llamada, necesario si devuelves el resultado
    type: "function";
    function: {
        name: string;
        arguments: string; // Argumentos como string JSON
    };
}

// Estructura de la respuesta de Chat Completion cuando hay llamadas a herramientas
interface ChatCompletionResponseWithTools {
    choices: Array<{
        message?: {
            content?: string | null; // Puede ser null si solo hay tool_calls
            role: string;
            tool_calls?: OpenAIToolCall[]; // Array de llamadas a herramientas
        };
        index: number;
        finish_reason: string | 'tool_calls'; // Nuevo finish_reason posible
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
}

// --- Tipos para el retorno del servicio ---
export interface ChatCompletionResult {
    content: string | null;
    toolCalls: OpenAIToolCall[] | null;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}


// --- Definición de EmbeddingResponse (sin cambios) ---
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


export class OpenAIService {
  private logger: Logger;
  private endpoint: string;
  private apiKey: string;
  private EmbeddingsEndpoint: string;
  private EmbeddingsapiKey: string;


  constructor(logger?: Logger) {
    this.logger = logger || createLogger();
    this.endpoint = process.env.OPENAI_ENDPOINT || '';
    this.apiKey = process.env.OPENAI_API_KEY || '';
    this.EmbeddingsEndpoint = process.env.AZURE_EMBEDDINGS_ENDPOINT || '';
    this.EmbeddingsapiKey = process.env.AZURE_EMBEDDINGS_API_KEY || '';

    if (!this.endpoint || !this.apiKey) {
      this.logger.error('Azure OpenAI credentials no configuradas correctamente');
      throw createAppError(500, 'Servicio de IA no configurado correctamente');
    }
     if (!this.EmbeddingsEndpoint || !this.EmbeddingsapiKey) {
       this.logger.warn('Azure OpenAI Embeddings credentials no configuradas correctamente. La generación de embeddings fallará.');
       // No lanzar error aquí necesariamente, puede que solo se use chat
     }
  }

  public async getEmbedding(text: string): Promise<number[]> {
     if (!this.EmbeddingsEndpoint || !this.EmbeddingsapiKey) {
          this.logger.error('Embeddings no configurado. No se puede generar embedding.');
          throw createAppError(500, 'Servicio de Embeddings no configurado.');
     }
    try {
      const truncatedText = text.length > 8000 ? text.substring(0, 8000) : text;

      const response = await fetch(`${this.EmbeddingsEndpoint}/openai/deployments/${AI_CONFIG.EMBEDDING_MODEL}/embeddings?api-version=2023-05-15`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.EmbeddingsapiKey
        },
        body: JSON.stringify({
          input: [truncatedText] // Asegúrate de que sea un array, incluso si solo hay un texto
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Error en API de OpenAI Embeddings: ${response.status} - ${errorText}`);
        throw new Error(`Error en API de OpenAI Embeddings: ${response.status}`);
      }

      const data = await response.json() as EmbeddingResponse;

      const tokensUsed = data.usage?.total_tokens || 0;
      this.logger.debug(`Embedding generado. Tokens usados: ${tokensUsed}`);

      if (!data.data || data.data.length === 0 || !data.data[0].embedding) {
        throw createAppError(500, 'Respuesta inválida de embedding de OpenAI');
      }

      return data.data[0].embedding;
    } catch (error: unknown) {
      this.logger.error('Error al generar embedding con OpenAI:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      // No relanzar como AppError 429 aquí, dejar que el llamador lo maneje si es necesario
      throw new Error(`Error al generar embedding: ${errorMessage}`);
    }
  }

  /**
   * Genera una respuesta de chat, potencialmente incluyendo llamadas a herramientas.
   * @param messages Mensajes de la conversación
   * @param tools (Opcional) Array de definiciones de herramientas disponibles
   * @param temperature Temperatura para generación (0-1)
   * @param maxTokens Máximo de tokens a generar
   * @returns Objeto con contenido de texto y/o llamadas a herramientas
   */
  public async getChatCompletionWithTools(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | null }>,
    tools?: OpenAITool[], // Parámetro opcional para herramientas
    temperature: number = AI_CONFIG.TEMPERATURE,
    maxTokens: number = AI_CONFIG.MAX_TOKENS
  ): Promise<ChatCompletionResult> { // Cambiado el tipo de retorno
    try {
      const requestBody: any = {
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens,
        n: 1
      };

      // Añadir herramientas y forzar selección si se proporcionan
      if (tools && tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = "auto"; // O un tool específico si se necesita forzar
        this.logger.debug('Enviando solicitud a OpenAI con herramientas:', tools.map(t => t.function.name));
      }

      const response = await fetch(`${this.endpoint}/openai/deployments/${AI_CONFIG.CHAT_MODEL}/chat/completions?api-version=2025-01-01-preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Error en API de OpenAI Chat: ${response.status} - ${errorText}`);
        throw new Error(`Error en API de OpenAI Chat: ${response.status}`);
      }

      const data = await response.json() as ChatCompletionResponseWithTools;

      const tokensUsed = data.usage?.total_tokens || 0;
      this.logger.debug(`Chat completion recibido. Tokens usados: ${tokensUsed}. Finish Reason: ${data.choices[0]?.finish_reason}`);

      if (!data.choices || data.choices.length === 0) {
        throw createAppError(500, 'No se recibió respuesta de chat de OpenAI');
      }

      const choice = data.choices[0];
      const message = choice.message;

      // Devolver tanto el contenido como las llamadas a herramientas
      return {
          content: message?.content ?? null, // Contenido textual (puede ser null)
          toolCalls: message?.tool_calls ?? null, // Llamadas a herramientas (puede ser null)
          usage: data.usage
      };

    } catch (error: unknown) {
      this.logger.error('Error al generar chat completion con OpenAI:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      // No relanzar como AppError 429 aquí
      throw new Error(`Error al generar respuesta de chat: ${errorMessage}`);
    }
  }

  private sanitizeJsonResponse(content: string): string {
  if (!content) return content;
  
  try {
    // Remover markdown code blocks
    let cleaned = content.replace(/```json\s*/g, '').replace(/```\s*$/g, '');
    
    // Remover backticks sueltos al inicio y final
    cleaned = cleaned.replace(/^`+|`+$/g, '');
    
    // Remover backticks en el medio del texto
    cleaned = cleaned.replace(/`/g, '');
    
    // Trim whitespace
    cleaned = cleaned.trim();
    
    // Verificar que empiece y termine como JSON válido
    if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
      // Buscar el primer { o [
      const jsonStart = Math.max(cleaned.indexOf('{'), cleaned.indexOf('['));
      if (jsonStart > -1) {
        cleaned = cleaned.substring(jsonStart);
      }
    }
    
    if (!cleaned.endsWith('}') && !cleaned.endsWith(']')) {
      // Buscar el último } o ]
      const jsonEnd = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
      if (jsonEnd > -1) {
        cleaned = cleaned.substring(0, jsonEnd + 1);
      }
    }
    
    return cleaned;
  } catch (error) {
    this.logger.warn('Error sanitizando respuesta JSON:', error);
    return content;
  }
}
}