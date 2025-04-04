// src/functions/integrations/IntegrationExecutor.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { IntegrationExecutorHandler } from "../../shared/handlers/integrations/integrationExecutorHandler";
import { IntegrationExecutorValidator } from "../../shared/validators/integrations/integrationExecutorValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function IntegrationExecutor(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Crear handler y validator
    const handler = new IntegrationExecutorHandler(logger);
    const validator = new IntegrationExecutorValidator(logger);
    
    // Para ejecutar una integración, solo se acepta POST
    if (request.method !== 'POST') {
      return {
        status: 405,
        jsonBody: { error: "Método no permitido. Usar POST para ejecutar integraciones" }
      };
    }
    
    // Obtener datos del cuerpo
    const executionData = await request.json();
    
    // Validar datos
    const validation = await validator.validate(executionData, userId);
    if (!validation.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validation.errors }
      };
    }
    
    // Ejecutar integración
    const result = await handler.execute(executionData, userId);
    
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al ejecutar integración:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

// También maneja mensajes de cola para ejecuciones asíncronas
export async function IntegrationExecutorQueue(queueItem: unknown, context: InvocationContext): Promise<void> {
  const logger = createLogger(context);
  
  try {
    // Verificar que el mensaje de la cola es válido
    const message = queueItem as any;
    
    if (!message || !message.integrationId || !message.action || !message.userId) {
      logger.error("Mensaje de cola inválido", { message });
      return;
    }
    
    logger.info(`Ejecutando integración: ${message.integrationId}, acción: ${message.action}`);
    
    // Ejecutar integración
    const handler = new IntegrationExecutorHandler(logger);
    await handler.executeFromQueue(message);
    
    logger.info(`Integración ejecutada con éxito: ${message.integrationId}`);
  } catch (error) {
    logger.error("Error al ejecutar integración desde cola:", error);
  }
}

app.http('IntegrationExecutor', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'integrations/execute',
  handler: IntegrationExecutor
});

app.storageQueue('IntegrationExecutorQueue', {
  queueName: 'integration-queue',
  connection: 'AzureWebJobsStorage',
  handler: IntegrationExecutorQueue
});