// src/shared/handlers/auth/userLoginHandler.ts
import { StorageService } from "../../services/storage.service";
import { NotificationService } from "../../services/notification.service";
import { STORAGE_TABLES } from "../../constants";

export class UserLoginHandler {
  private storageService: StorageService;
  private notificationService: NotificationService;
  
  constructor() {
    this.storageService = new StorageService();
    this.notificationService = new NotificationService();
  }
  
  async execute(credentials: any): Promise<any> {
    const { email } = credentials;
    
    try {
      // Buscar usuario por email
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      
      const users = await tableClient.listEntities({
        queryOptions: { filter: `email eq '${email}'` }
      });
      
      let user = null;
      for await (const entity of users) {
        if (entity.email === email) {
          user = entity;
          break;
        }
      }
      
      if (!user) {
        throw { statusCode: 404, message: 'Usuario no encontrado' };
      }
      
      if (!user.isActive) {
        throw { statusCode: 403, message: 'Usuario inactivo' };
      }
      
      // Iniciar flujo OTP
      await this.notificationService.requestOtp(email, user.id, 'login');
      
      return {
        userId: user.id,
        email: user.email,
        message: 'Se ha enviado un código de verificación a su email.'
      };
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }
      console.error('Error al iniciar sesión:', error);
      throw { statusCode: 500, message: 'Error al iniciar sesión' };
    }
  }
}