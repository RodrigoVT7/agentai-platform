// src/functions/knowledge/DocumentProcessor.ts
import { app, InvocationContext } from "@azure/functions";
import { DocumentProcessorHandler } from "../../shared/handlers/knowledge/documentProcessorHandler";
import { DocumentProcessingQueueMessage } from "../../shared/models/document.model";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";

export async function documentProcessor(queueItem: unknown, context: InvocationContext): Promise<void> {
  const logger = createLogger(context);
  
  try {
    // Verificar que el mensaje de la cola es válido
    const message = queueItem as DocumentProcessingQueueMessage;
    
    if (!message || !message.documentId || !message.knowledgeBaseId || !message.agentId) {
      logger.error("Mensaje de cola inválido", { message });
      return; // No podemos hacer nada más si el mensaje es inválido
    }
    
    logger.info(`Procesando documento ${message.documentId} para base de conocimiento ${message.knowledgeBaseId}`);
    
    // Procesar el documento
    const handler = new DocumentProcessorHandler(logger);
    const result = await handler.execute(message);
    
    logger.info(`Documento ${message.documentId} procesado correctamente. Generados ${result.chunks.length} chunks.`);
    
  } catch (error) {
    logger.error("Error al procesar documento:", error);
    
    // No relanzamos el error para no volver a poner el mensaje en la cola
    // En su lugar, lo manejamos aquí y lo registramos
    const appError = toAppError(error);
    
    logger.error(`Error al procesar documento: ${appError.message}`, {
      statusCode: appError.statusCode,
      details: appError.details
    });
  }
}

app.storageQueue('documentProcessor', {
  queueName: 'document-processing-queue',
  connection: 'AzureWebJobsStorage',
  handler: documentProcessor
});