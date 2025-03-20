// src/shared/handlers/auth/otpGeneratorHandler.ts
import { StorageService } from "../../services/storage.service";
import { NotificationService } from "../../services/notification.service";
import crypto from "crypto";
import { STORAGE_TABLES, AUTH_CONFIG } from "../../constants";

export class OtpGeneratorHandler {
  private storageService: StorageService;
  private notificationService: NotificationService;
  
  constructor() {
    this.storageService = new StorageService();
    this.notificationService = new NotificationService();
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
        await tableClient.updateEntity({
          ...previousOtp,
          used: true
        }, "Merge");
      }
      
      // Enviar OTP por email
      const emailTemplate = type === 'registration' ? 'welcome-otp' : 'login-otp';
      await this.notificationService.sendOtpEmail(email, otp, expiresAt, emailTemplate);
    } catch (error) {
      console.error(`Error al generar OTP para ${email}:`, error);
      throw error;
    }
  }
  
  private generateRandomOtp(): string {
    // Generar OTP de 6 dígitos
    return crypto.randomInt(100000, 999999).toString();
  }
}