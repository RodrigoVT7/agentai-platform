// src/functions/auth/UserRegister.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { UserRegisterHandler } from "../../shared/handlers/auth/userRegisterHandler";
import { UserRegisterValidator } from "../../shared/validators/auth/userRegisterValidator";

export async function UserRegister(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    context.log.error("Error en registro de usuario:", error);
    
    return {
      status: error.statusCode || 500,
      jsonBody: { error: error.message || "Error interno del servidor" }
    };
  }
}

app.http('UserRegister', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/register',
  handler: UserRegister
});