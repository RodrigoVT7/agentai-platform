// src/functions/knowledge/EmbeddingGenerator.ts
import { app, InvocationContext } from "@azure/functions";
import { EmbeddingGeneratorHandler } from "../../shared/handlers/knowledge/embeddingGeneratorHandler";
import { EmbeddingQueueMessage } from "../../shared/models/documentProcessor.model";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";

export async function embeddingGenerator(queueItem: unknown, context: InvocationContext): Promise<void> {
  const logger = createLogger(context);
  
  try {
    // Verificar que el mensaje de la cola es válido
    const message = queueItem as EmbeddingQueueMessage;
    
    if (!message || !message.chunkId || !message.documentId || !message.knowledgeBaseId || !message.content) {
      logger.error("Mensaje de cola inválido", { message });
      return; // No podemos hacer nada más si el mensaje es inválido
    }
    
    logger.info(`Generando embedding para chunk ${message.chunkId} del documento ${message.documentId}`);
    
    // Procesar el chunk
    const handler = new EmbeddingGeneratorHandler(logger);
    const result = await handler.execute(message);
    
    if (result.success) {
      logger.info(`Embedding generado correctamente para chunk ${message.chunkId}`);
    } else {
      logger.error(`Error al generar embedding para chunk ${message.chunkId}: ${result.error}`);
    }
    
  } catch (error) {
    logger.error("Error al generar embedding:", error);
    
    // No relanzamos el error para no volver a poner el mensaje en la cola
    // En su lugar, lo manejamos aquí y lo registramos
    const appError = toAppError(error);
    
    logger.error(`Error al generar embedding: ${appError.message}`, {
      statusCode: appError.statusCode,
      details: appError.details
    });
  }
}

app.storageQueue('embeddingGenerator', {
  queueName: 'embedding-queue',
  connection: 'AzureWebJobsStorage',
  handler: embeddingGenerator
});