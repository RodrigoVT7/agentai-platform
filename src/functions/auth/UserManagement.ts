// src/functions/auth/UserManagement.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { UserProfileHandler } from "../../shared/handlers/auth/userProfileHandler";
import { UserProfileUpdateValidator } from "../../shared/validators/auth/userProfileUpdateValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function UserManagement(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Crear handler de perfil
    const handler = new UserProfileHandler(logger);
    
    // Manejar según el método HTTP
    if (request.method === 'GET') {
      // Obtener perfil
      const profileData = await handler.getProfile(userId);
      
      return {
        status: 200,
        jsonBody: profileData
      };
    } else if (request.method === 'PUT') {
      // Actualizar perfil
      const updateData = await request.json();
      
      // Validar datos de actualización
      const validator = new UserProfileUpdateValidator();
      const validationResult = validator.validate(updateData);
      
      if (!validationResult.isValid) {
        return {
          status: 400,
          jsonBody: { error: "Datos inválidos", details: validationResult.errors }
        };
      }
      
      // Procesar actualización
      const updatedProfile = await handler.updateProfile(userId, updateData);
      
      return {
        status: 200,
        jsonBody: updatedProfile
      };
    } else {
      return {
        status: 405,
        jsonBody: { error: "Método no permitido" }
      };
    }
  } catch (error) {
    logger.error("Error en gestión de perfil de usuario:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('UserManagement', {
  methods: ['GET', 'PUT'],
  authLevel: 'anonymous',
  route: 'auth/profile',
  handler: UserManagement
});