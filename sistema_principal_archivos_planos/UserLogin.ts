// src/functions/auth/UserLogin.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { UserLoginHandler } from "../../shared/handlers/auth/userLoginHandler";
import { UserLoginValidator } from "../../shared/validators/auth/userLoginValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";

export async function UserLogin(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // Crear un logger seguro
  const logger = createLogger(context);
  
  try {
    // Obtener los datos del cuerpo
    const userData = await request.json();
    
    // Validar entrada
    const validator = new UserLoginValidator();
    const validationResult = validator.validate(userData);
    
    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }
    
    // Procesar solicitud
    const handler = new UserLoginHandler();
    const result = await handler.execute(userData);
    
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error en login de usuario:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('UserLogin', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/login',
  handler: UserLogin
});