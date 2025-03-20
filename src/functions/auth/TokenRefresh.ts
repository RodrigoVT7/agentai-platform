// src/functions/auth/TokenRefresh.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TokenRefreshHandler } from "../../shared/handlers/auth/tokenRefreshHandler";
import { TokenRefreshValidator } from "../../shared/validators/auth/tokenRefreshValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";

export async function TokenRefresh(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);
  
  try {
    // Obtener los datos del cuerpo
    const refreshData = await request.json();
    
    // Validar entrada
    const validator = new TokenRefreshValidator();
    const validationResult = validator.validate(refreshData);
    
    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }
    
    // Procesar solicitud
    const handler = new TokenRefreshHandler();
    const result = await handler.execute(refreshData);
    
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error en refreshToken:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('TokenRefresh', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/refresh',
  handler: TokenRefresh
});