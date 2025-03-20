// src/functions/auth/TokenRefresh.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TokenRefreshHandler } from "../../shared/handlers/auth/tokenRefreshHandler";
import { TokenRefreshValidator } from "../../shared/validators/auth/tokenRefreshValidator";

export async function TokenRefresh(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    context.log.error("Error en refreshToken:", error);
    
    return {
      status: error.statusCode || 500,
      jsonBody: { error: error.message || "Error interno del servidor" }
    };
  }
}

app.http('TokenRefresh', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/refresh',
  handler: TokenRefresh
});