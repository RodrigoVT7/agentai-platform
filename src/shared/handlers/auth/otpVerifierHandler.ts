// src/shared/handlers/auth/otpVerifierHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { JwtService } from "../../utils/jwt.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";

export class OtpVerifierHandler {
  private storageService: StorageService;
  private jwtService: JwtService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.jwtService = new JwtService();
    this.logger = logger || createLogger();
  }
  
  async execute(data: any): Promise<any> {
    const { email, otp } = data;
    
    try {
      // Buscar OTP válido para este email
      const otpTableClient = this.storageService.getTableClient(STORAGE_TABLES.OTP_CODES);
      
      const otpEntities = await otpTableClient.listEntities({
        queryOptions: { filter: `partitionKey eq '${email}' and used eq false and expiresAt gt ${Date.now()}` }
      });
      
      let validOtp: any = null;
      
      for await (const entity of otpEntities) {
        if (entity.otp === otp) {
          validOtp = entity;
          break;
        }
      }
      
      if (!validOtp) {
        throw createAppError(401, 'Código OTP inválido o expirado');
      }
      
      // Marcar OTP como usado
      // Asegurarnos de que partitionKey y rowKey estén definidos
      if (validOtp.partitionKey && validOtp.rowKey) {
        await otpTableClient.updateEntity({
          partitionKey: validOtp.partitionKey,
          rowKey: validOtp.rowKey,
          used: true
        }, "Merge");
      }
      
      // Obtener información del usuario
      const userId = validOtp.userId as string; // Asegurarnos de que es string
      if (!userId) {
        throw createAppError(500, 'Error en datos de OTP: userId no encontrado');
      }
      
      const userTableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      const user = await userTableClient.getEntity('user', userId);
      
      if (!user || !user.isActive) {
        throw createAppError(403, 'Usuario inactivo o no encontrado');
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
    } catch (error: any) {
      this.logger.error('Error al verificar OTP:', error);
      
      if ('statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al verificar OTP');
    }
  }
}