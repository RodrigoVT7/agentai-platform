// src/functions/auth/UserLogin.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { UserLoginHandler } from "../../shared/handlers/auth/userLoginHandler";
import { UserLoginValidator } from "../../shared/validators/auth/userLoginValidator";

export async function UserLogin(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    context.log.error("Error en login de usuario:", error);
    
    return {
      status: error.statusCode || 500,
      jsonBody: { error: error.message || "Error interno del servidor" }
    };
  }
}

app.http('UserLogin', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/login',
  handler: UserLogin
});