// src/shared/handlers/auth/userProfileHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";

export class UserProfileHandler {
  private storageService: StorageService;
  
  constructor() {
    this.storageService = new StorageService();
  }
  
  async getProfile(userId: string): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      
      // Obtener perfil de usuario
      const user = await tableClient.getEntity('user', userId);
      
      if (!user.isActive) {
        throw { statusCode: 403, message: 'Usuario inactivo' };
      }
      
      // Filtrar campos sensibles
      const { passwordHash, ...profileData } = user;
      
      return profileData;
    } catch (error) {
      console.error('Error al obtener perfil:', error);
      if (error.statusCode) {
        throw error;
      }
      
      if (error.statusCode === 404) {
        throw { statusCode: 404, message: 'Perfil no encontrado' };
      }
      
      throw { statusCode: 500, message: 'Error al obtener perfil' };
    }
  }
  
  async updateProfile(userId: string, profileData: any): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      
      // Verificar que el usuario existe
      const existingUser = await tableClient.getEntity('user', userId);
      
      if (!existingUser.isActive) {
        throw { statusCode: 403, message: 'Usuario inactivo' };
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
    } catch (error) {
      console.error('Error al actualizar perfil:', error);
      if (error.statusCode) {
        throw error;
      }
      
      if (error.statusCode === 404) {
        throw { statusCode: 404, message: 'Perfil no encontrado' };
      }
      
      throw { statusCode: 500, message: 'Error al actualizar perfil' };
    }
  }
}