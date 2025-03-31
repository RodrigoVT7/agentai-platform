// src/functions/conversation/ConversationSearch.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ConversationSearchHandler } from "../../shared/handlers/conversation/conversationSearchHandler";
import { ConversationSearchValidator, ConversationSearchParams } from "../../shared/validators/conversation/conversationSearchValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function ConversationSearch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Obtener datos de búsqueda con tipado explícito
    const searchData = await request.json() as ConversationSearchParams;
    
    // Validar datos
    const validator = new ConversationSearchValidator(logger);
    const validationResult = await validator.validate(searchData);
    
    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }
    
    // Realizar búsqueda
    const handler = new ConversationSearchHandler(logger);
    const result = await handler.execute(searchData, userId);
    
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al buscar conversaciones:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('ConversationSearch', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'conversation/search',
  handler: ConversationSearch
});