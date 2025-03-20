// src/shared/handlers/auth/userRegisterHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { NotificationService } from "../../services/notification.service";
import { User } from "../../models/user.model";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";

export class UserRegisterHandler {
  private storageService: StorageService;
  private notificationService: NotificationService;
  
  constructor() {
    this.storageService = new StorageService();
    this.notificationService = new NotificationService();
  }
  
  async execute(userData: any): Promise<any> {
    try {
      // Verificar si el usuario ya existe
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      
      const users = await tableClient.listEntities({
        queryOptions: { filter: `email eq '${userData.email}'` }
      });
      
      for await (const user of users) {
        if (user.email === userData.email) {
          throw { statusCode: 409, message: 'El email ya está registrado' };
        }
      }
      
      // Crear nuevo usuario
      const userId = uuidv4();
      const newUser: User = {
        id: userId,
        email: userData.email,
        firstName: userData.firstName || '',
        lastName: userData.lastName || '',
        registrationIp: userData.ip || null,
        googleId: userData.googleId || null,
        onboardingStatus: 'pending',
        createdAt: Date.now(),
        isActive: true
      };
      
      // Guardar en Table Storage
      await tableClient.createEntity({
        partitionKey: 'user',
        rowKey: userId,
        ...newUser
      });
      
      // Enviar mensaje de bienvenida
      await this.notificationService.sendWelcomeEmail(newUser.email, newUser.firstName);
      
      // Iniciar proceso OTP
      await this.notificationService.requestOtp(newUser.email, userId, 'registration');
      
      return {
        userId,
        email: newUser.email,
        firstName: newUser.firstName,
        message: "Usuario registrado correctamente. Se ha enviado un código de verificación a su email."
      };
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }
      console.error('Error al registrar usuario:', error);
      throw { statusCode: 500, message: 'Error al registrar usuario' };
    }
  }
}