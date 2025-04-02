// src/functions/playground/PlaygroundSession.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../shared/services/storage.service";
import { JwtService } from "../../shared/utils/jwt.service";
import { STORAGE_TABLES } from "../../shared/constants"; 
import { Logger, createLogger } from "../../shared/utils/logger";
import { createAppError } from "../../shared/utils/error.utils";
import { MessageReceiverHandler } from "../../shared/handlers/conversation/messageReceiverHandler";
import { MessageType, MessageRole } from "../../shared/models/conversation.model";

// Definir interfaz para la solicitud del playground
interface PlaygroundRequest {
  agentId: string;
  message: string;
  conversationId?: string;
  waitForResponse?: boolean;
}

export async function playgroundSession(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);
  
  try {
    // Verificar autenticación
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        status: 401,
        jsonBody: { error: "Se requiere autenticación" }
      };
    }
    
    // Extraer y verificar token
    const token = authHeader.split(' ')[1];
    const jwtService = new JwtService();
    
    let payload;
    try {
      payload = jwtService.verifyToken(token);
    } catch (error) {
      return {
        status: 401,
        jsonBody: { error: "Token inválido o expirado" }
      };
    }
    
    const userId = payload.userId;
    if (!userId) {
      return {
        status: 401,
        jsonBody: { error: "Token no contiene userId" }
      };
    }
    
    // Obtener datos del cuerpo con tipo correcto
    const data = await request.json() as PlaygroundRequest;
    const { agentId, message, conversationId, waitForResponse = true } = data;
    
    if (!agentId) {
      return {
        status: 400,
        jsonBody: { error: "Se requiere agentId" }
      };
    }
    
    if (!message) {
      return {
        status: 400,
        jsonBody: { error: "Se requiere mensaje" }
      };
    }
    
    // Usar MessageReceiverHandler existente para procesar el mensaje
    const messageHandler = new MessageReceiverHandler(logger);
    
    // Preparar el mensaje con metadata de playground
    const messageRequest = {
      agentId,
      conversationId, // Opcional, si se quiere continuar una conversación
      content: message,
      messageType: MessageType.TEXT,
      sourceChannel: 'playground',
      metadata: {
        directProcessing: true,
        isTest: true,
        testTimestamp: Date.now()
      }
    };
    
    // Procesar mensaje y obtener respuesta
    const result = await messageHandler.execute(messageRequest, userId);
    
    // Si se solicita esperar por respuesta
    let responseMessage = null;
    if (waitForResponse) {
      responseMessage = await waitForResponseMessage(result.conversationId, logger);
    }
    
    return {
      status: 200,
      jsonBody: {
        success: true,
        conversationId: result.conversationId,
        messageId: result.messageId,
        botResponse: responseMessage ? {
          messageId: responseMessage.id,
          content: responseMessage.content,
          timestamp: responseMessage.timestamp
        } : null,
        note: responseMessage ? 'Respuesta completa' : 'En procesamiento, consulte el historial para ver la respuesta'
      }
    };
  } catch (error) {
    logger.error("Error en playground:", error);
    
    const appError = createAppError(500, "Error en procesamiento de playground", error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

async function waitForResponseMessage(conversationId: string, logger: Logger, maxAttempts = 10): Promise<any> {
  // Función para esperar y consultar si hay respuesta
  const storageService = new StorageService();
  const tableClient = storageService.getTableClient(STORAGE_TABLES.MESSAGES);
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Esperar entre intentos
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      // Buscar mensajes del bot en esta conversación
      const messages = await tableClient.listEntities({
        queryOptions: { 
          filter: `PartitionKey eq '${conversationId}' and role eq '${MessageRole.ASSISTANT}'` 
        }
      });
      
      // Crear un array con todos los mensajes
      const assistantMessages = [];
      for await (const message of messages) {
        assistantMessages.push(message);
      }
      
      // Si encontramos algún mensaje del asistente, devolver el más reciente
      if (assistantMessages.length > 0) {
        // Ordenar por timestamp (más reciente primero)
        assistantMessages.sort((a, b) => {
          // Manejar correctamente todos los tipos posibles
          const timestampA = typeof a.timestamp === 'string' 
                             ? parseInt(a.timestamp) 
                             : (typeof a.timestamp === 'number' ? a.timestamp : 0);
          
          const timestampB = typeof b.timestamp === 'string' 
                             ? parseInt(b.timestamp) 
                             : (typeof b.timestamp === 'number' ? b.timestamp : 0);
          
          return timestampB - timestampA;
        });
        
        logger.info(`Mensaje del bot encontrado en intento ${attempt + 1}`);
        return assistantMessages[0];
      }
      
      logger.debug(`Intento ${attempt + 1}: Aún no hay respuesta`);
    } catch (error) {
      logger.warn(`Error al buscar respuesta en intento ${attempt + 1}:`, error);
    }
  }
  
  logger.warn(`No se encontró respuesta después de ${maxAttempts} intentos`);
  return null;
}

app.http('PlaygroundSession', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'playground/session',
  handler: playgroundSession
});