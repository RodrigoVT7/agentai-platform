// src/functions/conversation/ChatCompletion.ts
import { app, InvocationContext } from "@azure/functions";
import { ChatCompletionHandler } from "../../shared/handlers/conversation/chatCompletionHandler";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";

export async function ChatCompletion(queueItem: unknown, context: InvocationContext): Promise<void> {
  const logger = createLogger(context);
  
  try {
    // Verificar que el mensaje de la cola es válido
    const message = queueItem as any;
    
    if (!message || !message.messageId || !message.conversationId || !message.agentId || !message.context) {
      logger.error("Mensaje de cola inválido", { message });
      return; // No podemos hacer nada más si el mensaje es inválido
    }
    
    logger.info(`Generando respuesta para mensaje ${message.messageId} en conversación ${message.conversationId}`);
    
    // Generar respuesta
    const handler = new ChatCompletionHandler(logger);
    const result = await handler.execute(message);
    
    logger.info(`Respuesta generada exitosamente para mensaje ${message.messageId}`);
    
  } catch (error) {
    logger.error("Error al generar respuesta:", error);
    
    // No relanzamos el error para no volver a poner el mensaje en la cola
    // En su lugar, lo manejamos aquí y lo registramos
    const appError = toAppError(error);
    
    logger.error(`Error al generar respuesta: ${appError.message}`, {
      statusCode: appError.statusCode,
      details: appError.details
    });
  }
}

app.storageQueue('ChatCompletion', {
  queueName: 'completion-queue',
  connection: 'AzureWebJobsStorage',
  handler: ChatCompletion
});