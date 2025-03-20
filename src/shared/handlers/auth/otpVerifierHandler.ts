// src/shared/handlers/auth/otpVerifierHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { JwtService } from "../../utils/jwt.service";
import { STORAGE_TABLES } from "../../constants";

export class OtpVerifierHandler {
  private storageService: StorageService;
  private jwtService: JwtService;
  
  constructor() {
    this.storageService = new StorageService();
    this.jwtService = new JwtService();
  }
  
  async execute(data: any): Promise<any> {
    const { email, otp } = data;
    
    try {
      // Buscar OTP válido para este email
      const otpTableClient = this.storageService.getTableClient(STORAGE_TABLES.OTP_CODES);
      
      const otpEntities = await otpTableClient.listEntities({
        queryOptions: { filter: `partitionKey eq '${email}' and used eq false and expiresAt gt ${Date.now()}` }
      });
      
      let validOtp = null;
      
      for await (const entity of otpEntities) {
        if (entity.otp === otp) {
          validOtp = entity;
          break;
        }
      }
      
      if (!validOtp) {
        throw { statusCode: 401, message: 'Código OTP inválido o expirado' };
      }
      
      // Marcar OTP como usado
      await otpTableClient.updateEntity({
        ...validOtp,
        used: true
      }, "Merge");
      
      // Obtener información del usuario
      const userId = validOtp.userId;
      const userTableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      const user = await userTableClient.getEntity('user', userId);
      
      if (!user || !user.isActive) {
        throw { statusCode: 403, message: 'Usuario inactivo o no encontrado' };
      }
      
      // Actualizar último login
      await userTableClient.updateEntity({
        partitionKey: 'user',
        rowKey: userId,
        lastLogin: Date.now()
      }, "Merge");
      
      // Crear sesión
      const sessionId = uuidv4();
      const sessionTableClient = this.storageService.getTableClient(STORAGE_TABLES.SESSIONS);
      
      const ipAddress = data.ip || null;
      
      await sessionTableClient.createEntity({
        partitionKey: userId,
        rowKey: sessionId,
        userId: userId,
        token: sessionId,
        ipAddress: ipAddress,
        expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 días
        isActive: true
      });
      
      // Generar token JWT
      const token = this.jwtService.generateToken({
        userId: userId,
        email: email,
        sessionId
      });
      
      // Devolver respuesta
      return {
        userId: userId,
        email: email,
        firstName: user.firstName,
        token,
        expiresIn: 3600 // 1 hora en segundos
      };
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }
      console.error('Error al verificar OTP:', error);
      throw { statusCode: 500, message: 'Error al verificar OTP' };
    }
  }
}