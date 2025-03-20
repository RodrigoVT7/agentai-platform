// src/functions/auth/UserRegister.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { UserRegisterHandler } from "../../shared/handlers/auth/userRegisterHandler";
import { UserRegisterValidator } from "../../shared/validators/auth/userRegisterValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";

export async function UserRegister(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);
  
  try {
    // Obtener los datos del cuerpo
    const userData = await request.json();
    
    // Validar entrada
    const validator = new UserRegisterValidator();
    const validationResult = validator.validate(userData);
    
    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }
    
    // Procesar solicitud
    const handler = new UserRegisterHandler();
    const result = await handler.execute(userData);
    
    return {
      status: 201,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error en registro de usuario:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('UserRegister', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/register',
  handler: UserRegister
});