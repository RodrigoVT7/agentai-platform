// src/functions/conversation/FeedbackProcessor.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { FeedbackProcessorHandler } from "../../shared/handlers/conversation/feedbackProcessorHandler";
import { FeedbackProcessorValidator } from "../../shared/validators/conversation/feedbackProcessorValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function FeedbackProcessor(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Obtener parámetros
    const messageId = request.params.messageId;
    
    if (!messageId) {
      return {
        status: 400,
        jsonBody: { error: "Se requiere ID del mensaje" }
      };
    }
    
    // Obtener datos del feedback
    const feedbackData = await request.json();
    
    // Validar datos
    const validator = new FeedbackProcessorValidator(logger);
    const validationResult = await validator.validate(feedbackData);
    
    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }
    
    // Procesar feedback
    const handler = new FeedbackProcessorHandler(logger);
    const result = await handler.execute(messageId, userId, feedbackData);
    
    return {
      status: 201,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al procesar feedback:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('FeedbackProcessor', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'conversation/messages/{messageId}/feedback',
  handler: FeedbackProcessor
});