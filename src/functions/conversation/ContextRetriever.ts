// src/functions/conversation/ContextRetriever.ts
import { app, InvocationContext } from "@azure/functions";
import { ContextRetrieverHandler } from "../../shared/handlers/conversation/contextRetrieverHandler";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";

export async function ContextRetriever(queueItem: unknown, context: InvocationContext): Promise<void> {
  const logger = createLogger(context);
  
  try {
    // Verificar que el mensaje de la cola es válido
    const message = queueItem as any;
    
    if (!message || !message.messageId || !message.conversationId || !message.agentId) {
      logger.error("Mensaje de cola inválido", { message });
      return; // No podemos hacer nada más si el mensaje es inválido
    }
    
    logger.info(`Procesando contexto para mensaje ${message.messageId} en conversación ${message.conversationId}`);
    
    // Obtener contexto para el mensaje
    const handler = new ContextRetrieverHandler(logger);
    const result = await handler.execute(message);
    
    logger.info(`Contexto generado para mensaje ${message.messageId}. Encolado para respuesta.`);
    
  } catch (error) {
    logger.error("Error al procesar contexto:", error);
    
    // No relanzamos el error para no volver a poner el mensaje en la cola
    // En su lugar, lo manejamos aquí y lo registramos
    const appError = toAppError(error);
    
    logger.error(`Error al procesar contexto: ${appError.message}`, {
      statusCode: appError.statusCode,
      details: appError.details
    });
  }
}

app.storageQueue('ContextRetriever', {
  queueName: 'conversation-queue',
  connection: 'AzureWebJobsStorage',
  handler: ContextRetriever
});