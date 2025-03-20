// src/functions/auth/GoogleAuth.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { GoogleAuthHandler } from "../../shared/handlers/auth/googleAuthHandler";
import { GoogleAuthValidator } from "../../shared/validators/auth/googleAuthValidator";

export async function GoogleAuth(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    // Obtener los datos del cuerpo
    const authData = await request.json();
    
    // Validar entrada
    const validator = new GoogleAuthValidator();
    const validationResult = validator.validate(authData);
    
    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }
    
    // Procesar solicitud
    const handler = new GoogleAuthHandler();
    const result = await handler.execute(authData);
    
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    context.log.error("Error en autenticación con Google:", error);
    
    return {
      status: error.statusCode || 500,
      jsonBody: { error: error.message || "Error interno del servidor" }
    };
  }
}

app.http('GoogleAuth', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'auth/google',
  handler: GoogleAuth
});