// src/shared/handlers/auth/userProfileHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";

export class UserProfileHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async getProfile(userId: string): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      
      // Obtener perfil de usuario
      const user = await tableClient.getEntity('user', userId);
      
      if (!user.isActive) {
        throw createAppError(403, 'Usuario inactivo');
      }
      
      // Filtrar campos sensibles
      const { passwordHash, ...profileData } = user;
      
      return profileData;
    } catch (error: unknown) {
      this.logger.error('Error al obtener perfil:', error);
      
      // Re-lanzar el error si ya es un AppError
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      // Errores específicos de Azure Table Storage
      if (error instanceof Error) {
        const errorAny = error as any;
        if (errorAny.statusCode === 404 || errorAny.code === 'ResourceNotFound') {
          throw createAppError(404, 'Perfil no encontrado');
        }
      }
      
      throw createAppError(500, 'Error al obtener perfil');
    }
  }
  
  async updateProfile(userId: string, profileData: any): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      
      // Verificar que el usuario existe
      const existingUser = await tableClient.getEntity('user', userId);
      
      if (!existingUser.isActive) {
        throw createAppError(403, 'Usuario inactivo');
      }
      
      // Campos que no se pueden modificar
      const immutableFields = ['id', 'email', 'googleId', 'createdAt', 'lastLogin', 'isActive', 'onboardingStatus'];
      
      // Preparar datos de actualización
      const updateData: any = {
        partitionKey: 'user',
        rowKey: userId
      };
      
      // Añadir solo campos permitidos
      for (const [key, value] of Object.entries(profileData)) {
        if (!immutableFields.includes(key)) {
          updateData[key] = value;
        }
      }
      
      // Si no hay campos para actualizar, retornar perfil actual
      if (Object.keys(updateData).length <= 2) {  // Solo partitionKey y rowKey
        return await this.getProfile(userId);
      }
      
      // Actualizar perfil
      await tableClient.updateEntity(updateData, "Merge");
      
      // Obtener perfil actualizado
      return await this.getProfile(userId);
    } catch (error: unknown) {
      this.logger.error('Error al actualizar perfil:', error);
      
      // Re-lanzar el error si ya es un AppError
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      // Errores específicos de Azure Table Storage
      if (error instanceof Error) {
        const errorAny = error as any;
        if (errorAny.statusCode === 404 || errorAny.code === 'ResourceNotFound') {
          throw createAppError(404, 'Perfil no encontrado');
        }
      }
      
      throw createAppError(500, 'Error al actualizar perfil');
    }
  }
}