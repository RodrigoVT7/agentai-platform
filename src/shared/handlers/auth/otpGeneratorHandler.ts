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
      this.logger.info(`Generando OTP para email: ${email}, userId: ${userId}, tipo: ${type}`);
      
      // Verificar que la tabla existe
      this.logger.info(`Verificando que la tabla ${STORAGE_TABLES.OTP_CODES} existe`);
      
      // Generar OTP (6 dígitos)
      const otp = this.generateRandomOtp();
      const now = Date.now();
      const expiresAt = now + AUTH_CONFIG.OTP_EXPIRES_IN;
      
      this.logger.info(`OTP generado: ${otp}, tiempo actual: ${now}, expira en: ${expiresAt} (${new Date(expiresAt).toISOString()})`);
      
      // Guardar OTP en tabla
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.OTP_CODES);
      const otpId = `${userId}_${now}`;
      
      this.logger.info(`Guardando OTP en tabla: ${STORAGE_TABLES.OTP_CODES}`);
      this.logger.info(`Datos del OTP - partitionKey: "${email}", rowKey: "${otpId}", otp: "${otp}", expiresAt: ${expiresAt}`);
      
      // Creamos la entidad con datos explícitos para asegurar el formato correcto
      const otpEntity = {
        partitionKey: email,
        rowKey: otpId,
        userId: userId,
        otp: otp,
        type: type,
        createdAt: now,
        expiresAt: expiresAt,
        used: false
      };
      
      await tableClient.createEntity(otpEntity);
      
      // Verificar que se guardó correctamente
      try {
        this.logger.info(`Verificando que el OTP se guardó correctamente`);
        const savedEntity = await tableClient.getEntity(email, otpId);
        this.logger.info(`OTP verificado en base de datos: ${JSON.stringify(savedEntity)}`);
      } catch (verifyError) {
        this.logger.error(`Error al verificar OTP guardado: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`);
      }
      
      // Invalidar OTPs anteriores para este usuario
      this.logger.info(`Invalidando OTPs anteriores para: ${email}`);
      const previousOtps = await tableClient.listEntities({
        queryOptions: { filter: `partitionKey eq '${email}' and rowKey ne '${otpId}' and used eq false` }
      });
      
      for await (const previousOtp of previousOtps) {
        // Asegurarnos de que partitionKey y rowKey estén definidos
        if (previousOtp.partitionKey && previousOtp.rowKey) {
          this.logger.info(`Invalidando OTP anterior: ${previousOtp.rowKey}`);
          await tableClient.updateEntity({
            partitionKey: previousOtp.partitionKey,
            rowKey: previousOtp.rowKey,
            used: true
          }, "Merge");
        }
      }
      
      // Enviar OTP por email
      const emailTemplate = type === 'registration' ? 'welcome-otp' : 'login-otp';
      this.logger.info(`Enviando OTP por email usando plantilla: ${emailTemplate}`);
      await this.notificationService.sendOtpEmail(email, otp, expiresAt, emailTemplate);
      
      this.logger.info(`Proceso de generación de OTP completado exitosamente`);
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