// src/shared/handlers/auth/tokenRefreshHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { JwtService } from "../../utils/jwt.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";

export class TokenRefreshHandler {
  private storageService: StorageService;
  private jwtService: JwtService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.jwtService = new JwtService();
    this.logger = logger || createLogger();
  }
  
  async execute(data: any): Promise<any> {
    const { refreshToken, ip } = data;
    
    try {
      // Validar token actual (incluso si está expirado)
      let payload: any;
      
      try {
        // Intentar verificar normalmente
        payload = this.jwtService.verifyToken(refreshToken);
      } catch (error: any) {
        // Si el error es de expiración, extraer el payload de todos modos
        if (error && error.name === 'TokenExpiredError') {
          payload = this.jwtService.decodeToken(refreshToken);
        } else {
          throw createAppError(401, 'Token inválido');
        }
      }
      
      if (!payload || !payload.userId || !payload.sessionId) {
        throw createAppError(401, 'Token inválido o corrupto');
      }
      
      const { userId, sessionId } = payload;
      
      // Verificar sesión
      const sessionTableClient = this.storageService.getTableClient(STORAGE_TABLES.SESSIONS);
      
      try {
        const session = await sessionTableClient.getEntity(userId, sessionId);
        
        if (!session.isActive) {
          throw createAppError(401, 'Sesión inactiva');
        }
        
        // Verificar fecha de expiración
        const expiresAt = session.expiresAt as number;
        if (expiresAt < Date.now()) {
          throw createAppError(401, 'Sesión expirada');
        }
      } catch (error: any) {
        if ('statusCode' in error) throw error;
        throw createAppError(401, 'Sesión no encontrada');
      }
      
      // Verificar usuario
      const userTableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      
      try {
        const user = await userTableClient.getEntity('user', userId);
        
        if (!user.isActive) {
          throw createAppError(403, 'Usuario inactivo');
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
        
        // Obtener datos de la sesión para el ipAddress
        const sessionData = await sessionTableClient.getEntity(userId, sessionId);
        
        // Opcionalmente, renovar la sesión
        await sessionTableClient.updateEntity({
          partitionKey: userId,
          rowKey: sessionId,
          expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 días
          ipAddress: ip || sessionData.ipAddress
        }, "Merge");
        
        // Devolver respuesta
        return {
          userId,
          email: user.email,
          firstName: user.firstName,
          token: newToken,
          expiresIn: 3600 // 1 hora en segundos
        };
      } catch (error: any) {
        if ('statusCode' in error) throw error;
        throw createAppError(404, 'Usuario no encontrado');
      }
    } catch (error: any) {
      this.logger.error('Error al refrescar token:', error);
      
      if ('statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al refrescar token');
    }
  }
}