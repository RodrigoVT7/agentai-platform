import { app, InvocationContext } from "@azure/functions";
import { N8nChatCompletionHandler } from "../../shared/handlers/conversation/n8nChatCompletionHandler";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { STORAGE_QUEUES } from "../../shared/constants";

export async function N8nChatCompletion(
  queueItem: unknown,
  context: InvocationContext
): Promise<void> {
  const logger = createLogger(context);
  logger.info(
    `N8nChatCompletion: FUNCIÓN ACTIVADA. InvocationId: ${
      context.invocationId
    }. Raw queueItem: ${JSON.stringify(queueItem)}`
  );

  try {
    // Verificar que el mensaje de la cola es válido
    const message = queueItem as any;

    if (
      !message ||
      !message.messageId ||
      !message.conversationId ||
      !message.agentId ||
      !message.context
    ) {
      logger.error("Mensaje de cola inválido", { message });
      return; // No podemos hacer nada más si el mensaje es inválido
    }

    // Obtener la URL del webhook de n8n de la configuración del agente
    const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;
    if (!n8nWebhookUrl) {
      throw new Error("N8N_WEBHOOK_URL environment variable is not set");
    }

    logger.info(
      `Generando respuesta para mensaje ${message.messageId} en conversación ${message.conversationId}`
    );

    // Generar respuesta
    const handler = new N8nChatCompletionHandler(n8nWebhookUrl, logger);
    await handler.execute(message);

    logger.info(
      `Respuesta generada exitosamente para mensaje ${message.messageId}`
    );
  } catch (error) {
    logger.error("Error al generar respuesta:", error);

    // No relanzamos el error para no volver a poner el mensaje en la cola
    // En su lugar, lo manejamos aquí y lo registramos
    const appError = toAppError(error);

    logger.error(`Error al generar respuesta: ${appError.message}`, {
      statusCode: appError.statusCode,
      details: appError.details,
    });
  }
}

app.storageQueue("N8nChatCompletion", {
  queueName: STORAGE_QUEUES.N8N_COMPLETION,
  connection: "AzureWebJobsStorage",
  handler: N8nChatCompletion,
});
