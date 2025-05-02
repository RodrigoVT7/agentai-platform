// src/functions/conversation/MessageSender.ts
import { app, InvocationContext } from "@azure/functions";
import { MessageSenderHandler } from "../../shared/handlers/conversation/messageSenderHandler";
import { createLogger } from "../../shared/utils/logger";
import { STORAGE_QUEUES } from "../../shared/constants/index";

export async function MessageSender(
  queueItem: unknown,
  context: InvocationContext
): Promise<void> {
  const logger = createLogger(context);

  try {
    // Validar que el mensaje de la cola es válido
    const messagePayload = queueItem as any; // TODO: Definir una interfaz fuerte para SendMessageQueuePayload
    if (
      !messagePayload ||
      !messagePayload.conversationId ||
      !messagePayload.messageToSendId ||
      !messagePayload.agentId ||
      !messagePayload.recipientId
    ) {
      logger.error("Mensaje de cola inválido para MessageSender", {
        messagePayload,
      });
      return; // Descartar mensaje inválido
    }

    logger.info(
      `MessageSender procesando mensaje para enviar: ${messagePayload.messageToSendId}`
    );

    const handler = new MessageSenderHandler(logger);
    await handler.execute(messagePayload);

    logger.info(
      `MessageSender completó el procesamiento para ${messagePayload.messageToSendId}`
    );
  } catch (error) {
    logger.error("Error fatal en la función MessageSender:", error);
    // Considera si necesitas relanzar el error para que Azure Functions lo reintente
    // Si el error es por ej. "integración no encontrada", reintentar no ayudará
    // throw error; // Descomenta si quieres reintentos automáticos
  }
}

app.storageQueue("MessageSender", {
  queueName: STORAGE_QUEUES.SEND_MESSAGE, // Usar la nueva cola
  connection: "AzureWebJobsStorage", // Asegúrate que esta conexión esté configurada
  handler: MessageSender,
});
