// src/functions/conversation/MessageReceiver.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { MessageReceiverHandler } from "../../shared/handlers/conversation/messageReceiverHandler";
import { MessageReceiverValidator } from "../../shared/validators/conversation/messageReceiverValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { MessageRequest } from "../../shared/models/conversation.model";

export async function MessageReceiver(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Obtener datos del cuerpo con tipado explícito
    const messageData = await request.json() as MessageRequest;
    
    // Validar datos
    const validator = new MessageReceiverValidator(logger);
    const validationResult = await validator.validate(messageData);
    
    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }
    
    // Procesar mensaje
    const handler = new MessageReceiverHandler(logger);
    const result = await handler.execute(messageData, userId);
    
    return {
      status: 201,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al procesar mensaje:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('MessageReceiver', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'conversation/messages',
  handler: MessageReceiver
});