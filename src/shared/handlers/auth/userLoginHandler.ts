// src/shared/handlers/auth/userLoginHandler.ts
import { StorageService } from "../../services/storage.service";
import { NotificationService } from "../../services/notification.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";

export class UserLoginHandler {
  private storageService: StorageService;
  private notificationService: NotificationService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.notificationService = new NotificationService();
    this.logger = logger || createLogger();
  }
  
  async execute(credentials: any): Promise<any> {
    const { email } = credentials;
    
    try {
      // Buscar usuario por email
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      
      const users = await tableClient.listEntities({
        queryOptions: { filter: `email eq '${email}'` }
      });
      
      let user: any = null;
      for await (const entity of users) {
        if (entity.email === email) {
          user = entity;
          break;
        }
      }
      
      if (!user) {
        throw createAppError(404, 'Usuario no encontrado');
      }
      
      if (!user.isActive) {
        throw createAppError(403, 'Usuario inactivo');
      }
      
      // Asegurar que user.id es un string
      const userId = user.id as string;
      if (!userId) {
        throw createAppError(500, 'Error: ID de usuario no disponible');
      }
      
      // Iniciar flujo OTP
      await this.notificationService.requestOtp(email, userId, 'login');
      
      return {
        userId: user.id,
        email: user.email,
        message: 'Se ha enviado un código de verificación a su email.'
      };
    } catch (error: unknown) {
      this.logger.error('Error al iniciar sesión:', error);
      
      // Re-lanzar el error si ya es un AppError
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al iniciar sesión');
    }
  }
}