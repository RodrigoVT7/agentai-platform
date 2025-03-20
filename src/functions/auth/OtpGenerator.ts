// src/functions/auth/OtpGenerator.ts
import { app, InvocationContext } from "@azure/functions";
import { OtpGeneratorHandler } from "../../shared/handlers/auth/otpGeneratorHandler";
import { createLogger } from "../../shared/utils/logger";

export async function OtpGenerator(queueItem: unknown, context: InvocationContext): Promise<void> {
  const otpRequest = queueItem as any;
  const logger = createLogger(context);
  
  try {
    const handler = new OtpGeneratorHandler();
    await handler.execute(otpRequest);
    
    logger.info(`OTP generado correctamente para ${otpRequest.email}`);
  } catch (error) {
    logger.error(`Error al generar OTP para ${otpRequest.email}:`, error);
  }
}

app.storageQueue('OtpGenerator', {
  queueName: 'otp-queue',
  connection: 'AzureWebJobsStorage',
  handler: OtpGenerator
});