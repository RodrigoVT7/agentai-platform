// src/shared/handlers/auth/tokenRefreshHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { JwtService } from "../../utils/jwt.service";
import { STORAGE_TABLES } from "../../constants";

export class TokenRefreshHandler {
  private storageService: StorageService;
  private jwtService: JwtService;
  
  constructor() {
    this.storageService = new StorageService();
    this.jwtService = new JwtService();
  }
  
  async execute(data: any): Promise<any> {
    const { refreshToken, ip } = data;
    
    try {
      // Validar token actual (incluso si está expirado)
      let payload: any;
      
      try {
        // Intentar verificar normalmente
        payload = this.jwtService.verifyToken(refreshToken);
      } catch (error) {
        // Si el error es de expiración, extraer el payload de todos modos
        if (error.name === 'TokenExpiredError') {
          payload = this.jwtService.decodeToken(refreshToken);
        } else {
          throw { statusCode: 401, message: 'Token inválido' };
        }
      }
      
      if (!payload || !payload.userId || !payload.sessionId) {
        throw { statusCode: 401, message: 'Token inválido o corrupto' };
      }
      
      const { userId, sessionId } = payload;
      
      // Verificar sesión
      const sessionTableClient = this.storageService.getTableClient(STORAGE_TABLES.SESSIONS);
      
      try {
        const session = await sessionTableClient.getEntity(userId, sessionId);
        
        if (!session.isActive) {
          throw { statusCode: 401, message: 'Sesión inactiva' };
        }
        
        // Verificar fecha de expiración
        if (session.expiresAt < Date.now()) {
          throw { statusCode: 401, message: 'Sesión expirada' };
        }
      } catch (error) {
        if (error.statusCode) throw error;
        throw { statusCode: 401, message: 'Sesión no encontrada' };
      }
      
      // Verificar usuario
      const userTableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      
      try {
        const user = await userTableClient.getEntity('user', userId);
        
        if (!user.isActive) {
          throw { statusCode: 403, message: 'Usuario inactivo' };
        }
        
        // Actualizar último login
        await userTableClient.updateEntity({
          partitionKey: 'user',
          rowKey: userId,
          lastLogin: Date.now()
        }, "Merge");
        
        // Generar nuevo token JWT
        const newToken = this.jwtService.generateToken({
          userId,
          email: user.email,
          sessionId
        });
        
        // Opcionalmente, renovar la sesión
        await sessionTableClient.updateEntity({
          partitionKey: userId,
          rowKey: sessionId,
          expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 días
          ipAddress: ip || session.ipAddress
        }, "Merge");
        
        // Devolver respuesta
        return {
          userId,
          email: user.email,
          firstName: user.firstName,
          token: newToken,
          expiresIn: 3600 // 1 hora en segundos
        };
      } catch (error) {
        if (error.statusCode) throw error;
        throw { statusCode: 404, message: 'Usuario no encontrado' };
      }
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }
      console.error('Error al refrescar token:', error);
      throw { statusCode: 500, message: 'Error al refrescar token' };
    }
  }
}