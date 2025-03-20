// src/functions/auth/OtpGenerator.ts
import { app, InvocationContext } from "@azure/functions";
import { OtpGeneratorHandler } from "../../shared/handlers/auth/otpGeneratorHandler";

export async function OtpGenerator(queueItem: unknown, context: InvocationContext): Promise<void> {
  const otpRequest = queueItem as any;
  
  try {
    const handler = new OtpGeneratorHandler();
    await handler.execute(otpRequest);
    
    context.log(`OTP generado correctamente para ${otpRequest.email}`);
  } catch (error) {
    context.log.error(`Error al generar OTP para ${otpRequest.email}:`, error);
  }
}

app.storageQueue('OtpGenerator', {
  queueName: 'otp-queue',
  connection: 'AzureWebJobsStorage',
  handler: OtpGenerator
});