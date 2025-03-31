// src/functions/agents/AgentCreate.ts (corregido)
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AgentCreateHandler } from "../../shared/handlers/agents/agentCreateHandler";
import { AgentCreateValidator } from "../../shared/validators/agents/agentCreateValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function AgentCreate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Obtener datos del cuerpo
    const agentData = await request.json() as Record<string, any>;
    
    // Agregar userId a los datos
    agentData.userId = userId;
    
    // Validar datos
    const validator = new AgentCreateValidator(logger);
    const validationResult = await validator.validate(agentData);
    
    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }
    
    // Crear agente
    const handler = new AgentCreateHandler(logger);
    const result = await handler.execute(agentData);
    
    return {
      status: 201,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error en creación de agente:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('AgentCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agents',
  handler: AgentCreate
});