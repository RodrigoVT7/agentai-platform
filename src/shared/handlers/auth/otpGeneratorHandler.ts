// src/shared/handlers/auth/otpGeneratorHandler.ts
import { StorageService } from "../../services/storage.service";
import { NotificationService } from "../../services/notification.service";
import crypto from "crypto";
import { STORAGE_TABLES, AUTH_CONFIG } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";

export class OtpGeneratorHandler {
  private storageService: StorageService;
  private notificationService: NotificationService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.notificationService = new NotificationService();
    this.logger = logger || createLogger();
  }
  
  async execute(otpRequest: any): Promise<void> {
    const { email, userId, type } = otpRequest;
    
    try {
      // Generar OTP (6 dígitos)
      const otp = this.generateRandomOtp();
      const expiresAt = Date.now() + AUTH_CONFIG.OTP_EXPIRES_IN;
      
      // Guardar OTP en tabla
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.OTP_CODES);
      const otpId = `${userId}_${Date.now()}`;
      
      await tableClient.createEntity({
        partitionKey: email,
        rowKey: otpId,
        userId,
        otp,
        type,
        createdAt: Date.now(),
        expiresAt,
        used: false
      });
      
      // Invalidar OTPs anteriores para este usuario
      const previousOtps = await tableClient.listEntities({
        queryOptions: { filter: `partitionKey eq '${email}' and rowKey ne '${otpId}' and used eq false` }
      });
      
      for await (const previousOtp of previousOtps) {
        // Asegurarnos de que partitionKey y rowKey estén definidos
        if (previousOtp.partitionKey && previousOtp.rowKey) {
          await tableClient.updateEntity({
            partitionKey: previousOtp.partitionKey,
            rowKey: previousOtp.rowKey,
            used: true
          }, "Merge");
        }
      }
      
      // Enviar OTP por email
      const emailTemplate = type === 'registration' ? 'welcome-otp' : 'login-otp';
      await this.notificationService.sendOtpEmail(email, otp, expiresAt, emailTemplate);
    } catch (error: any) {
      this.logger.error(`Error al generar OTP para ${email}:`, error);
      throw createAppError(500, `Error al generar OTP para ${email}`);
    }
  }
  
  private generateRandomOtp(): string {
    // Generar OTP de 6 dígitos
    return crypto.randomInt(100000, 999999).toString();
  }
}