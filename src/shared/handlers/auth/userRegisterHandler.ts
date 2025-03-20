// src/shared/handlers/auth/userRegisterHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { NotificationService } from "../../services/notification.service";
import { User } from "../../models/user.model";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";

export class UserRegisterHandler {
  private storageService: StorageService;
  private notificationService: NotificationService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.notificationService = new NotificationService();
    this.logger = logger || createLogger();
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
          throw createAppError(409, 'El email ya está registrado');
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
    } catch (error: unknown) {
      this.logger.error('Error al registrar usuario:', error);
      
      // Re-lanzar el error si ya es un AppError
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al registrar usuario');
    }
  }
}