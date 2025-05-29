// src/functions/handoff/HandoffInitiator.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HandoffInitiatorHandler } from "../../shared/handlers/handoff/handoffInitiatorHandler";
import { HandoffInitiatorValidator } from "../../shared/validators/handoff/handoffInitiatorValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { HandoffInitiateRequest } from "../../shared/models/handoff.model"; // Importar el tipo

export async function HandoffInitiator(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);

  try {
    // Verificar autenticación (el token puede ser del usuario final o del bot/sistema)
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        status: 401,
        jsonBody: { error: "Se requiere autenticación" }
      };
    }

    const token = authHeader.split(' ')[1];
    const jwtService = new JwtService();

    let payload;
    try {
      payload = jwtService.verifyToken(token);
      // Podrías querer verificar si el token pertenece a un usuario o a un servicio/bot
    } catch (error) {
      return {
        status: 401,
        jsonBody: { error: "Token inválido o expirado" }
      };
    }

    const requestorId = payload.userId || payload.serviceId; // O la clave que uses
    if (!requestorId) {
      return {
        status: 401,
        jsonBody: { error: "Token no contiene identificador válido" }
      };
    }

    // Obtener datos del cuerpo y ASIGNAR TIPO CORRECTO
    const handoffData = await request.json() as HandoffInitiateRequest;

    // Validar datos
    const validator = new HandoffInitiatorValidator(logger);
    // CORRECCIÓN: Pasar el objeto con el tipo correcto
    const validationResult = await validator.validate(handoffData, requestorId);

    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }

    // Iniciar handoff
    const handler = new HandoffInitiatorHandler(logger);
    // CORRECCIÓN: Pasar el objeto con el tipo correcto
    const result = await handler.execute(handoffData, requestorId); // Pasamos el ID del solicitante

    return {
      status: 201, // O 202 si es asíncrono
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al iniciar handoff:", error);
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('HandoffInitiator', {
  methods: ['POST'],
  authLevel: 'anonymous', // La autenticación se maneja manualmente vía JWT
  route: 'handoff/initiate',
  handler: HandoffInitiator
});