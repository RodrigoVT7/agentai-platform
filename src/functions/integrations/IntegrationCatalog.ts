// src/functions/integrations/IntegrationCatalog.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { IntegrationCatalogHandler } from "../../shared/handlers/integrations/integrationCatalogHandler";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function IntegrationCatalog(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Obtener parámetros de consulta
    const category = request.query.get('category') || undefined;
    const limit = parseInt(request.query.get('limit') || '50');
    const skip = parseInt(request.query.get('skip') || '0');
    
    // Crear handler
    const handler = new IntegrationCatalogHandler(logger);
    const result = await handler.execute(userId, { category, limit, skip });
    
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al obtener catálogo de integraciones:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('IntegrationCatalog', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/catalog',
  handler: IntegrationCatalog
});